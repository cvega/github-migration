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
| `GH_ALLOW_CREDENTIAL_OVERRIDE` | Permit request-scoped GitHub credentials and source URL overrides |
| `MIGRATION_RETENTION_DAYS` | Maximum age of terminal migration history |
| `MIGRATION_RETENTION_ROWS` | Maximum retained terminal migration rows |
| `PROFILE_RETENTION_DAYS` | Maximum age of terminal profile history |
| `PROFILE_RETENTION_RUNS` | Maximum retained terminal profile runs |

On the first authenticated startup, configure both bootstrap values. The
dashboard hashes the password with Argon2id and stores the administrator in
SQLite. Later startups use stored users, so the bootstrap values can be removed.
Administrators add operators and other administrators through **Manage users**.

Usernames are case-insensitively unique. New passwords contain 12-128
characters. Sessions are opaque, revocable, limited to five per user, and expire
after seven days. Unauthenticated mode must be explicitly enabled and should be
limited to a trusted network. It cannot be enabled after users have been created.

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

| Variable | Purpose |
|---|---|
| `BITBUCKET_SERVER_URL` | Bitbucket Server/Data Center base URL |
| `BITBUCKET_SERVER_USERNAME` | Bitbucket API username |
| `BITBUCKET_SERVER_PASSWORD` | Bitbucket API password or token |
| `BITBUCKET_SERVER_PROJECT_KEYS` | Optional comma-separated project scope |
| `BITBUCKET_SERVER_ALLOW_INSECURE_HTTP` | Allow plain HTTP for an explicitly trusted source |
| `BITBUCKET_SERVER_SSH_HOST` | Administrative SSH host used for archive access |
| `BITBUCKET_SERVER_SSH_PORT` | Administrative SSH port |
| `BITBUCKET_SERVER_SSH_USERNAME` | Administrative SSH username |
| `BITBUCKET_SERVER_SSH_PRIVATE_KEY` | Administrative SSH private key |
| `BITBUCKET_SERVER_SSH_HOST_KEY_SHA256` | Required pinned SHA-256 SSH host key |
| `BITBUCKET_SERVER_SHARED_HOME` | Bitbucket shared-home path on the source host |
| `BITBUCKET_SERVER_MAX_ARCHIVE_BYTES` | Maximum accepted Bitbucket archive size |

Plain HTTP is rejected unless its explicit override is enabled. SSH transfers
require a pinned host key.

## GHES Targets

| Variable | Purpose |
|---|---|
| `GHES_TARGET_ID` | Stable identifier for the configured GHES target profile |
| `GHES_TARGET_NAME` | Operator-facing GHES target name |
| `GHES_TARGET_API_URL` | GHES API URL |
| `GHES_TARGET_ORG` | Default target organization |
| `GHES_TARGET_ADMIN_USERNAME` | GHES administrative API username |
| `GHES_TARGET_ADMIN_PAT` | GHES administrative API token |
| `GHES_TARGET_SSH_HOST` | GHES administrative SSH host |
| `GHES_TARGET_SSH_PORT` | GHES administrative SSH port |
| `GHES_TARGET_SSH_USERNAME` | GHES administrative SSH username |
| `GHES_TARGET_SSH_PRIVATE_KEY` | GHES administrative SSH private key |
| `GHES_TARGET_SSH_HOST_KEY_SHA256` | Required pinned SHA-256 SSH host key |
| `GHES_TARGET_REMOTE_DIR` | Remote staging directory for migration archives |

The dashboard currently exposes one configured GHES profile plus the built-in
GHEC target. GHES API and SSH credentials stay in the dashboard process and are
never passed to exporter containers.

## Exporters And Archives

| Variable | Purpose |
|---|---|
| `ARCHIVE_DIR` | Host-visible archive working directory |
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