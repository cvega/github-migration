# GitHub Migrate

A web-based tool for migrating repositories between GitHub Enterprise Server (GHES) and GitHub Enterprise Cloud (GHEC), or between GHEC organizations. Built with SvelteKit, Bun, and Tailwind CSS.

## Features

### Migration

- **Single & batch migrations** — migrate one repo or up to 500 at once
- **GHES → GHEC** — exports git + metadata archives from GHES, imports to GHEC
- **GHEC → GHEC** — direct migration between GHEC orgs (no archive step)
- **Dry Run / Production mode** — dry run leaves the source untouched; production mode locks the source repo during migration and archives it (read-only) on success
- **Skip releases** — optionally omit releases from the migration
- **Target visibility override** — set the target repo to `private`, `public`, or `internal`
- **No SSL verify** — for self-signed certificates on GHES
- **Concurrency** — up to 10 parallel migrations with automatic queuing
- **Cancellation** — abort running migrations at any time
- **Preflight checks** — validates GHES version (≥ 3.8.0), target org existence, warns if target repo already exists

### Monitoring

- **Real-time progress** — live phase timeline, progress bars, throughput rates, and resource counts via Server-Sent Events (SSE)
- **Source / target reconciliation** — compares commits, branches, tags, issues, PRs, and releases between source and target after completion
- **Event log** — color-coded, timestamped log of every migration event
- **Failure diagnostics** — failure reason, log URL, and detailed error breakdown

### Auth & Security

- **PAT tokens** — provide a personal access token per request
- **GitHub App** — supply App ID, PEM key, and installation ID per request; installation tokens are auto-generated and refreshed
- **Env App** — configure a GitHub App via environment variables; users select "Env App" in the UI with no credentials needed
- **Live rate limits** — navbar badges show real-time `remaining/limit` from the GitHub API; badges turn yellow during active migrations
- **Optional basic auth** — protect the UI with username/password; brute-force rate limited (5 attempts per 15 minutes per IP)
- **Security headers** — `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`

### Infrastructure

- **Persistent state** — SQLite via `bun:sqlite` stores all migrations, batches, and events across restarts
- **Docker ready** — single-container deployment with three-stage build (build → production deps → runtime), non-root `app` user, and persistent volume
- **Health endpoint** — `/api/health` for uptime monitoring; used by Docker `HEALTHCHECK`
- **Graceful shutdown** — SIGTERM/SIGINT handlers close the database cleanly
- **Crash recovery** — on startup, env-app migrations left in `pending`/`running` state are automatically resumed from their last checkpoint; PAT / per-request app migrations (whose credentials are lost) are marked `failed`
- **Pipeline checkpoints** — each pipeline step (`preflight`, `export`, `upload`, `import`, `monitor`, `verify`) is persisted, so a recovered migration skips already-completed work

## Development

