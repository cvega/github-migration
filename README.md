<h1 align="center">
  <img src="static/imgs/github-logo.png" width="36" height="36" alt="GitHub" style="vertical-align: middle;" />
  GitHub Migrate
</h1>

<p align="center">
  <strong>Web UI for migrating repositories between GitHub Enterprise Server and GitHub Enterprise Cloud</strong>
</p>

<p align="center">
  <img alt="Bun" src="https://img.shields.io/badge/Bun-1.3.9+-f9f1e1?logo=bun&logoColor=f9f1e1&labelColor=14151a" />
  <img alt="SvelteKit" src="https://img.shields.io/badge/SvelteKit-2-ff3e00?logo=svelte&logoColor=white&labelColor=14151a" />
  <img alt="Svelte" src="https://img.shields.io/badge/Svelte-5-ff3e00?logo=svelte&logoColor=white&labelColor=14151a" />
  <img alt="Tailwind CSS" src="https://img.shields.io/badge/Tailwind-v4-06b6d4?logo=tailwindcss&logoColor=06b6d4&labelColor=14151a" />
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-WAL-003b57?logo=sqlite&logoColor=white&labelColor=14151a" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white&labelColor=14151a" />
  <img alt="Vite" src="https://img.shields.io/badge/Vite-7-646cff?logo=vite&logoColor=white&labelColor=14151a" />
  <img alt="Biome" src="https://img.shields.io/badge/Biome-2.3-60a5fa?logo=biome&logoColor=white&labelColor=14151a" />
  <img alt="Docker" src="https://img.shields.io/badge/Docker-Ready-2496ed?logo=docker&logoColor=white&labelColor=14151a" />
</p>

<p align="center">
  Single &amp; batch migrations · Real-time SSE progress · Cancellation &amp; restart · Crash recovery · GitHub App &amp; PAT auth
</p>

---

## Features

- **GHES → GHEC & GHEC → GHEC** — archive-based or direct passthrough migrations
- **Batch operations** — migrate up to 500 repos in a single request
- **Concurrency queue** — up to 10 concurrent migrations (GitHub limit), excess auto-queued FIFO
- **Real-time monitoring** — live phase timeline, progress bars, throughput rates via SSE
- **Cancellation & restart** — abort at any pipeline stage; restart failed/cancelled migrations in place
- **Crash recovery** — env-configured auth (`env-app`, `env-pat`) migrations auto-resume from checkpoint on restart
- **Flexible auth** — PAT tokens (per-request or env), per-request GitHub App, or env-configured GitHub App with auto-refresh
- **Preflight checks** — validates GHES version, target org, warns on existing target repos
- **Security** — CSP headers, timing-safe auth, HMAC-signed sessions, rate limiting, non-root container

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.3.9
- Docker/Podman (for containerized deployment)

---

## Quick Start

### Docker Compose (recommended)

```bash
cp .env.example .env        # configure env vars (see below)
docker compose up -d         # app at http://localhost:3000
```

### Without Docker

```bash
cp .env.example .env
bun install
bun run build
bun build/index.js           # production server at http://localhost:3000
```

---

## Development

```bash
bun install                  # install deps
bun run dev                  # dev server → http://localhost:5173
bun run check                # svelte-check + TypeScript diagnostics
bun run ci                   # check + build (pre-deploy gate)
bun run lint                 # Biome lint
bun run format               # Biome format
bun run seed                 # populate DB with ~2,500 fake migrations
```

### Seeding

The seed script generates ~2,500 migrations (~150 batches) across all states for UI testing. It's idempotent — only touches rows with `seed-` prefixed IDs.

```bash
bun run seed                 # writes to ./data/gh-migrate.db
bun run dev                  # dev server reads from the same file
```

To seed inside a running container:

```bash
bun run seed
docker compose cp ./data/gh-migrate.db gh-migrate:/data/gh-migrate.db
docker compose restart
```

### Project Structure

