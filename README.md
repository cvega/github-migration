<p align="center">
  <img src="static/imgs/github-logo.png" width="80" height="80" alt="GitHub" />
</p>
<h1 align="center">GitHub Migration Dashboard</h1>

<p align="center">
  <strong>Web UI for migrating repositories between GitHub Enterprise Server and GitHub Enterprise Cloud</strong>
</p>

<p align="center">
  <img alt="Bun" src="https://img.shields.io/badge/Bun-1.3.9+-f9f1e1?logo=bun&logoColor=f9f1e1&labelColor=14151a" />
  <img alt="SvelteKit" src="https://img.shields.io/badge/SvelteKit-2-ff3e00?logo=svelte&logoColor=white&labelColor=14151a" />
  <img alt="Svelte" src="https://img.shields.io/badge/Svelte-5-ff3e00?logo=svelte&logoColor=white&labelColor=14151a" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white&labelColor=14151a" />
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
- **Stall watchdog** — auto-detects migrations that hang with zero progress and restarts them, while never touching large repos
- **Crash recovery** — env-configured auth (`env-app`, `env-pat`) migrations auto-resume from checkpoint on restart
- **Flexible auth** — PAT tokens (per-request or env), per-request GitHub App, or env-configured GitHub App with auto-refresh
- **Preflight checks** — validates GHES version, target org, warns on existing target repos
- **Security** — CSP headers, timing-safe auth, HMAC-signed sessions, rate limiting, non-root container

---

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <img src="static/imgs/screenshots/dashboard.png" alt="Dashboard" /><br />
      <strong>Dashboard</strong> — active &amp; completed migrations, batches
    </td>
    <td align="center" width="50%">
      <img src="static/imgs/screenshots/stats.png" alt="Statistics" /><br />
      <strong>Statistics</strong> — success rate, throughput, platform breakdown
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="static/imgs/screenshots/batch.png" alt="Batch detail" /><br />
      <strong>Batch detail</strong> — per-repo progress &amp; controls
    </td>
    <td align="center" width="50%">
      <img src="static/imgs/screenshots/new-migration.png" alt="New migration" /><br />
      <strong>New migration</strong> — single &amp; batch request form
    </td>
  </tr>
</table>

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.3.9
- Docker/Podman (for containerized deployment)

---

## Quick Start

### Docker Compose (recommended)

```bash
cp .env.example .env         # configure env vars (see below)
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
  hooks.server.ts       auth, security headers, compression, startup init
  lib/
    server/             core logic: manager (queue/SSE), migration (pipeline),
                        monitor, store (SQLite), github (Octokit), auth, upload
    components/         Svelte UI (cards, timeline, progress, stats, …)
    stores/             client-side SSE + runes reactive state
  routes/
    [id]/  new/  batches/   migration detail, new form, batch pages
    api/                REST + SSE endpoints (see API section below)
```

---

## Architecture

### Migration Pipeline

