# Troubleshooting

Common issues and how to resolve them.

- [Migrations show "queued" instead of starting](#migrations-show-queued-instead-of-starting-immediately)
- [Migration stuck in "running" after restart](#migration-stuck-in-running-after-restart)
- [A migration keeps getting auto-restarted](#a-migration-keeps-getting-auto-restarted-or-wont-restart-when-it-should)
- [SSE not reconnecting](#sse-not-reconnecting)
- [Login returns 403](#login-returns-403-cross-site-post-form-submissions-are-forbidden)
- [Archive upload fails for large repos](#archive-upload-fails-for-large-repos)
- [Self-signed GHES certificates](#self-signed-ghes-certificates)
- [Rate limit exhaustion](#rate-limit-exhaustion)
- [Database backup](#database-backup)

---

## Migrations show "queued" instead of starting immediately

GitHub allows **up to** 10 concurrent migrations per org — a ceiling, not a
guarantee, and the effective limit can be lower depending on GitHub-side load and
throttling. When all slots are busy, new migrations (single or batch) are
accepted and automatically queued, then promoted FIFO as running migrations
complete. Nothing is rejected; the new-migration page shows how many are in
process.

## Migration stuck in "running" after restart

Only env-configured auth (`env-app` or `env-pat`) migrations with a GHEC
migration ID are auto-recovered on restart. PAT or per-request App migrations
can't be recovered because credentials are not persisted — these are marked
`failed` on startup with reason "Server restarted during migration." Re-run them
manually. See [Architecture → Crash recovery](architecture.md#crash-recovery).

## A migration keeps getting auto-restarted (or won't restart when it should)

The stall watchdog only acts on migrations that have started importing and show
zero progress for `WATCHDOG_STALL_MINUTES`. Large repos (by size, commits,
issues, or PRs) are never auto-restarted. If a legitimate small migration is
restarted too eagerly, raise `WATCHDOG_STALL_MINUTES` or lower the "large" caps
so it's classified as large. To disable entirely, set `WATCHDOG_ENABLED=false`.
See [Configuration → Stall watchdog](configuration.md#stall-watchdog-optional).

## SSE not reconnecting

The client retries with exponential backoff (1s → 30s, max 20 attempts). If the
server is behind a proxy, ensure it doesn't buffer SSE responses — for nginx,
set `X-Accel-Buffering: no` and `proxy_buffering off` (see
[Deployment](deployment.md#behind-a-reverse-proxy)).

## Login returns 403 "Cross-site POST form submissions are forbidden"

SvelteKit's CSRF origin check saw a request `Origin` that didn't match the
server's computed origin — almost always because the app runs behind a
TLS-terminating reverse proxy (HTTPS outside, HTTP inside). Set the `ORIGIN` env
var to the public URL (e.g. `ORIGIN=https://migrate.example.com`). Only the login
form is affected; the JSON `/api/*` endpoints are not.

## Archive upload fails for large repos

Archives stream from disk, not memory. Large uploads use multipart chunking with
automatic retry and `AbortSignal` support. Ensure `ARCHIVE_DIR` has enough space
for the largest repo's git + metadata archives (~2× repo size as a rough
estimate).

## Self-signed GHES certificates

Check "No SSL Verify" in the migration form, or set `noSslVerify: true` in the
API request body.

## Rate limit exhaustion

The navbar shows live `remaining/limit` for both source and target. GitHub App
auth gets 5,000 req/hr per installation. If you're running many concurrent
migrations, GitHub App auth is strongly recommended over PATs.

## Database backup

Use SQLite's online backup — never copy the `.db` file directly while running:

```bash
docker compose exec gh-migrate sqlite3 /data/gh-migrate.db ".backup /data/backup.db"
docker compose cp gh-migrate:/data/backup.db ./backup.db
```