```
src/
  app.css                     Tailwind v4 @theme (GitHub Primer dark palette)
  app.html                    HTML shell
  hooks.server.ts             auth, security headers, compression, startup init
  lib/
    types.ts                  shared TypeScript types (server + client)
    format.ts                 date/number formatting helpers
    context-keys.ts           Svelte context key constants
    server/
      manager.ts              concurrency (10), abort controllers, queue, SSE broadcast
      migration.ts            pipeline: preflight → archiving → ghec_starting → monitoring
      monitor.ts              polls GHEC status, detects phases, computes progress
      store.ts                SQLite persistence, pagination, batch aggregation
      schema.ts               DDL, indexes, schema migrations
      github.ts               Octokit wrapper (REST + GraphQL, retry + throttle)
      auth.ts                 PAT / GitHub App / env auth resolution
      upload.ts               streaming multipart archive upload with retry + AbortSignal
      validate.ts             request body validation
      session.ts              cookie-based HMAC session auth + rate limiting
      util.ts                 shared server utilities
    components/
      AuthPill.svelte         auth mode indicator badge
      FailureDetail.svelte    expandable failure reason + log link
      GitHubStatus.svelte     GitHub incident status banner
      MigrationCard.svelte    migration list item card
      Octicon.svelte          SVG icon wrapper (@primer/octicons)
      Pagination.svelte       page navigation controls
      PhaseTimeline.svelte    migration phase progress visualization
      ProgressBar.svelte      animated progress bar with percentage
      StatsTable.svelte       source/target counts comparison table
    stores/
      migrations.svelte.ts    client-side SSE + runes reactive state
  routes/
    +layout.server.ts         global load (auth, GitHub status, rate limits)
    +layout.svelte            app shell (nav, SSE, auth gate)
    +page.server.ts           dashboard load (paginated migrations)
    +page.svelte              dashboard (migration list)
    [id]/                     migration detail page
    new/                      new migration form
    batches/                  batch list + detail pages
    api/
      health/                 GET — health check
      events/                 GET — global SSE stream
      rate-limits/            GET — live rate limit info
      migrations/             GET (list) · POST (create)
        [id]/                 GET (detail) · DELETE (cancel)
          events/             GET — per-migration SSE stream
          restart/            POST — restart failed/cancelled
      batches/                GET (list) · POST (create batch)
        [id]/                 GET (detail) · DELETE (cancel batch)
          restart/            POST — restart failed/cancelled in batch
```

---

## Architecture

### Migration Pipeline

