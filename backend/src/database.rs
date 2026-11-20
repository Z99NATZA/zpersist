mod selection;

use crate::{ApiError, AppState, ErrorCode, setting};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use axum_extra::extract::cookie::CookieJar;
use deadpool::Runtime;
use deadpool::managed::{Manager, Metrics, Object, Pool, PoolError, RecycleResult};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    error::Error,
    fmt::Write,
    io::ErrorKind,
    net::SocketAddr,
    time::{Duration, Instant},
};
use tiberius::{
    AuthMethod, Client, ColumnData, Config, EncryptionLevel, FromSqlOwned, QueryItem,
    time::chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime},
};
use tokio::{net::TcpStream, time::timeout};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};
use zeroize::Zeroizing;

const DEFAULT_DATABASE: &str = "master";
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const ROW_LIMIT: usize = 500;
const CELL_BYTES: usize = 4 * 1024;
const BATCH_BYTES: usize = 8 * 1024 * 1024;
const DATABASES_SQL: &str = "SELECT [name] FROM [master].[sys].[databases]     WHERE [state] = 0 AND HAS_DBACCESS([name]) = 1 ORDER BY [name]";

type SqlClient = Client<Compat<TcpStream>>;
type SqlError = tiberius::error::Error;

#[derive(Clone)]
pub struct DatabaseServer {
    config: Config,
    default_trust_server_certificate: bool,
}

#[derive(Clone)]
pub struct Database(Pool<SqlServer>);

struct SqlServer {
    address: SocketAddr,
    config: Config,
}

impl Manager for SqlServer {
    type Type = SqlClient;
    type Error = SqlError;

    async fn create(&self) -> Result<SqlClient, SqlError> {
        let stream = TcpStream::connect(self.address).await?;
        stream.set_nodelay(true)?;
        Client::connect(self.config.clone(), stream.compat_write()).await
    }

    async fn recycle(&self, _: &mut SqlClient, _: &Metrics) -> RecycleResult<SqlError> {
        Ok(())
    }
}

struct Lease {
    connection: Option<Object<SqlServer>>,
    reusable: bool,
}

impl Drop for Lease {
    fn drop(&mut self) {
        if !self.reusable
            && let Some(connection) = self.connection.take()
        {
            drop(Object::take(connection));
        }
    }
}

impl DatabaseServer {
    pub fn new() -> Result<Self, Box<dyn Error>> {
        let mut config = Config::new();
        config.database(DEFAULT_DATABASE);
        config.application_name("zpersist");
        config.encryption(EncryptionLevel::Required);
        Ok(Self {
            config,
            default_trust_server_certificate: setting("MSSQL_TRUST_CERT", false)?,
        })
    }

    pub async fn connect(
        &self,
        address: SocketAddr,
        username: &str,
        password: Zeroizing<String>,
        trust_server_certificate: Option<bool>,
    ) -> Result<Database, ApiError> {
        let mut config = self.config.clone();
        config.host(address.ip().to_string());
        config.port(address.port());
        if trust_server_certificate.unwrap_or(self.default_trust_server_certificate) {
            config.trust_cert();
        }
        config.authentication(AuthMethod::sql_server(username, password.as_str()));
        drop(password);
        let pool = Pool::builder(SqlServer { address, config })
            .runtime(Runtime::Tokio1)
            .max_size(8)
            .wait_timeout(Some(Duration::from_secs(10)))
            .create_timeout(Some(Duration::from_secs(10)))
            .build()
            .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, ErrorCode::Internal))?;
        let connection = pool
            .get()
            .await
            .map_err(|error| sign_in_error(address, error))?;
        drop(connection);
        Ok(Database(pool))
    }
}

fn sign_in_error(address: SocketAddr, error: PoolError<SqlError>) -> ApiError {
    if let PoolError::Backend(error) = &error {
        match error.code() {
            Some(18452 | 18456) => {
                return ApiError::new(StatusCode::UNAUTHORIZED, ErrorCode::InvalidCredentials);
            }
            Some(18487 | 18488) => {
                return ApiError::new(StatusCode::UNAUTHORIZED, ErrorCode::PasswordChangeRequired);
            }
            Some(4060) => return ApiError::bad_request(ErrorCode::DatabaseUnavailable),
            _ => {}
        }
    }
    eprintln!("SQL Server sign-in at {address}: {error}");
    let code = match &error {
        PoolError::Backend(SqlError::Tls(reason)) => tls_error_code(reason),
        PoolError::Timeout(_)
        | PoolError::Backend(SqlError::Io {
            kind: ErrorKind::TimedOut,
            ..
        }) => ErrorCode::ConnectionTimeout,
        PoolError::Backend(SqlError::Io {
            kind: ErrorKind::ConnectionRefused,
            ..
        }) => ErrorCode::ConnectionRefused,
        _ => ErrorCode::ConnectionFailed,
    };
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, code).with_params(json!({ "server": address }))
}

