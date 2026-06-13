# Deployment

Running the GitHub Migration Dashboard in production. The app is a single
`adapter-node` server backed by an in-process SQLite database — there's no
separate database or queue service to run.

- [Docker Compose](#docker-compose)
- [Behind a reverse proxy](#behind-a-reverse-proxy)
- [Storage & volumes](#storage--volumes)
- [Security posture](#security-posture)
- [Database backup](#database-backup)
- [Upgrading](#upgrading)

---

## Docker Compose

The shipped [docker-compose.yml](../docker-compose.yml) is production-shaped:

```yaml
services:
  gh-migrate:
    build: .
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    env_file: .env
    ports:
      - "3000:3000"
    volumes:
      - gh-migrate-data:/data        # SQLite database (persistent)
      - gh-migrate-archives:/archives # temp archive exports
    environment:
      - DATA_DIR=/data
      - ARCHIVE_DIR=/archives
      - PORT=3000
```

```bash
cp .env.example .env
docker compose up -d         # app at http://localhost:3000
```

The container runs as a **non-root** user (`entrypoint.sh` fixes volume
ownership then drops privileges) and with `no-new-privileges`. See
[Configuration](configuration.md) for all environment variables.

---

## Behind a reverse proxy

When terminating TLS at a proxy (HTTPS outside, HTTP inside), set the **`ORIGIN`**
env var to the public URL:

```bash
ORIGIN=https://migrate.example.com
```

SvelteKit derives the request origin from the `Host` header and enforces a CSRF
origin check on the login form. Without `ORIGIN`, that check sees the internal
HTTP origin and rejects the login POST with `403 Cross-site POST form
submissions are forbidden`. Only the login form is affected — the JSON `/api/*`
endpoints are not.

**Do not buffer SSE.** The dashboard relies on `text/event-stream`. For nginx:

```nginx
location / {
    proxy_pass http://gh-migrate:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;            # don't buffer SSE
    proxy_set_header X-Accel-Buffering no;
}
```

---

## Storage & volumes

| Mount | Purpose | Sizing |
|---|---|---|
| `/data` | SQLite database (`gh-migrate.db` + WAL) | Small — metadata only |
| `/archives` | Temporary GHES archive exports | ~2× the largest repo's size (git + metadata), transiently |

Archives are streamed to disk (not held in memory) and cleaned up after each
migration. Ensure `/archives` has headroom for the largest repo you'll migrate.

---

## Security posture

The app applies standard hardening out of the box:

- **Auth:** optional HMAC-signed session cookies (`httpOnly`, `secure` over
  HTTPS, `sameSite=lax`), timing-safe credential comparison, login rate limiting
  with backoff, server-side session expiry.
- **Headers:** `Content-Security-Policy` (nonce-based), `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- **CSRF:** SvelteKit's origin check is left enabled (set `ORIGIN` behind a
  proxy).
- **Container:** non-root user, `no-new-privileges`.
- **Errors:** the global handler returns a generic message with a trace id;
  internal detail is logged server-side, never returned to the client.

For the full security review (OWASP Top 10 mapping), see the commit history and
[Development → Conventions](development.md#conventions).

---

## Database backup

Never copy the `.db` file directly while the server is running (WAL). Use
SQLite's online backup:

```bash
docker compose exec gh-migrate sqlite3 /data/gh-migrate.db ".backup /data/backup.db"
docker compose cp gh-migrate:/data/backup.db ./backup.db
```

---

## Upgrading

```bash
git pull
docker compose build
docker compose up -d
```

The `/data` volume persists across rebuilds, so migration history is retained.
The schema is applied idempotently on startup.
