# zpersist documentation

## Overview

```text
Workspace
==========

zpersist lets you browse SQL Server databases and run read-only SQL queries
from a browser. The interface supports English and Thai.
```

## Setup

```text
Requirements
==========

Docker Compose, Make, and a SQL Server IP address and port that the app
container can reach. Sign in with a SQL Server username and password.
```

```bash
# ---------- bash ---------- #

# Run from the repository root on first setup
cp .env.example .env
```

## Run

```text
Open the workspace
==========

Start the app from the repository root and open http://localhost:8003.
Enter the server IP and SQL Server port. The SQL Server port defaults to 1433.

Run a query
----------

After signing in, select a database and use Run SQL or Ctrl+Enter
(Cmd+Enter on macOS). The editor runs selected text when present and the full
editor contents when there is no selection.
```

```bash
# ---------- bash ---------- #

# Start the app
make run

# Stop the app
make down
```

## Documentation

| Document | Contents |
|---|---|
| [Architecture](architecture.md) | Deployment, browser state, sessions, SQL execution, API routes, and runtime settings |
| [Vim mode](vim.md) | Editor modes, keybindings, and SQL execution shortcuts |
| [Docs format guide](docs-format-guide.md) | Formatting examples for repository documentation |
| [Commit guide](commit-guide.md) | Commit message convention |