fn tls_error_code(reason: &str) -> ErrorCode {
    // Tiberius exposes the certificate reason in the TLS error text.
    if !reason.starts_with("the server's certificate was rejected") {
        return ErrorCode::SecureConnectionFailed;
    }
    if reason.contains("UnknownIssuer") {
        ErrorCode::CertificateUntrusted
    } else if reason.contains("NotValidForName") || reason.contains("not valid for") {
        ErrorCode::CertificateAddressMismatch
    } else if reason.contains("Expired") || reason.contains("has expired") {
        ErrorCode::CertificateExpired
    } else {
        ErrorCode::CertificateInvalid
    }
}

impl Database {
    pub fn close(&self) {
        self.0.close();
    }

    async fn run<T>(
        &self,
        operation: impl for<'a> AsyncFnOnce(&'a mut SqlClient) -> Result<T, SqlError>,
    ) -> Result<T, ApiError> {
        let connection = self.0.get().await.map_err(|error| {
            eprintln!("SQL Server pool: {error}");
            ApiError::new(StatusCode::SERVICE_UNAVAILABLE, ErrorCode::ConnectionLost)
        })?;
        let mut lease = Lease {
            connection: Some(connection),
            reusable: false,
        };
        let result = timeout(
            QUERY_TIMEOUT,
            operation(lease.connection.as_deref_mut().unwrap()),
        )
        .await;
        match result {
            Ok(Ok(value)) => {
                lease.reusable = true;
                Ok(value)
            }
            Ok(Err(SqlError::Server(error))) => {
                let code = match error.code() {
                    102 | 105 | 156 | 170 => ErrorCode::SqlInvalid,
                    207 => ErrorCode::ColumnNotFound,
                    208 => ErrorCode::TableNotFound,
                    229 | 230 | 297 => ErrorCode::PermissionDenied,
                    911 | 916 | 4060 => ErrorCode::DatabaseUnavailable,
                    _ => ErrorCode::QueryFailed,
                };
                Err(ApiError::bad_request(code).with_detail(error.message()))
            }
            Ok(Err(error)) => {
                eprintln!("SQL Server query: {error}");
                Err(ApiError::new(
                    StatusCode::BAD_GATEWAY,
                    ErrorCode::ConnectionLost,
                ))
            }
            Err(_) => Err(
                ApiError::new(StatusCode::GATEWAY_TIMEOUT, ErrorCode::QueryTimeout)
                    .with_params(json!({ "seconds": QUERY_TIMEOUT.as_secs() })),
            ),
        }
    }
}

pub async fn list(
    State(state): State<AppState>,
    cookies: CookieJar,
) -> Result<Json<Vec<String>>, ApiError> {
    let session = state.auth.require(&cookies)?;
    session
        .database
        .run(async |client| {
            let rows = client
                .simple_query(DATABASES_SQL)
                .await?
                .into_first_result()
                .await?;
            rows.into_iter()
                .map(|row| {
                    row.try_get::<&str, _>(0)
                        .map(|value| value.unwrap_or_default().to_owned())
                })
                .collect()
        })
        .await
        .map(Json)
}

fn database_identifier(database: &str) -> Result<String, ApiError> {
    if database.is_empty() || database.encode_utf16().count() > 128 || database.contains('\0') {
        return Err(ApiError::bad_request(ErrorCode::InvalidDatabase));
    }
    Ok(format!("[{}]", database.replace(']', "]]")))
}

#[derive(Deserialize)]
pub struct TableListParams {
    #[serde(default)]
    database: String,
}

#[derive(Serialize)]
pub struct DatabaseTable {
    schema: String,
    name: String,
}

pub async fn list_tables(
    State(state): State<AppState>,
    cookies: CookieJar,
    Query(params): Query<TableListParams>,
) -> Result<Json<Vec<DatabaseTable>>, ApiError> {
    let session = state.auth.require(&cookies)?;
    let database = database_identifier(&params.database)?;
    let sql = format!(
        "SELECT s.[name], t.[name] FROM {database}.[sys].[tables] AS t
         JOIN {database}.[sys].[schemas] AS s ON s.[schema_id] = t.[schema_id]
         WHERE t.[is_ms_shipped] = 0 ORDER BY s.[name], t.[name]"
    );
    session
        .database
        .run(async |client| {
            let rows = client.simple_query(sql).await?.into_first_result().await?;
            rows.into_iter()
                .map(|row| {
                    Ok(DatabaseTable {
                        schema: row.try_get::<&str, _>(0)?.unwrap_or_default().to_owned(),
                        name: row.try_get::<&str, _>(1)?.unwrap_or_default().to_owned(),
                    })
                })
                .collect()
        })
        .await
        .map(Json)
}

#[derive(Deserialize)]
pub struct QueryRequest {
    database: Option<String>,
    sql: String,
}

