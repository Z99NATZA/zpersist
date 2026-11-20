mod auth;
mod database;

use auth::Auth;
use axum::{
    Json, Router,
    extract::Request,
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use database::DatabaseServer;
use serde::Serialize;
use serde_json::{Value, json};
use std::{env, error::Error, net::SocketAddr};
use tokio::net::TcpListener;
use tower_http::services::ServeDir;

#[derive(Clone)]
struct AppState {
    auth: Auth,
    server: DatabaseServer,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum ErrorCode {
    SignInRequired,
    InvalidServer,
    InvalidPort,
    MissingCredentials,
    InvalidCredentials,
    PasswordChangeRequired,
    DatabaseUnavailable,
    CertificateUntrusted,
    CertificateExpired,
    CertificateAddressMismatch,
    CertificateInvalid,
    SecureConnectionFailed,
    ConnectionRefused,
    ConnectionTimeout,
    ConnectionFailed,
    ConnectionLost,
    SqlTooLarge,
    SqlInvalid,
    ReadOnly,
    NoSelect,
    InvalidDatabase,
    TableNotFound,
    ColumnNotFound,
    PermissionDenied,
    QueryFailed,
    QueryTimeout,
    NotFound,
    Internal,
}

struct ApiError {
    status: StatusCode,
    code: ErrorCode,
    params: Value,
    detail: Option<String>,
}

impl ApiError {
    fn new(status: StatusCode, code: ErrorCode) -> Self {
        Self {
            status,
            code,
            params: Value::Null,
            detail: None,
        }
    }

    fn bad_request(code: ErrorCode) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code)
    }

    fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, ErrorCode::SignInRequired)
    }

    fn with_params(mut self, params: Value) -> Self {
        self.params = params;
        self
    }

    fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "code": self.code, "params": self.params, "detail": self.detail })),
        )
            .into_response()
    }
}

fn setting<T>(name: &str, default: T) -> Result<T, Box<dyn Error>>
where
    T: std::str::FromStr,
{
    match env::var(name) {
        Ok(value) => value.parse().map_err(|_| format!("Invalid {name}.").into()),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error.into()),
    }
}

async fn web_cache(mut request: Request, next: Next) -> Response {
    let is_index = matches!(request.uri().path(), "/" | "/index.html");
    if is_index {
        // Reusing an older Docker image can move the index's timestamp backwards.
        request.headers_mut().remove(header::IF_MODIFIED_SINCE);
    }

    let mut response = next.run(request).await;
    if is_index || response.status() == StatusCode::NOT_FOUND {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let state = AppState {
        server: DatabaseServer::new()?,
        auth: Auth::new(setting("APP_SECURE_COOKIE", false)?),
    };
    let api = Router::new()
        .route("/session", get(auth::session))
        .route("/login", post(auth::login))
        .route("/logout", post(auth::logout))
        .route("/databases", get(database::list))
        .route("/tables", get(database::list_tables))
        .route("/query", post(database::query))
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, ErrorCode::NotFound) })
        .layer(middleware::map_response(async |mut response: Response| {
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
            response
        }));
    let directory = env::var("STATIC_DIR").unwrap_or_else(|_| "frontend/dist".into());
    let app = Router::new()
        .fallback_service(ServeDir::new(directory))
        .layer(middleware::from_fn(web_cache))
        .nest("/api", api)
        .with_state(state);
    let address = env::var("APP_BIND").unwrap_or_else(|_| "0.0.0.0:8003".into());
    let listener = TcpListener::bind(address.parse::<SocketAddr>()?).await?;
    println!("zpersist listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}
