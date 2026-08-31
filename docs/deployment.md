# Deployment

The supported production topology has two long-running services: one dashboard
and one profile analyzer. They coordinate repository analysis through the same
SQLite database in `/data`; the analyzer performs Git clones and tooling in its
private `/analysis` workspace. Do not scale either service horizontally. The
dashboard rejects a second instance through its data-directory lock, and the
supported analyzer concurrency is one worker.

## Container Deployment

```bash
cp .env.example .env
docker compose up -d --build --wait
```

Compose publishes the dashboard on `127.0.0.1:3000` by default. The dashboard
mounts the shared data volume and archive volume and exposes the container
runtime socket for bounded one-shot source exporters. The profile analyzer
mounts the same data volume plus its own analysis workspace. Both images run as
a non-root application user after the entrypoint fixes mounted-directory
ownership.

Use immutable release tags or digests through `GH_MIGRATE_IMAGE` and
`GH_MIGRATE_ANALYZER_IMAGE` when deploying an audited build. Build both from the
same source revision, and do not use `latest` or another floating tag in
production. Keep the Bun image and lockfile versions synchronized.

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
- `/analysis` belongs only to the profile analyzer and contains transient mirror clones and tool workspaces.

Back up SQLite with an online SQLite backup or a WAL-aware snapshot. Copying
only the main database file while the process is running can omit committed WAL
transactions. For a stopped-volume backup, stop both services so the analyzer
cannot write queue results while `/data` is copied. Restore the database and
associated archives with both services stopped, then verify `/api/ready` before
routing traffic. Do not back up or restore `/analysis`; interrupted work is
reclaimed through job leases and cloned again.

At process startup, failed sign-in rows older than 24 hours and expired or
revoked sessions older than 30 days are pruned. A continuously running process
can retain older rows until its next restart. Audit events are retained
indefinitely. Protect database backups as authentication data even though
plaintext passwords and raw session tokens are never stored.

## Promotion And Rollback

Pin both the candidate and previous image by immutable tag or digest. The
following stopped-volume backup includes SQLite WAL files and archives:

```bash
release_image=registry.example.com/gh-migrate@sha256:replace-me
analyzer_image=registry.example.com/gh-migrate-profile-analyzer@sha256:replace-me
dashboard_container=$(docker compose ps -q gh-migrate)
analyzer_container=$(docker compose ps -q profile-analyzer)
previous_image=$(docker inspect --format '{{.Config.Image}}' "$dashboard_container")
previous_analyzer_image=$(docker inspect --format '{{.Config.Image}}' "$analyzer_container")
backup="$PWD/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
chmod 700 "$backup"
printf '%s\n' "$previous_image" > "$backup/previous-image"
printf '%s\n' "$previous_analyzer_image" > "$backup/previous-analyzer-image"
cp .env docker-compose.yml "$backup/"

docker compose stop gh-migrate profile-analyzer
docker compose run --rm --no-deps --entrypoint sh \
	-v "$backup:/backup" gh-migrate -c \
	'mkdir -p /backup/data /backup/archives && cp -a /data/. /backup/data/ && cp -a /archives/. /backup/archives/'

GH_MIGRATE_IMAGE="$release_image" GH_MIGRATE_ANALYZER_IMAGE="$analyzer_image" \
	docker compose up -d --no-build --wait
curl --fail http://127.0.0.1:3000/api/health
curl --fail http://127.0.0.1:3000/api/ready
```

Persist both image variables in the deployment environment after promotion. To
roll back, stop the candidate services, replace the durable mounted directories
from the same backup, clear the disposable analysis workspace, and start the
recorded images:

```bash
backup="$PWD/backups/replace-with-backup-directory"
previous_image=$(cat "$backup/previous-image")
previous_analyzer_image=$(cat "$backup/previous-analyzer-image")

docker compose stop gh-migrate profile-analyzer
GH_MIGRATE_IMAGE="$previous_image" docker compose run --rm --no-deps --entrypoint sh \
	-v "$backup:/backup:ro" gh-migrate -c \
	'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; find /archives -mindepth 1 -maxdepth 1 -exec rm -rf {} +; cp -a /backup/data/. /data/; cp -a /backup/archives/. /archives/'
GH_MIGRATE_ANALYZER_IMAGE="$previous_analyzer_image" docker compose run --rm --no-deps --entrypoint sh \
	profile-analyzer -c 'find /analysis -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
GH_MIGRATE_IMAGE="$previous_image" GH_MIGRATE_ANALYZER_IMAGE="$previous_analyzer_image" \
	docker compose up -d --no-build --wait
curl --fail http://127.0.0.1:3000/api/ready
```

Restore the backed-up `.env` first if configuration changed with the candidate.
Keep the failed candidate volumes until the rollback has been verified.

## Runtime Security

- Keep source, target, and SSH credentials in the deployment secret store.
- Pin every administrative SSH host key with its SHA-256 fingerprint.
- Restrict access to the container runtime socket and exporter images.
- Retain the default dropped capabilities and bounded exporter resources.
- Keep archives off shared untrusted storage and keep `DATA_DIR` on storage
	with reliable POSIX locking; SQLite WAL is not supported on filesystems that
	do not provide it.
- Size the analyzer's private workspace for the configured
	`ANALYSIS_WORKSPACE_LIMIT_BYTES`; never share `/analysis` with the dashboard
	or source exporter containers.

## Probes And Shutdown

Use `/api/health` for liveness and `/api/ready` for startup/readiness. Readiness
checks SQLite write access and does not pass before schema application and
recovery complete.

Send `SIGTERM` to both services for shutdown. The dashboard stops accepting
work, classifies active migration and profile state, closes SQLite, and releases
the instance lock. The analyzer stops claiming jobs, lets its active command
observe cancellation, cleans that job's workspace, and closes SQLite. A job
whose lease expires after an ungraceful analyzer exit is eligible to be claimed
again.