#[derive(Serialize)]
pub struct QueryResponse {
    results: Vec<ResultTable>,
    elapsed_ms: u64,
}

#[derive(Serialize)]
struct ResultTable {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    truncated: bool,
}

pub async fn query(
    State(state): State<AppState>,
    cookies: CookieJar,
    Json(request): Json<QueryRequest>,
) -> Result<Json<QueryResponse>, ApiError> {
    let session = state.auth.require(&cookies)?;
    let database = request
        .database
        .as_deref()
        .filter(|name| !name.is_empty())
        .unwrap_or(DEFAULT_DATABASE);
    let batch = selection::prepare(database, &request.sql)?;
    let started = Instant::now();
    let results = session
        .database
        .run(async |client| collect_results(client, &batch).await)
        .await?;
    Ok(Json(QueryResponse {
        results,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }))
}

async fn collect_results(
    client: &mut SqlClient,
    batch: &str,
) -> Result<Vec<ResultTable>, SqlError> {
    let mut stream = client.simple_query(batch).await?;
    let mut results: Vec<ResultTable> = Vec::new();
    let mut remaining = BATCH_BYTES;

    while let Some(item) = stream.try_next().await? {
        match item {
            QueryItem::Metadata(metadata) => results.push(ResultTable {
                columns: metadata
                    .columns()
                    .iter()
                    .map(|column| column.name().to_owned())
                    .collect(),
                rows: Vec::new(),
                truncated: false,
            }),
            QueryItem::Row(row) => {
                let result = &mut results[row.result_index()];
                if result.rows.len() == ROW_LIMIT || result.truncated {
                    result.truncated = true;
                    continue;
                }
                let cells: Vec<_> = row.into_iter().map(format_cell).collect::<Result<_, _>>()?;
                let row_bytes = cells
                    .iter()
                    .map(|cell| 8 + cell.as_ref().map_or(0, String::len))
                    .sum::<usize>();
                if row_bytes > remaining {
                    result.truncated = true;
                } else {
                    remaining -= row_bytes;
                    result.rows.push(cells);
                }
            }
        }
    }
    Ok(results)
}

fn display<T: ToString>(value: Option<T>) -> Option<String> {
    value.map(|value| value.to_string())
}

fn temporal<T: FromSqlOwned + ToString>(
    value: ColumnData<'static>,
) -> Result<Option<String>, SqlError> {
    Ok(display(T::from_sql_owned(value)?))
}

fn preview_text(text: &str) -> String {
    if text.len() <= CELL_BYTES {
        text.to_owned()
    } else {
        format!("{}…", &text[..text.floor_char_boundary(CELL_BYTES)])
    }
}

fn format_cell(value: ColumnData<'static>) -> Result<Option<String>, SqlError> {
    Ok(match value {
        ColumnData::U8(value) => display(value),
        ColumnData::I16(value) => display(value),
        ColumnData::I32(value) => display(value),
        ColumnData::I64(value) => display(value),
        ColumnData::F32(value) => display(value),
        ColumnData::F64(value) => display(value),
        ColumnData::Bit(value) => value.map(|value| u8::from(value).to_string()),
        ColumnData::Guid(value) => display(value),
        ColumnData::Numeric(value) => display(value),
        ColumnData::String(value) => value.as_deref().map(preview_text),
        ColumnData::Xml(value) => value.as_deref().map(|value| preview_text(value.as_ref())),
        ColumnData::Binary(value) => value.map(|value| {
            let mut output = String::from("0x");
            for byte in value.iter().take((CELL_BYTES - 2) / 2) {
                write!(output, "{byte:02X}").unwrap();
            }
            if value.len() > (CELL_BYTES - 2) / 2 {
                output.push('…');
            }
            output
        }),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            return temporal::<NaiveDateTime>(value);
        }
        ColumnData::Time(_) => return temporal::<NaiveTime>(value),
        ColumnData::Date(_) => return temporal::<NaiveDate>(value),
        ColumnData::DateTimeOffset(_) => return temporal::<DateTime<FixedOffset>>(value),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_certificate_problems_separate_from_connection_failures() {
        let rejected = "the server's certificate was rejected during the TLS handshake";
        assert!(matches!(
            tls_error_code(&format!("{rejected}: UnknownIssuer.")),
            ErrorCode::CertificateUntrusted
        ));
        assert!(matches!(
            tls_error_code(&format!("{rejected}: NotValidForNameContext.")),
            ErrorCode::CertificateAddressMismatch
        ));
        assert!(matches!(
            tls_error_code(&format!("{rejected}: ExpiredContext.")),
            ErrorCode::CertificateExpired
        ));
        assert!(matches!(
            tls_error_code(&format!("{rejected}: UnsupportedCertVersion.")),
            ErrorCode::CertificateInvalid
        ));
        assert!(matches!(
            tls_error_code("handshake ended early"),
            ErrorCode::SecureConnectionFailed
        ));
    }
}
