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
  <img alt="Biome" src="https://img.shields.io/badge/Biome-2.3-60a5fa?logo=biome&logoColor=white&labelColor=14151a" />
  <img alt="Docker" src="https://img.shields.io/badge/Docker-Ready-2496ed?logo=docker&logoColor=white&labelColor=14151a" />
</p>

<p align="center">
  Single &amp; batch migrations · Real-time SSE progress · Cancellation · Crash recovery · GitHub App auth
</p>

---

## Features

- **GHES → GHEC & GHEC → GHEC** — archive-based or direct passthrough migrations
- **Batch operations** — migrate up to 500 repos in a single request
- **Real-time monitoring** — live phase timeline, progress bars, throughput rates via SSE
- **Cancellation** — abort at any pipeline stage; cleans up GHEC migration if started
- **Crash recovery** — env-app migrations auto-resume from checkpoint on restart
- **Flexible auth** — PAT tokens, per-request GitHub App, or env-configured GitHub App with auto-refresh
- **Preflight checks** — validates GHES version, target org, warns on existing target repos
- **Security** — CSP with nonces, timing-safe auth, rate limiting, non-root container

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
  hooks.server.ts             auth, security headers, startup init
  lib/
    server/
      manager.ts              concurrency (10), abort controllers, SSE broadcast
      migration.ts            pipeline: preflight → archive → migrate → monitor
      monitor.ts              polls GHEC status, computes progress deltas
      store.ts / schema.ts    SQLite persistence, pagination, batch aggregation
      github.ts               Octokit wrapper (REST + GraphQL)
      auth.ts                 PAT / GitHub App / env App resolution
      upload.ts               streaming multipart archive upload
      validate.ts             request body validation
    components/               Svelte 5 UI components
    stores/                   client-side reactive state (SSE + runes)
    types.ts                  shared TypeScript types
  routes/                     SvelteKit pages + API endpoints
```

---

## Configuration

All via environment variables. See [.env.example](.env.example) for the full list.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `DATA_DIR` | `./data` | SQLite database directory |
| `ARCHIVE_DIR` | OS temp | Temp directory for GHES archive exports |
| `GH_MIGRATE_USER` | — | Basic auth username (optional) |
| `GH_MIGRATE_PASS` | — | Basic auth password (optional) |

### GitHub App (optional, per side)

Configure a GitHub App to avoid per-request PATs. Tokens are auto-generated and refreshed.

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

When configured, the app appears as "Env App" in the UI. Per-request PATs or App credentials always take precedence.

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
| `GET` | `/api/migrations/:id/events` | SSE event stream |

### Batches

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/batches?page=1&limit=25` | List (paginated) |
| `POST` | `/api/batches` | Start batch (up to 500 repos) |
| `GET` | `/api/batches/:id` | Summary + migrations |
| `DELETE` | `/api/batches/:id` | Cancel all in batch |

### Other

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/events` | Global SSE stream |
| `GET` | `/api/rate-limits` | Live rate limit info |

---

## Troubleshooting

### "Concurrency limit reached"

GitHub allows max 10 concurrent migrations per org. Wait for running migrations to complete or cancel some.

### Migration stuck in "running" after restart

Only `env-app` auth migrations with a GHEC migration ID are auto-recovered. PAT or per-request app migrations can't be recovered (credentials are lost). These are marked as `failed` on startup. Re-run them manually.

### SSE not reconnecting

The client retries with exponential backoff (1s → 30s, max 20 attempts). If the server is behind a proxy, ensure it doesn't buffer SSE responses. Set `X-Accel-Buffering: no` for nginx.

### Archive upload fails for large repos

Archives stream from disk, not memory. Ensure `ARCHIVE_DIR` has enough space for the largest repo's git + metadata archives (2x repo size as a rough estimate).

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