Each migration follows a 5-step pipeline managed by a concurrency-limited queue (max 10 concurrent, GitHub's org limit):

```
queued → pending → preflight → archiving → ghec_starting → monitoring → succeeded/failed
```

1. **Preflight** — validates GHES version (≥ 3.4.1), target org access, warns if target repo exists
2. **Archiving** (GHES only) — triggers git + metadata archive export, downloads to disk
3. **GHEC Starting** — uploads archives (streaming multipart for large files), calls `startRepositoryMigration` via GraphQL
4. **Monitoring** — polls GHEC migration status, detects phase transitions, computes progress deltas
5. **Completion** — records final counts, elapsed time, migration log URL

### Auth Modes

| Mode | Source | Credentials | Crash-Recoverable |
|---|---|---|---|
| `pat` | Per-request | User-provided PAT | No |
| `request-app` | Per-request | User-provided App ID/key/installation | No |
| `env-app` | Environment | `GH_*_APP_*` env vars | Yes |
| `env-pat` | Environment | `GH_*_PAT` env vars | Yes |

Priority: per-request PAT → per-request App → env App → env PAT.

### Database

SQLite (WAL mode, `bun:sqlite`) with two tables:

**`migrations`** — `id` (UUIDv7 PK), `batch_id`, `github_migration_id`, `source_api_url`, `source_org`, `source_repo`, `target_org`, `target_repo`, `state`, `pipeline_step`, `auth_mode`, `failure_reason`, `migration_log_url`, `warnings_count`, `source_counts` (JSON), `target_counts` (JSON), `started_at`, `completed_at`, `elapsed_seconds`

**`events`** — `id` (autoincrement PK), `migration_id` (FK), `event_type`, `phase`, `payload` (JSON), `created_at`

States: `queued` · `pending` · `running` · `succeeded` · `failed` · `cancelled`

Batches are a logical grouping via `migrations.batch_id` — no separate table.

---

## Configuration

All via environment variables. See [.env.example](.env.example) for the full list.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `DATA_DIR` | `./data` | SQLite database directory |
| `ARCHIVE_DIR` | OS temp | Temp directory for GHES archive exports |
| `GH_MIGRATE_USER` | — | Basic auth username (optional — if unset, no auth) |
| `GH_MIGRATE_PASS` | — | Basic auth password (optional — if unset, no auth) |

### PATs (optional, per side)

Configure env PATs to avoid passing credentials per request. These migrations are crash-recoverable.

| Variable | Description |
|---|---|
| `GH_SOURCE_PAT` | Source PAT (GHES or GHEC) |
| `GH_TARGET_PAT` | Target PAT (GHEC) |

### GitHub App (optional, per side)

Configure a GitHub App for auto-refreshing installation tokens. These migrations are crash-recoverable.

**Source** (GHES or GHEC):

| Variable | Description |
|---|---|
| `GH_SOURCE_APP_ID` | App ID |
| `GH_SOURCE_APP_PRIVATE_KEY` | PEM key (literal or base64) |
| `GH_SOURCE_APP_INSTALLATION_ID` | Installation ID |
| `GH_SOURCE_API_URL` | API base URL (default: `https://api.github.com`) |

**Target** (GHEC):

| Variable | Description |
|---|---|
| `GH_TARGET_APP_ID` | App ID |
| `GH_TARGET_APP_PRIVATE_KEY` | PEM key (literal or base64) |
| `GH_TARGET_APP_INSTALLATION_ID` | Installation ID |

Per-request PATs or App credentials always take precedence over env-configured auth.

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
      # Basic auth:
      # - GH_MIGRATE_USER=admin
      # - GH_MIGRATE_PASS=changeme
      # Env PATs:
      # - GH_SOURCE_PAT=ghp_...
      # - GH_TARGET_PAT=ghp_...
      # Source GitHub App:
      # - GH_SOURCE_APP_ID=12345
      # - GH_SOURCE_APP_PRIVATE_KEY=base64-encoded-pem
      # - GH_SOURCE_APP_INSTALLATION_ID=67890
      # - GH_SOURCE_API_URL=https://ghes.example.com/api/v3
      # Target GitHub App:
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

---

## API

### Migrations

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/migrations?page=1&limit=25` | List (paginated) |
| `POST` | `/api/migrations` | Start single migration |
| `GET` | `/api/migrations/:id` | Get details |
| `DELETE` | `/api/migrations/:id` | Cancel |
| `POST` | `/api/migrations/:id/restart` | Restart failed/cancelled |
| `GET` | `/api/migrations/:id/events` | SSE event stream |

### Batches

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/batches?page=1&limit=25` | List (paginated) |
| `POST` | `/api/batches` | Start batch (up to 500 repos) |
| `GET` | `/api/batches/:id` | Summary + migrations |
| `DELETE` | `/api/batches/:id` | Cancel all in batch |
| `POST` | `/api/batches/:id/restart` | Restart all failed/cancelled in batch |

### Other

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/events` | Global SSE stream |
| `GET` | `/api/rate-limits` | Live rate limit info |

---

## Troubleshooting

### "Concurrency limit reached"

GitHub allows max 10 concurrent migrations per org. Excess migrations are automatically queued and promoted FIFO as slots open.

### Migration stuck in "running" after restart

Only env-configured auth (`env-app` or `env-pat`) migrations with a GHEC migration ID are auto-recovered on restart. PAT or per-request app migrations can't be recovered because credentials are not persisted. These are marked as `failed` on startup with reason "Server restarted during migration." Re-run them manually.

### SSE not reconnecting

The client retries with exponential backoff (1s → 30s, max 20 attempts). If the server is behind a proxy, ensure it doesn't buffer SSE responses. Set `X-Accel-Buffering: no` for nginx.

### Archive upload fails for large repos

Archives stream from disk, not memory. Large uploads use multipart chunking with automatic retry and AbortSignal support. Ensure `ARCHIVE_DIR` has enough space for the largest repo's git + metadata archives (2x repo size as a rough estimate).

### Self-signed GHES certificates

Check "No SSL Verify" in the migration form, or set it in the API request body (`noSslVerify: true`).

### Rate limit exhaustion

The navbar shows live `remaining/limit` for both source and target. GitHub App auth gets 5,000 req/hr per installation. If you're running many concurrent migrations, GitHub App auth is strongly recommended over PATs.

### Database backup

```bash
# Safe online backup (never copy the .db file directly while running)
docker compose exec gh-migrate sqlite3 /data/gh-migrate.db ".backup /data/backup.db"
docker compose cp gh-migrate:/data/backup.db ./backup.db
```

---

## Makefile

```
make install       bun install
make dev           start dev server
make build         production build
make preview       build + preview
make check         svelte-check
make lint          Biome lint
make lint-fix      Biome lint --fix
make format        Biome format
make seed          populate DB with test data
make clean         remove build artifacts + data
make docker        build Docker image
make docker-up     docker compose up -d
make docker-down   docker compose down
```

---

<p align="center">
  <sub>Built with <a href="https://bun.sh">Bun</a> · <a href="https://svelte.dev">SvelteKit</a> · <a href="https://tailwindcss.com">Tailwind CSS</a></sub>
</p>
