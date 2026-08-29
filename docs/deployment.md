# Deployment

The supported production topology is one dashboard process with one SQLite
data directory. Do not scale the application horizontally: queue ownership and
recovery are intentionally single-process, and an exclusive data-directory
lock rejects a second instance.

## Container Deployment

```bash
cp .env.example .env
docker compose up -d --build --wait
```

Compose publishes on `127.0.0.1:3000` by default, mounts named data and archive
volumes, and exposes the container runtime socket for bounded one-shot source
exporters. The image runs as a non-root application user after the entrypoint
fixes mounted-directory ownership.

Use a pinned release image through `GH_MIGRATE_IMAGE` when deploying an audited
build. Keep the Bun image and lockfile versions synchronized.

## Authentication And Network

Configure either explicit unauthenticated mode on a trusted network or
`GH_MIGRATE_USER` and `GH_MIGRATE_PASS` for the first authenticated startup.
Those values create the first administrator only while the user table is empty;
remove them after confirming that administrator can sign in.
`GH_MIGRATE_SESSION_SECRET` is deprecated and no longer signs sessions. Bind to
`0.0.0.0` only when a firewall or reverse proxy provides the intended boundary.

Behind TLS termination, set `ORIGIN` to the public URL. Configure forwarded
client addressing only when all traffic must pass through one trusted proxy;
otherwise clients could spoof their address and weaken login throttling.

Administrators can add, disable, and reset users from **Manage users**. A reset
produces a temporary password shown once and revokes the user's sessions. If no
administrator can sign in, stop the dashboard and run:

```bash
bun run auth:reset --username <administrator>
```

The command refuses to run while another process holds the data-directory lock.

## Volumes

- `/data` contains SQLite, WAL files, password hashes, live sessions, audit events, and the lifetime instance lock.
- `/archives` contains transient source exports and is shared with exporter containers.

Back up SQLite with an online SQLite backup or a WAL-aware snapshot. Copying
only the main database file while the process is running can omit committed WAL
transactions. Restore the database and associated archives with the dashboard
stopped, then verify `/api/ready` before routing traffic.

Failed sign-in rows are retained for 24 hours. Expired and revoked sessions are
retained for 30 days; audit events are retained indefinitely. Protect database
backups as authentication data even though plaintext passwords and raw session
tokens are never stored.

## Promotion And Rollback

Pin both the candidate and previous image by immutable tag or digest. The
following stopped-volume backup includes SQLite WAL files and archives:

```bash
release_image=registry.example.com/gh-migrate@sha256:replace-me
container=$(docker compose ps -q gh-migrate)
previous_image=$(docker inspect --format '{{.Config.Image}}' "$container")
backup="$PWD/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
chmod 700 "$backup"
printf '%s\n' "$previous_image" > "$backup/previous-image"
cp .env docker-compose.yml "$backup/"

docker compose stop gh-migrate
docker compose run --rm --no-deps --entrypoint sh \
	-v "$backup:/backup" gh-migrate -c \
	'mkdir -p /backup/data /backup/archives && cp -a /data/. /backup/data/ && cp -a /archives/. /backup/archives/'

GH_MIGRATE_IMAGE="$release_image" docker compose up -d --no-build --wait
curl --fail http://127.0.0.1:3000/api/health
curl --fail http://127.0.0.1:3000/api/ready
```

Persist `GH_MIGRATE_IMAGE` in the deployment environment after promotion. To
roll back, stop the candidate, replace both mounted directories from the same
backup, and start the recorded image:

```bash
backup="$PWD/backups/replace-with-backup-directory"
previous_image=$(cat "$backup/previous-image")

docker compose stop gh-migrate
GH_MIGRATE_IMAGE="$previous_image" docker compose run --rm --no-deps --entrypoint sh \
	-v "$backup:/backup:ro" gh-migrate -c \
	'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; find /archives -mindepth 1 -maxdepth 1 -exec rm -rf {} +; cp -a /backup/data/. /data/; cp -a /backup/archives/. /archives/'
GH_MIGRATE_IMAGE="$previous_image" docker compose up -d --no-build --wait
curl --fail http://127.0.0.1:3000/api/ready
```

Restore the backed-up `.env` first if configuration changed with the candidate.
Keep the failed candidate volumes until the rollback has been verified.

## Runtime Security

- Keep source, target, and SSH credentials in the deployment secret store.
- Pin every administrative SSH host key with its SHA-256 fingerprint.
- Restrict access to the container runtime socket and exporter images.
- Retain the default dropped capabilities and bounded exporter resources.
- Keep archives and database volumes off shared untrusted storage.

## Probes And Shutdown

Use `/api/health` for liveness and `/api/ready` for startup/readiness. Readiness
checks SQLite write access and does not pass before schema application and
recovery complete.

Send `SIGTERM` for shutdown. The server stops accepting work, classifies active
migration and profile state, closes SQLite, and releases the instance lock.