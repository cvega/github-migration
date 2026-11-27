# Deployment

The supported production topology has two long-running services: one dashboard
and one profile analyzer. They coordinate repository analysis through the same
SQLite database in `/data`; the analyzer performs Git clones and tooling in its
private `/analysis` workspace. Do not scale either service horizontally. The
dashboard rejects a second instance through its data-directory lock, and the
supported analyzer concurrency is one worker.

## Container Deployment

For **Bitbucket Data Center → GHES**, use the [first deployment walkthrough](bitbucket-datacenter-to-ghes.md).
It configures authenticated access, the external exporter, its archive volume,
and the appliance **before** starting the stack. For a fresh base deployment,
create a private environment file first:

```bash
umask 077
test ! -e .env && cp .env.example .env
```

For a shared deployment, set `GH_MIGRATE_ALLOW_UNAUTHENTICATED=false`, supply
both first-administrator bootstrap values, and set the browser `ORIGIN` in
`.env` before starting either service:

```bash
docker compose up -d --build --wait
```

Compose publishes the dashboard on `127.0.0.1:3000` by default. The dashboard
mounts the shared data volume and archive volume. The base stack needs neither
a container runtime socket nor an external source network. For deployments
that launch exporters, add the [provider override](#compose-file-layout).
The profile analyzer
mounts the same data volume plus its own analysis workspace. Both images run as
a non-root application user after the entrypoint fixes mounted-directory
ownership.

The main and release workflows publish the explicit `dashboard` Docker target.
Compose builds the separate `profile-analyzer` target from the same source
revision; the publishing workflows do not publish an analyzer image.

The reusable verification workflow builds and scans both production images.
It checks authenticated login, same-origin JSON validation, cross-origin
rejection, SQLite backup and paired archive restore, and analyzer startup. It
also starts base Compose without a local Bitbucket network or Docker socket;
only the optional exporter override mounts the socket. See the
[exporter configuration](configuration.md) before upgrading an existing
Bitbucket deployment.

Use immutable release tags or digests through `GH_MIGRATE_IMAGE` and
`GH_MIGRATE_ANALYZER_IMAGE` when deploying an audited build. Build both from the
same source revision, and do not use `latest` or another floating tag in
production. Keep the Bun image and lockfile versions synchronized.

### Compose file layout

Run Compose from the checkout root, with [docker-compose.yml](../docker-compose.yml)
first. It builds the dashboard and profile analyzer from the root [Dockerfile](../Dockerfile).
Choose additional files only for the source you use:

| Directory | Exporter override | Local-network override |
|---|---|---|
| [deploy/bitbucket/](../deploy/bitbucket/) | [compose.bitbucket-exporter.yml](../deploy/bitbucket/compose.bitbucket-exporter.yml) | [compose.bitbucket-local.yml](../deploy/bitbucket/compose.bitbucket-local.yml) |
| [deploy/gitlab/](../deploy/gitlab/) | [compose.gitlab-exporter.yml](../deploy/gitlab/compose.gitlab-exporter.yml) | [compose.gitlab-local.yml](../deploy/gitlab/compose.gitlab-local.yml) |

Each directory also contains its exporter's Dockerfile. The exporter override
lets the dashboard launch a container per repository; the `-local` override only
connects the dashboard to a test server's existing Docker network. Omit `-local`
for an externally reachable source. Keep the private source directory or tarball
**outside** the checkout and pass its path to the [build helper](configuration.md#build-from-a-private-release-path).

**Upgrading from root-level overrides:** update the paths in `.env`'s `COMPOSE_FILE`,
shell scripts and `-f` arguments before your next Compose command. Prefix each
provider override with `deploy/bitbucket/` or `deploy/gitlab/`. If you used the
shared `compose.exporter.yml`, use [deploy/compose.exporter.yml](../deploy/compose.exporter.yml)
to keep the original service names, profiles and image tags. For example, an
existing local Bitbucket deployment using that shared override becomes:

```dotenv
COMPOSE_FILE=docker-compose.yml:deploy/compose.exporter.yml:deploy/bitbucket/compose.bitbucket-local.yml
```

Keep the same Compose project name and volumes. Run `docker compose config --quiet`
to validate the new paths without starting anything. A path change alone does
not require rebuilding images or restarting a running deployment.

## Authentication And Network

Configure either explicit unauthenticated mode on a trusted network or
`GH_MIGRATE_USER` and `GH_MIGRATE_PASS` for the first authenticated startup.
Those values create the first administrator only while the user table is empty;
remove them after confirming that administrator can sign in.
`GH_MIGRATE_SESSION_SECRET` is deprecated and no longer signs sessions. Compose
publishes to loopback by default; set `GH_MIGRATE_PUBLISH_HOST=0.0.0.0` only when
a firewall or reverse proxy provides the intended boundary.

Containers default `ORIGIN` to `http://localhost:3000`. Set it to the exact
browser-visible origin for any other hostname, IP, port, or HTTPS deployment.
This is required for direct HTTP access as well as TLS termination; a mismatch
rejects login forms and JSON API writes. Configure forwarded
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

Pin the previous and candidate dashboard **and analyzer** images by digest.
Block admission/traffic during promotion, drain active jobs, and resolve
**Needs review** before taking the rollback snapshot. Record the current image
digests, volume names, Compose project/overrides and protected configuration
alongside it. Stop both services; a health probe is not a quiescence check.
Run the following in a fail-fast shell from the repository root:

```bash
set -eu
umask 077
backup="$PWD/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$PWD/backups"
mkdir "$backup"
helper="$PWD/scripts/packaging/volume-snapshot.sh"
docker compose stop gh-migrate profile-analyzer
docker compose run --rm --no-deps --entrypoint sh \
	-v "$helper:/snapshot.sh:ro" -v "$backup:/backup" gh-migrate \
	/snapshot.sh backup /backup/snapshot /data /archives
```

Switch both image variables to the candidate and run `docker compose up -d
--no-build --wait`. Keep admission closed while verifying readiness and deciding
whether to promote. Keep the protected snapshot outside the live volumes.

**Rollback is a switch, not an overwrite.** Stop both candidate services; keep
their volumes and configuration. With the **candidate volume settings still
active**, compare current jobs and GHES checkpoints with the backup. If history
changed, an exporter is still running, the target has work not accounted for,
or users/grants/config changed, stop: reconcile those changes against the
candidate and providers before allowing traffic or starting workers. Never
rerun a migration just because it is absent from the backup.

```bash
set -eu
: "${backup:?Set the trusted backup directory}" "${previous_image:?Set recorded dashboard digest}" \
  "${previous_analyzer_image:?Set recorded analyzer digest}"
helper="$PWD/scripts/packaging/volume-snapshot.sh"
docker compose stop gh-migrate profile-analyzer
docker compose run --rm --no-deps --entrypoint sh \
	-v "$helper:/snapshot.sh:ro" -v "$backup:/backup:ro" gh-migrate \
	/snapshot.sh check-current /backup/snapshot /data

# Unique new volumes for this restore; never pass current volume names.
restore="gh-migrate-restore-$(date -u +%Y%m%dT%H%M%SZ)"
export GH_MIGRATE_DATA_VOLUME="$restore-data" EXPORTER_ARCHIVE_VOLUME="$restore-archives"
export GH_MIGRATE_ANALYSIS_VOLUME="$restore-analysis"
export GH_MIGRATE_IMAGE="$previous_image" GH_MIGRATE_ANALYZER_IMAGE="$previous_analyzer_image"
docker compose run --rm --no-deps --entrypoint sh \
	-v "$helper:/snapshot.sh:ro" -v "$backup:/backup:ro" gh-migrate \
	/snapshot.sh restore /backup/snapshot /data /archives
# Only after checks pass and outstanding remote work has been reconciled:
docker compose up -d --no-build --wait
curl --fail http://127.0.0.1:3000/api/ready
```

Persist the selected images, volume names and overrides before reopening
traffic. Verify both services use the restored database and exporters use the
restored archive volume. Keep the candidate volumes until rollback is verified.
If any check fails, leave workers stopped; do not clear or reuse either set.

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

Use the dashboard's `/api/health` for dashboard liveness and `/api/ready` for
dashboard startup/readiness. Dashboard readiness checks SQLite write access
after schema application and recovery complete. Monitor the analyzer service
separately with `docker compose ps profile-analyzer`. Compose inherits its
image health check, which uses the analyzer's private loopback listener on
`ANALYSIS_HEALTH_PORT` (default `3001`) without publishing a port.

The analyzer reports healthy after a successful empty queue poll or after
starting an analysis phase. Idle polls refresh the signal every second, with
a 30-second deadline. Workspace preparation (including source authentication)
and cleanup each have 15 minutes. The clone and inspection phases each have
the six-hour command timeout plus one minute for the command to unwind.
Lease renewals alone do not refresh the signal. These deadlines measure
phase progress and can flag a stalled phase even while the process responds.
Individual repository failures appear in their analysis jobs.

Docker probes every 15 seconds with a five-second timeout, a 30-second startup
grace period, and three consecutive failures before marking the container
unhealthy. A subsequent successful probe restores healthy status. One-shot
runs exit after processing at most one job and do not start the listener.
See [Repository Analysis Does Not Advance](troubleshooting.md#repository-analysis-does-not-advance)
for inspection and recovery.

Send `SIGTERM` to both services for shutdown. The dashboard stops accepting
work, classifies active migration and profile state, closes SQLite, and releases
the instance lock. The analyzer stops claiming new jobs after its current
repository command returns, then cleans that job's workspace and closes SQLite.
Its shutdown signal does not currently interrupt an active Git command. A job
whose lease expires after an ungraceful analyzer exit is eligible to be claimed
again.