Requires [Bun](https://bun.sh) v1.3.9+.

```bash
bun install          # install dependencies
bun run dev          # start dev server on http://localhost:5173
bun run check        # svelte-check + TypeScript diagnostics
bun run ci           # check + build (use before deploying)
bun run seed         # populate the database with ~2,500 fake migrations
bun run format       # format with Biome
bun run lint         # lint with Biome
```

### Project Structure

```
src/
  lib/
    server/         # backend — GitHub API, migration pipeline, SQLite store
    components/     # Svelte 5 UI components
    stores/         # client-side reactive state
    types.ts        # shared TypeScript types
  routes/           # SvelteKit pages + API endpoints
  hooks.server.ts   # auth, security headers, startup init
seed.ts             # dev seed script
```

## Quick Start

### Docker Compose (recommended)

1. Clone the repository
2. Copy `.env.example` to `.env` and configure as needed
3. Run:

```bash
docker compose up -d
```

The app is available at [http://localhost:3000](http://localhost:3000). The SQLite database is persisted in a named volume.

### Docker

```bash
docker build -t gh-migrate .
docker run -p 3000:3000 -v gh-migrate-data:/data gh-migrate
```

### Production Build (without Docker)

```bash
bun run build
bun build/index.js
```

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` for local development.

### General

| Variable          | Default  | Description                                                  |
| ----------------- | -------- | ------------------------------------------------------------ |
| `PORT`            | `3000`   | HTTP server port                                             |
| `DATA_DIR`        | `./data` | Directory for the SQLite database file                       |
| `ARCHIVE_DIR`     | OS temp  | Directory for temporary archive files during GHES migrations |
| `GH_MIGRATE_USER` | —        | Basic auth username (optional)                               |
| `GH_MIGRATE_PASS` | —        | Basic auth password (optional)                               |

### Source GitHub App (optional)

Configure a GitHub App on the source instance to avoid per-request PAT tokens.

| Variable                        | Description                                             |
| ------------------------------- | ------------------------------------------------------- |
| `GH_SOURCE_APP_ID`              | GitHub App ID                                           |
| `GH_SOURCE_APP_PRIVATE_KEY`     | PEM private key (literal or base64-encoded)             |
| `GH_SOURCE_APP_INSTALLATION_ID` | Installation ID for the source org                      |
| `GH_SOURCE_API_URL`             | Source API base URL (default: `https://api.github.com`) |

### Target GitHub App (optional)

Configure a GitHub App on GHEC for the target side.

| Variable                        | Description                                 |
| ------------------------------- | ------------------------------------------- |
| `GH_TARGET_APP_ID`              | GitHub App ID                               |
| `GH_TARGET_APP_PRIVATE_KEY`     | PEM private key (literal or base64-encoded) |
| `GH_TARGET_APP_INSTALLATION_ID` | Installation ID for the target org          |

When a GitHub App is configured for a side, it appears as the "Env App" option in the UI. Installation tokens are auto-generated and refreshed. PATs or per-request App credentials always take precedence.

### Docker Compose Example

```yaml
services:
  gh-migrate:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - gh-migrate-data:/data
      - gh-migrate-archives:/archives
    environment:
      - DATA_DIR=/data
      - ARCHIVE_DIR=/archives
      - PORT=3000
      # Optional basic auth:
      # - GH_MIGRATE_USER=admin
      # - GH_MIGRATE_PASS=changeme
      # Optional source GitHub App:
      # - GH_SOURCE_APP_ID=12345
      # - GH_SOURCE_APP_PRIVATE_KEY=base64-encoded-pem
      # - GH_SOURCE_APP_INSTALLATION_ID=67890
      # - GH_SOURCE_API_URL=https://ghes.example.com/api/v3
      # Optional target GitHub App:
      # - GH_TARGET_APP_ID=12345
      # - GH_TARGET_APP_PRIVATE_KEY=base64-encoded-pem
      # - GH_TARGET_APP_INSTALLATION_ID=67890
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  gh-migrate-data:
  gh-migrate-archives:
```

## API

### Migrations

| Method   | Endpoint                          | Description                      |
| -------- | --------------------------------- | -------------------------------- |
| `GET`    | `/api/migrations?page=1&limit=25` | List migrations (paginated)      |
| `POST`   | `/api/migrations`                 | Start a single migration         |
| `GET`    | `/api/migrations/:id`             | Get migration details            |
| `DELETE` | `/api/migrations/:id`             | Cancel a running migration       |
| `GET`    | `/api/migrations/:id/events`      | SSE stream for real-time updates |

### Batches

| Method   | Endpoint                       | Description                               |
| -------- | ------------------------------ | ----------------------------------------- |
| `GET`    | `/api/batches?page=1&limit=25` | List batches (paginated)                  |
| `POST`   | `/api/batches`                 | Start a batch migration (up to 500 repos) |
| `GET`    | `/api/batches/:id`             | Get batch summary + migrations            |
| `DELETE` | `/api/batches/:id`             | Cancel all active migrations in batch     |

### Other

| Method | Endpoint      | Description                        |
| ------ | ------------- | ---------------------------------- |
| `GET`  | `/api/health` | Health check with auth config info |
| `GET`  | `/api/events` | Global SSE stream (all migrations) |

## Backup

The SQLite database stores all migration state, events, and batch data. Back it up safely while the server is running:

```bash
# From the host — online backup via SQLite CLI
docker compose exec gh-migrate sqlite3 /data/migrations.db ".backup /data/backup.db"
docker cp $(docker compose ps -q gh-migrate):/data/backup.db ./migrations-backup.db
```

> **Important:** Never copy the `.db` file directly while the server is running — the `.db-wal` and `.db-shm` journal files must stay in sync. Always use SQLite's `.backup` command or `VACUUM INTO` for a consistent snapshot.

The `gh-migrate-archives` volume holds temporary GHES export archives during migration. These are cleaned up automatically after each migration completes. No backup is needed for this volume.

## Makefile

```
make install       # bun install
make dev           # start dev server
make build         # production build
make preview       # build + preview
make check         # svelte-check type checking
make seed          # populate DB with test data
make clean         # remove build artifacts
make docker        # build Docker image
make docker-up     # docker compose up -d
make docker-down   # docker compose down
```

## License

Private
