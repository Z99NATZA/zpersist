use crate::{ApiError, AppState, ErrorCode, database::Database};
use axum::{Json, extract::State, http::StatusCode};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fmt::Write,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use zeroize::Zeroizing;

const SESSION_COOKIE: &str = "zpersist_session";
const SESSION_DURATION: Duration = Duration::from_secs(8 * 60 * 60);
const DEFAULT_SQL_PORT: u16 = 1433;

#[derive(Clone)]
pub struct Auth(Arc<AuthState>);

struct AuthState {
    secure_cookie: bool,
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Clone)]
pub struct Session {
    server: SocketAddr,
    username: String,
    pub database: Database,
    expires: Instant,
}

#[derive(Serialize)]
pub struct SessionView {
    server: SocketAddr,
    username: String,
}

#[derive(Deserialize)]
pub struct Credentials {
    server: String,
    port: Option<u16>,
    username: String,
    password: String,
    trust_server_certificate: Option<bool>,
}

fn parse_server(value: &str, port: Option<u16>) -> Result<SocketAddr, ApiError> {
    let value = value.trim();
    if port == Some(0) {
        return Err(ApiError::bad_request(ErrorCode::InvalidPort));
    }
    if let Ok(ip) = value.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, port.unwrap_or(DEFAULT_SQL_PORT)));
    }
    if port.is_none()
        && let Ok(address) = value.parse::<SocketAddr>()
        && address.port() != 0
    {
        return Ok(address);
    }
    Err(ApiError::bad_request(ErrorCode::InvalidServer))
}

impl Auth {
    pub fn new(secure_cookie: bool) -> Self {
        let state = Arc::new(AuthState {
            secure_cookie,
            sessions: Mutex::default(),
        });
        let weak_state = Arc::downgrade(&state);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                let Some(state) = weak_state.upgrade() else {
                    break;
                };
                let now = Instant::now();
                state.sessions.lock().unwrap().retain(|_, session| {
                    if session.expires > now {
                        true
                    } else {
                        session.database.close();
                        false
                    }
                });
            }
        });
        Self(state)
    }

    pub fn require(&self, cookies: &CookieJar) -> Result<Session, ApiError> {
        let token = cookies
            .get(SESSION_COOKIE)
            .ok_or_else(ApiError::unauthorized)?;
        self.0
            .sessions
            .lock()
            .unwrap()
            .get(token.value())
            .filter(|session| session.expires > Instant::now())
            .cloned()
            .ok_or_else(ApiError::unauthorized)
    }

    fn clear(&self, cookies: &CookieJar) {
        if let Some(token) = cookies.get(SESSION_COOKIE)
            && let Some(session) = self.0.sessions.lock().unwrap().remove(token.value())
        {
            session.database.close();
        }
    }

    fn cookie(&self, token: String) -> Cookie<'static> {
        Cookie::build((SESSION_COOKIE, token))
            .path("/")
            .http_only(true)
            .same_site(SameSite::Strict)
            .secure(self.0.secure_cookie)
            .max_age(time::Duration::seconds(SESSION_DURATION.as_secs() as i64))
            .build()
    }
}

pub async fn session(
    State(state): State<AppState>,
    cookies: CookieJar,
) -> Result<Json<SessionView>, ApiError> {
    let session = state.auth.require(&cookies)?;
    Ok(Json(SessionView {
        server: session.server,
        username: session.username,
    }))
}

pub async fn login(
    State(state): State<AppState>,
    cookies: CookieJar,
    Json(Credentials {
        server,
        port,
        username,
        password,
        trust_server_certificate,
    }): Json<Credentials>,
) -> Result<(CookieJar, Json<SessionView>), ApiError> {
    let password = Zeroizing::new(password);
    let server = parse_server(&server, port)?;
    if username.trim().is_empty() || password.is_empty() {
        return Err(ApiError::bad_request(ErrorCode::MissingCredentials));
    }
    let database = state
        .server
        .connect(server, &username, password, trust_server_certificate)
        .await?;

    let mut random = [0_u8; 32];
    getrandom::fill(&mut random)
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, ErrorCode::Internal))?;
    let mut token = String::with_capacity(random.len() * 2);
    for byte in random {
        write!(token, "{byte:02x}").unwrap();
    }

    let auth = state.auth;
    auth.clear(&cookies);
    auth.0.sessions.lock().unwrap().insert(
        token.clone(),
        Session {
            server,
            username: username.clone(),
            database,
            expires: Instant::now() + SESSION_DURATION,
        },
    );

    Ok((
        cookies.add(auth.cookie(token)),
        Json(SessionView { server, username }),
    ))
}

pub async fn logout(State(state): State<AppState>, cookies: CookieJar) -> (CookieJar, StatusCode) {
    state.auth.clear(&cookies);
    (
        cookies.remove(state.auth.cookie(String::new())),
        StatusCode::NO_CONTENT,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ips_with_default_or_explicit_port() {
        for (input, port, expected) in [
            (" 192.0.2.24 ", None, "192.0.2.24:1433"),
            ("192.0.2.24", Some(11433), "192.0.2.24:11433"),
            ("192.0.2.24:11433", None, "192.0.2.24:11433"),
            ("2001:db8::1", None, "[2001:db8::1]:1433"),
            ("2001:db8::1", Some(11433), "[2001:db8::1]:11433"),
            ("[2001:db8::1]:11433", None, "[2001:db8::1]:11433"),
        ] {
            assert_eq!(
                parse_server(input, port).ok(),
                Some(expected.parse().unwrap())
            );
        }
    }

    #[test]
    fn rejects_invalid_endpoints() {
        for (value, port) in [
            ("", None),
            ("https://192.0.2.24", None),
            ("192.0.2.24:0", None),
            ("192.0.2.24:65536", None),
            ("192.0.2.24", Some(0)),
            ("192.0.2.24:11433", Some(1433)),
        ] {
            assert!(parse_server(value, port).is_err(), "{value:?}");
        }
    }
}
