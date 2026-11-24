# Configuration

Configuration is read from environment variables at process startup. Keep
tokens, private keys, and passwords in the deployment secret store; do not put
them in browser-visible configuration or migration metadata.

Boolean values use `true` or `false`. Byte and timeout limits are positive
integers unless noted otherwise.

## Core

| Variable | Purpose |
|---|---|
| `DATA_DIR` | Directory containing SQLite data and the exclusive instance lock |
| `GH_MIGRATE_USER` | Username used to create the first administrator when no users exist |
| `GH_MIGRATE_PASS` | Password used to create the first administrator when no users exist |
| `GH_MIGRATE_SESSION_SECRET` | Deprecated compatibility setting; accepted but no longer used |
| `GH_MIGRATE_ALLOW_UNAUTHENTICATED` | Explicitly permit operation without dashboard login |
| `GH_MIGRATE_METRICS_TOKEN` | Optional bearer token enabling the Prometheus metrics endpoint; must contain no whitespace |
| `GH_ALLOW_CREDENTIAL_OVERRIDE` | Permit request-scoped GitHub credentials and source URL overrides |
| `MIGRATION_RETENTION_DAYS` | Startup pruning age for terminal migration history; default 90 days, `0` disables age pruning |
| `MIGRATION_RETENTION_ROWS` | Startup pruning limit for terminal migration rows; default 100,000, `0` disables row pruning |
| `PROFILE_RETENTION_DAYS` | Startup pruning age for terminal profile history; default 90 days, `0` disables age pruning |
| `PROFILE_RETENTION_RUNS` | Startup pruning limit for terminal profile runs; default 500, `0` disables run-count pruning |

On the first authenticated startup, configure both bootstrap values. The
dashboard hashes the password with Argon2id and stores the administrator in
SQLite. Later startups use stored users, so the bootstrap values can be removed.
Administrators add operators and other administrators through **Manage users**.

Usernames are case-insensitively unique. New passwords contain 12-128
characters. Sessions are opaque, revocable, limited to five per user, and expire
after seven days. Unauthenticated mode must be explicitly enabled and should be
limited to a trusted network. It cannot be enabled after users have been created.

Migration, profile, failed-login, and expired-session retention is enforced at
process startup. A continuously running process can temporarily retain rows
beyond an age limit until its next restart.

