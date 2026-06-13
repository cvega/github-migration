# Getting Started

Get the GitHub Migration Dashboard running and migrate your first repository.

- [Requirements](#requirements)
- [Run with Docker (recommended)](#run-with-docker-recommended)
- [Run without Docker](#run-without-docker)
- [Your first migration](#your-first-migration)
- [Next steps](#next-steps)

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.3.9
- Docker or Podman (for containerized deployment)
- Source access: a PAT or GitHub App on the GHES/GHEC source
- Target access: a PAT or GitHub App on the GHEC target

You can supply credentials per migration in the UI, so no environment
configuration is strictly required to start.

---

## Run with Docker (recommended)

```bash
cp .env.example .env         # configure as needed (all vars optional)
docker compose up -d         # app at http://localhost:3000
```

See [Deployment](deployment.md) for production concerns (reverse proxy, `ORIGIN`,
backups, non-root container) and [Configuration](configuration.md) for the full
environment-variable reference.

---

## Run without Docker

```bash
cp .env.example .env
bun install
bun run build
bun build/index.js           # production server at http://localhost:3000
```

For a live-reload development server instead, see [Development](development.md).

---

## Your first migration

1. Open the app and (if basic auth is enabled) log in.
2. Click **New Migration**.
3. Choose **single** or **batch**:
   - **Single** — enter the source `org/repo` and a target org.
   - **Batch** — paste up to 500 `org/repo` lines (or bare repo names if a source
     org is pre-configured).
4. Provide source and target credentials — or, if the server has env credentials
   configured, use those directly.
5. Pick options if needed (visibility, skip releases, direct passthrough, SSL
   verification) and submit.
6. Watch live progress on the detail page: the phase timeline, per-resource
   counts, and throughput update over SSE. Migrations beyond the 10-concurrent
   cap are queued and promoted automatically.

A migration can be **cancelled** while running and **restarted** if it fails or
is cancelled — in place, reusing the same record.

---

## Next steps

- [Configuration](configuration.md) — auth, watchdog, target cleanup, defaults
- [Architecture](architecture.md) — how the pipeline and queue work
- [API Reference](api.md) — drive migrations programmatically
- [Troubleshooting](troubleshooting.md) — common issues and fixes
- [Deployment](deployment.md) — running in production