Each migration follows a 5-step pipeline managed by a concurrency-limited queue (max 10 concurrent, GitHub's org limit):

```
queued → pending → preflight → archiving → ghec_starting → monitoring → succeeded/failed
```

1. **Preflight** — validates GHES version (≥ 3.15), target org access, warns if target repo exists
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

SQLite via `bun:sqlite` in WAL mode, with two tables.

**`migrations`** — one row per repository migration:

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | Primary key (UUIDv7, time-sortable) |
| `batch_id` | TEXT | Groups migrations started together (nullable) |
| `github_migration_id` | TEXT | GHEC-assigned migration ID (nullable) |
| `source_api_url` · `source_org` · `source_repo` | TEXT | Where the repo comes from |
| `target_org` · `target_repo` | TEXT | Where the repo lands |
| `state` | TEXT | Lifecycle state (see below) |
| `pipeline_step` | TEXT | Current step within the pipeline |
| `auth_mode` | TEXT | `pat` · `request-app` · `env-app` · `env-pat` |
| `failure_reason` · `migration_log_url` | TEXT | Populated on failure / completion |
| `warnings_count` | INTEGER | Non-fatal warnings surfaced during migration |
| `source_counts` · `target_counts` | JSON | Commit/issue/PR counts, before and after |
| `started_at` · `completed_at` | TEXT | ISO timestamps |
| `elapsed_seconds` | REAL | Total run time |

**`events`** — append-only audit/progress log, one row per state change:

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | Primary key (autoincrement) |
| `migration_id` | TEXT | Foreign key → `migrations.id` |
| `event_type` | TEXT | What happened |
| `phase` | TEXT | Pipeline phase at the time (nullable) |
| `payload` | JSON | Event-specific detail |
| `created_at` | TEXT | ISO timestamp |

**States:** `queued` → `pending` → `running` → `succeeded` / `failed` / `cancelled`

There is no separate batches table — a batch is simply a set of `migrations` rows sharing the same `batch_id`.

**Why SQLite?** The workload is single-node, low-volume, and read-heavy, and write throughput is naturally capped by GitHub's limit of up to 10 concurrent migrations per org. WAL mode lets the dashboard and SSE pollers read while a migration writes, and an in-process `bun:sqlite` database removes a whole moving part (no separate DB server to run, network, or back up).

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

### Stall Watchdog (optional)

Guards against the bug where a migration occasionally hangs in an in-progress state for hours without ever failing, tying up one of the 10 concurrent slots. The watchdog only acts on migrations that have *started importing* (GHEC reports `IN_PROGRESS`) and have made **zero forward progress** for the stall window. It restarts them up to `WATCHDOG_MAX_RESTARTS` times, then marks them `failed` for manual review.

**Large repos are never auto-restarted** — they legitimately take a long time. "Large" is a composite: a repo counts as large if **any** dimension (disk size, commits, issues, or PRs) meets or exceeds its cap. A 3 KB repo with 10k issues is still large.

| Variable | Default | Description |
|---|---|---|
| `WATCHDOG_ENABLED` | `true` | Master switch (`true`/`1` to enable) |
| `WATCHDOG_STALL_MINUTES` | `30` | No-progress window before a migration is considered stalled |
| `WATCHDOG_MAX_RESTARTS` | `1` | Auto-restarts before giving up and marking the migration `failed` |
| `WATCHDOG_MAX_SIZE_MB` | `100` | Disk-size cap — at or above this, a repo is "large" |
| `WATCHDOG_MAX_COMMITS` | `50000` | Commit-count cap — at or above this, a repo is "large" |
| `WATCHDOG_MAX_ISSUES` | `5000` | Issue-count cap — at or above this, a repo is "large" |
| `WATCHDOG_MAX_PRS` | `5000` | Pull-request-count cap — at or above this, a repo is "large" |

A ready-to-edit [docker-compose.yml](docker-compose.yml) and [.env.example](.env.example) cover all of the above.

---

## API

All endpoints return JSON. SSE streams emit migration/batch state changes.

| Method | Endpoint | Description |
|---|---|---|
| `GET` `POST` | `/api/migrations` | List (paginated) · start single |
| `GET` `DELETE` | `/api/migrations/:id` | Details · cancel |
| `POST` | `/api/migrations/:id/restart` | Restart failed/cancelled |
| `GET` | `/api/migrations/:id/events` | Per-migration SSE stream |
| `GET` `POST` | `/api/batches` | List (paginated) · start batch (≤500 repos) |
| `GET` `DELETE` | `/api/batches/:id` | Summary + migrations · cancel all |
| `POST` | `/api/batches/:id/restart` | Restart all failed/cancelled in batch |
| `GET` | `/api/health` · `/api/events` · `/api/rate-limits` | Health · global SSE · live rate limits |

---

## Troubleshooting

### "Concurrency limit reached"

GitHub allows **up to** 10 concurrent migrations per org — that's a ceiling, not a guarantee, and the effective limit can be lower depending on GitHub-side load and throttling. Excess migrations are automatically queued and promoted FIFO as slots open.

### Migration stuck in "running" after restart

Only env-configured auth (`env-app` or `env-pat`) migrations with a GHEC migration ID are auto-recovered on restart. PAT or per-request app migrations can't be recovered because credentials are not persisted. These are marked as `failed` on startup with reason "Server restarted during migration." Re-run them manually.

### A migration keeps getting auto-restarted (or won't restart when it should)

The stall watchdog only acts on migrations that have started importing and show zero progress for `WATCHDOG_STALL_MINUTES`. Large repos (by size, commits, issues, or PRs — see [Stall Watchdog](#stall-watchdog-optional)) are never auto-restarted. If a legitimate small migration is being restarted too eagerly, raise `WATCHDOG_STALL_MINUTES` or lower the "large" caps so it's classified as large. To disable entirely, set `WATCHDOG_ENABLED=false`.

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