The metrics endpoint is disabled when `GH_MIGRATE_METRICS_TOKEN` is unset or
empty, including in unauthenticated dashboard mode. Use a separate,
cryptographically random token, store it as a secret, and use TLS or a trusted
private network for scrapes. See [API Reference](api.md#prometheus-metrics).

## Runtime And Networking

| Variable | Purpose |
|---|---|
| `PORT` | Adapter-node HTTP port; Compose fixes this to `3000` |
| `GH_MIGRATE_PUBLISH_HOST` | Host address where Compose publishes port 3000; default `127.0.0.1` |
| `ORIGIN` | Exact browser-visible origin, including scheme and port; container/Compose default `http://localhost:3000` |
| `ADDRESS_HEADER` | Trusted proxy header used to resolve the client address |
| `XFF_DEPTH` | Number of trusted proxy hops in the forwarded address chain |

Compose is loopback-only by default. Set `GH_MIGRATE_PUBLISH_HOST=0.0.0.0` only
when a firewall or reverse proxy provides the intended network boundary.
Configure `ADDRESS_HEADER` and `XFF_DEPTH` only when every request passes through
the trusted proxy; login throttling uses the resolved client address.

Set `ORIGIN` for direct HTTP access as well as reverse proxies. For example,
use `http://127.0.0.1:3000` when browsing that address, or
`https://migrate.example.com` behind TLS termination. The hostname, scheme, and
port must match the browser URL; a mismatch rejects login forms and JSON API
writes. Keep origin protection enabled.

## GitHub Source And Target

| Variable | Purpose |
|---|---|
| `GH_SOURCE_API_URL` | Default GitHub source API URL |
| `GH_SOURCE_ORG` | Default GitHub source organization |
| `GH_SOURCE_PAT` | GitHub source personal access token |
| `GH_SOURCE_APP_ID` | GitHub source App ID |
| `GH_SOURCE_APP_PRIVATE_KEY` | GitHub source App private key |
| `GH_SOURCE_APP_INSTALLATION_ID` | GitHub source App installation ID |
| `GH_TARGET_ORG` | Default GitHub target organization |
| `GH_TARGET_PAT` | GitHub target personal access token |
| `GH_TARGET_APP_ID` | GitHub target App ID |
| `GH_TARGET_APP_PRIVATE_KEY` | GitHub target App private key |
| `GH_TARGET_APP_INSTALLATION_ID` | GitHub target App installation ID |
| `GH_ALLOWED_SOURCE_API_URLS` | Allowlist for request-overridden GitHub source API URLs |

For each GitHub side, configure either a PAT or all three App values. GitHub App
credentials are preferred for long-running, crash-recoverable work because
installation tokens can refresh without persisting a request secret.

## Repository Analysis

| Variable | Purpose |
|---|---|
| `ANALYSIS_DIR` | Analyzer-only workspace for temporary repository mirrors; default `/analysis` |
| `ANALYSIS_WORKSPACE_LIMIT_BYTES` | Optional maximum analyzer workspace usage in bytes |
| `ANALYSIS_RUN_ONCE` | Process at most one queued repository when set to `true` |

The analyzer shares `DATA_DIR` with the dashboard to claim durable jobs and
stores temporary mirrors only in `ANALYSIS_DIR`. It removes each mirror after
the repository succeeds or fails.

## GitLab Source

| Variable | Purpose |
|---|---|
| `GITLAB_SOURCE_API_URL` | GitLab base or API URL |
| `GITLAB_SOURCE_PAT` | GitLab access token |
| `GITLAB_SOURCE_USERNAME` | Username supplied to the GitLab exporter |
| `GITLAB_SOURCE_NAMESPACE` | Optional configured namespace scope |
| `GITLAB_SOURCE_MAX_ARCHIVE_BYTES` | Maximum accepted GitLab export size |
| `GITLAB_SOURCE_ARCHIVE_DOWNLOAD_TIMEOUT_MS` | GitLab archive download timeout |

GitLab credentials are server-owned and cannot be overridden by a browser
request.

## Bitbucket Server Source

For a complete GHES deployment, including a working Compose configuration, see
[Bitbucket Data Center to GHES](bitbucket-datacenter-to-ghes.md).

| Variable | Purpose |
|---|---|
| `BITBUCKET_SERVER_URL` | Bitbucket Server/Data Center base URL |
| `BITBUCKET_SERVER_USERNAME` | Bitbucket API username |
| `BITBUCKET_SERVER_PASSWORD` | Bitbucket API password or token |
| `BITBUCKET_SERVER_PROJECT_KEYS` | Project-key allowlist for server-owned migration credentials; set it explicitly to restrict the source scope |
| `PROFILE_CONNECTION_SCOPE` | Optional provider IDs (`bitbucket-server`, `gitlab`, `github`) for credential-wide profiling; migration restrictions remain unchanged |
| `BITBUCKET_SERVER_ALLOW_INSECURE_HTTP` | Allow plain HTTP for an explicitly trusted source |
| `BITBUCKET_SERVER_SSH_HOST` | Administrative SSH host used for archive access |
| `BITBUCKET_SERVER_SSH_PORT` | Administrative SSH port |
| `BITBUCKET_SERVER_SSH_USERNAME` | Administrative SSH username |
| `BITBUCKET_SERVER_SSH_PRIVATE_KEY` | Administrative SSH private key |
| `BITBUCKET_SERVER_SSH_HOST_KEY_SHA256` | Required pinned SHA-256 SSH host key |
| `BITBUCKET_SERVER_SHARED_HOME` | Bitbucket shared-home path on the source host |
| `BITBUCKET_SERVER_MAX_ARCHIVE_BYTES` | Maximum accepted Bitbucket archive size |

Plain HTTP is rejected unless its explicit override is enabled. The Bitbucket
SSH and shared-home settings are for native archive retrieval on **Bitbucket →
GHEC** only. For **Bitbucket → GHES**, the exporter uses Bitbucket HTTP(S)
credentials; SSH and the pinned host key are on the **GHES** side.

## GHES Targets

Only Bitbucket Server migrations can use the GHES target. Configuring a
GitLab exporter does not enable the paused GitLab-to-GHES route.

| Variable | Purpose |
|---|---|
| `GHES_TARGET_ID` | Stable identifier for the configured GHES target profile |
| `GHES_TARGET_NAME` | Operator-facing GHES target name |
| `GHES_TARGET_API_URL` | GHES API URL |
| `GHES_TARGET_ORG` | Comma-separated GHES organization allowlist for server-owned credentials; these organizations also appear in Manage targets |
| `GHES_TARGET_ADMIN_USERNAME` | GHES site-admin login used for `ghe-migrator import` (distinct from the SSH account) |
| `GHES_TARGET_ADMIN_PAT` | PAT for that site admin, issued by the GHES appliance; also used for target API reads |
| `GHES_TARGET_SSH_HOST` | GHES administrative SSH host |
| `GHES_TARGET_SSH_PORT` | GHES administrative SSH port |
| `GHES_TARGET_SSH_USERNAME` | GHES administrative SSH username |
| `GHES_TARGET_SSH_PRIVATE_KEY` | GHES administrative SSH private key |
| `GHES_TARGET_SSH_HOST_KEY_SHA256` | Required pinned SHA-256 SSH host key |
| `GHES_TARGET_REMOTE_DIR` | Remote staging directory for migration archives |

The dashboard currently exposes one configured GHES profile plus the built-in
GHEC target. GHES API and SSH credentials are server-owned and never passed to
exporter containers.

## Exporters And Archives

| Variable | Purpose |
|---|---|
| `ARCHIVE_DIR` | Absolute archive directory visible to the dashboard process; Compose mounts the shared archive volume at `/archives` |
| `EXPORTER_RUNTIME` | Container runtime command for source exporters |
| `EXPORTER_NETWORK` | Container network mode or network name |
| `EXPORTER_MEMORY` | Exporter memory limit |
| `EXPORTER_CPUS` | Exporter CPU limit |
| `EXPORTER_PIDS_LIMIT` | Exporter process-count limit |
| `EXPORTER_TMPFS_SIZE` | Exporter temporary-filesystem size |
| `EXPORTER_ARCHIVE_VOLUME` | Shared archive volume mounted into exporters |
| `GL_EXPORTER_RUNTIME` | Optional GitLab-specific runtime override |
| `GL_EXPORTER_ARCHIVE_VOLUME` | GitLab exporter archive volume |
| `GL_EXPORTER_IMAGE` | GitLab exporter image |
| `BBS_EXPORTER_IMAGE` | Bitbucket exporter image |

Exporter processes run without target credentials. Their network, memory, CPU,
PID, and temporary-storage limits should remain bounded in production.

For Bitbucket-to-GHES, the default `BBS_EXPORTER_IMAGE` is the **local** tag
`gh-migrate/bbs-exporter:1.13.0-validation`. The dashboard does not distribute
the exporter. [Build it from the supplied release tarball](bitbucket-datacenter-to-ghes.md#build-the-exporter-from-the-release-tarball);
no exporter repository access is required. `BBS_EXPORTER_BUILD_CONTEXT` must
point to the **extracted directory containing the exporter's Dockerfile** (Compose
default: `../bbs-exporter-1.13.0`), not the tarball itself. For a deployment host
using a private registry, [pull an approved image by digest](bitbucket-datacenter-to-ghes.md#use-an-approved-prebuilt-image).
[Verify the CLI version](bitbucket-datacenter-to-ghes.md#verify-the-exporter-image)
on the dashboard's Docker daemon before the pilot. No exporter daemon is needed;
the dashboard starts one container per repository.

Only include `compose.exporter.yml` where the dashboard must launch exporter
containers. For a local Bitbucket on the external `bitbucket-local_default`
network, also append `:compose.bitbucket-local.yml` to `COMPOSE_FILE` and set
`EXPORTER_NETWORK=bitbucket-local_default`. Start that Bitbucket project first.
An externally reachable Bitbucket does not need the local network override.
Keep the chosen `COMPOSE_FILE` in the deployment environment for future upgrades.