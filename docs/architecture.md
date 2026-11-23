# zpersist architecture

[Documentation index](README.md)

## System overview

```text
Components
==========

zpersist packages a React and TypeScript frontend with a Rust backend.
Vite builds the frontend into static files. One Axum process serves those
files and the /api routes from the same origin.

Request flow
----------

Browser <--- HTTP ---> Axum <--- encrypted TDS ---> SQL Server

Axum uses Tiberius to connect to the SQL Server endpoint supplied at sign-in.
SQL Server runs outside the Compose stack.
```

[Router](../backend/src/main.rs) · [Dockerfile](../Dockerfile) · [Compose](../compose.yaml)

## Frontend and browser state

```text
Workspace lifecycle
==========

On load, App calls GET /api/session and opens the workspace when the session
is valid. The workspace loads the database list and fetches the table list
for the active tab's selected database.

Editor tabs
----------

Each tab tracks its own SQL, selected database, query status, and results.
A tab can have one query request in flight, and requests in different tabs
can run concurrently. Closing a tab or leaving the workspace aborts its
pending browser request.
```

| Storage | Contents | Lifetime |
|---|---|---|
| `localStorage` | UI language and sign-in history with up to 20 server endpoints and 20 usernames. The app keeps passwords out of browser storage. | Across reloads and browser sessions |
| `sessionStorage` | SQL drafts, selected database for each tab, and the active editor tab, keyed by the server address and username returned by the API. | Across reloads in the same browser tab |
| React state | Query results, visible result sets, errors, and current request status. The UI shows up to five result sets at once. | While the workspace is mounted |

[App](../frontend/src/App.tsx) · [Workspace](../frontend/src/Workspace.tsx) · [Login history](../frontend/src/loginHistory.ts) · [Editor tabs](../frontend/src/editorTabs.ts) · [Localization](../frontend/src/i18n.tsx)

## Sign-in and connection pooling

```text
Session lifecycle
==========

The backend accepts a literal IPv4 or IPv6 address and uses SQL Server
authentication. It opens a connection to master to verify the credentials
before issuing the random zpersist_session cookie. The cookie is HttpOnly
and SameSite=Strict, with Secure controlled by APP_SECURE_COOKIE.

Axum stores sessions in process memory. Each session expires eight hours
after sign-in. Restarting the process clears all sessions.

Connection pools
----------

Each session has its own Deadpool connection pool with up to eight
connections. The driver configuration retains the SQL Server credentials in
memory to open additional connections. Pool checkout and connection creation
each have a 10-second timeout. Signing out, replacing a session through a
successful sign-in, or cleaning up an expired session closes its pool.

SQL Server transport
----------

The SQL connection requires encryption. By default, the driver validates the
server certificate. A login request can explicitly set trust_server_certificate
to skip or require certificate verification. If the field is omitted, the
backend uses MSSQL_TRUST_CERT. The browser form sends the checkbox value
explicitly.
```

[Authentication](../backend/src/auth.rs) · [Connection setup](../backend/src/database.rs) · [Sign-in form](../frontend/src/App.tsx)

## Query execution

```text
Batch preparation
==========

The workspace sends the selected SQL text or the full editor contents with
the tab's database. When the dropdown is empty, the submitted SQL must start
with USE. API requests with an omitted, null, or empty database use master.

The backend parses the input with the sqlparser SQL Server dialect. The
validator accepts query statements and single-identifier USE statements,
requires at least one query, and rejects SELECT INTO. SQL Server applies the
signed-in account's permissions to database and object access.

The backend quotes the database identifier and prepends USE to every batch
so a reused connection starts in the requested database. A permitted USE
inside the batch can change the context for later statements in that batch.

Execution and result collection
----------

The backend checks out a connection, runs the batch, and reads the complete
TDS result stream even when only a preview is retained. It returns the
connection to the pool after success and drops it after an execution error
or timeout. The response contains the result sets and elapsed milliseconds,
including pool checkout time.
```

| Limit | Behavior |
|---|---|
| 24 KiB of submitted SQL | The backend rejects larger inputs before parsing. |
| 30 seconds per database operation | The timer starts after pool checkout and includes reading the results. |
| 500 rows per result set | Additional rows set that result set's `truncated` flag. |
| 4 KiB preview for large text, XML, and binary values | Binary values use hexadecimal. Clipped values include a trailing ellipsis. |
| 8 MiB estimated row data per batch | A shared budget covers formatted cell bytes plus 8 bytes per cell. If a row exceeds the remaining budget, that result set is marked `truncated`. |

[Workspace](../frontend/src/Workspace.tsx) · [SQL validation](../backend/src/database/selection.rs) · [Query execution](../backend/src/database.rs)

## HTTP API

```text
Requests
==========

The API is served under /api and sends Cache-Control: no-store. Session,
database, table, and query endpoints require the session cookie.

Responses
----------

Query cells are formatted as JSON strings or null. Application errors use
{code, params, detail}. The frontend uses code and params to render localized
messages and shows detail when supplied.
```

| Endpoint | Input | Success response |
|---|---|---|
| `GET /api/session` | Session cookie | `{server, username}` |
| `POST /api/login` | JSON with `server`, `username`, `password`, optional `port`, and optional `trust_server_certificate` | `{server, username}` and a session cookie |
| `POST /api/logout` | Existing cookie, if present | `204 No Content` and a cookie removal header |
| `GET /api/databases` | Session cookie | Array of online database names accessible to the SQL Server account |
| `GET /api/tables` | Session cookie and `database` query parameter | Array of `{schema, name}` objects for user tables visible to the SQL Server account |
| `POST /api/query` | Session cookie and JSON with `sql` and optional `database` | `{results, elapsed_ms}` with `{columns, rows, truncated}` per result set |

[Router](../backend/src/main.rs) · [Browser API client](../frontend/src/api.ts) · [Error notice](../frontend/src/ErrorNotice.tsx)

## Runtime settings

```text
Container defaults
==========

make run builds and starts the Compose app service. Compose publishes the
app on the host loopback interface. The app binds to port 8003 inside the
container by default.
```

| Setting | Default | Purpose |
|---|---|---|
| `APP_PORT` | `8003` | Host port published by Compose on `127.0.0.1` |
| `APP_BIND` | `0.0.0.0:8003` | Backend listen address inside the container or when running the binary directly |
| `STATIC_DIR` | `/app/web` in Docker, `frontend/dist` in the binary | Directory Axum serves for the frontend |
| `APP_SECURE_COOKIE` | `false` | Adds the `Secure` flag to the session cookie when set to `true` |
| `MSSQL_TRUST_CERT` | `false` | Fallback for certificate trust when the login request omits `trust_server_certificate` |

[Makefile](../Makefile) · [Compose](../compose.yaml) · [Dockerfile](../Dockerfile)
