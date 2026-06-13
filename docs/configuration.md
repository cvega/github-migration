# Configuration

Everything is configured via environment variables. The canonical list lives in
[.env.example](../.env.example); this page explains each group. All variables
are optional unless noted — the app runs with zero configuration (no auth, no
env credentials), and credentials can instead be supplied per request in the UI.

- [Core](#core)
- [Authentication — PATs](#authentication--pats)
- [Authentication — GitHub App](#authentication--github-app)
- [Source & form defaults](#source--form-defaults)
- [Credential override](#credential-override)
- [Stall watchdog](#stall-watchdog-optional)
- [Target cleanup](#target-cleanup-optional)
- [Custom logo](#custom-logo-optional)

---

## Core

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `DATA_DIR` | `./data` | SQLite database directory |
| `ARCHIVE_DIR` | OS temp | Temp directory for GHES archive exports |
| `GH_MIGRATE_USER` | — | Basic-auth username (if unset, no auth) |
| `GH_MIGRATE_PASS` | — | Basic-auth password (if unset, no auth) |
| `ORIGIN` | — | Public URL (e.g. `https://migrate.example.com`). Set **only** when running behind a TLS-terminating reverse proxy, so CSRF origin checks on the login form match the browser's `Origin` header. |

When both `GH_MIGRATE_USER` and `GH_MIGRATE_PASS` are set, the UI requires
login (HMAC-signed session cookie, timing-safe credential check, rate-limited).
If either is unset the app is open to anyone who can reach it.

---

## Authentication — PATs

Configure env PATs to avoid passing credentials per request. These migrations
are **crash-recoverable**.

| Variable | Description |
|---|---|
| `GH_SOURCE_PAT` | Source PAT (GHES or GHEC) |
| `GH_TARGET_PAT` | Target PAT (GHEC) |

---

## Authentication — GitHub App

Configure a GitHub App for auto-refreshing installation tokens (no 60-minute
expiry). These migrations are **crash-recoverable**.

**Source** (GHES or GHEC):

| Variable | Description |
|---|---|
| `GH_SOURCE_APP_ID` | App ID |
| `GH_SOURCE_APP_PRIVATE_KEY` | PEM key (literal or base64-encoded) |
| `GH_SOURCE_APP_INSTALLATION_ID` | Installation ID |

**Target** (GHEC):

| Variable | Description |
|---|---|
| `GH_TARGET_APP_ID` | App ID |
| `GH_TARGET_APP_PRIVATE_KEY` | PEM key (literal or base64-encoded) |
| `GH_TARGET_APP_INSTALLATION_ID` | Installation ID |

Per-request PATs or App credentials always take precedence over env-configured
auth. See [Architecture → Authentication modes](architecture.md#authentication-modes)
for the resolution order.

---

## Source & form defaults

These pre-fill the new-migration form so operators can hand the tool to others
with sensible defaults.

| Variable | Default | Description |
|---|---|---|
| `GH_SOURCE_API_URL` | `https://api.github.com` | Source instance API URL (GHES). Applies to both PAT and App auth, and pre-fills the form's Source API URL. |
| `GH_SOURCE_ORG` | — | Pre-configured source org(s), comma/space-separated. Renders as a dropdown; a single value pre-selects it. With a source org set, batch entries may be bare repo names (the org is prepended). |
| `GH_TARGET_ORG` | — | Pre-configured target org(s), comma/space-separated. |

---

## Credential override

| Variable | Default | Description |
|---|---|---|
| `GH_ALLOW_CREDENTIAL_OVERRIDE` | `true` | Whether the UI may let a user override the server's configured credentials with their own PAT/App. Set to `false` (or `0`/`no`/`off`) to **lock** migrations to the server credentials. |

When locked, the new-migration form and restart modals show "Authenticated
using the server's configured credentials" with no override option, and the
pre-configured Source API URL and org dropdowns are locked to their set values.
A side that has **no** env credentials always requires user-supplied auth,
regardless of this flag.

---

## Stall watchdog (optional)

Guards against migrations that hang in an in-progress state without ever
failing. See [Architecture → The stall watchdog](architecture.md#the-stall-watchdog)
for behavior. A repo is "large" (never auto-restarted) if **any** dimension
meets or exceeds its cap.

| Variable | Default | Description |
|---|---|---|
| `WATCHDOG_ENABLED` | `true` | Master switch (`true`/`1` to enable) |
| `WATCHDOG_STALL_MINUTES` | `30` | No-progress window before a migration is considered stalled |
| `WATCHDOG_MAX_RESTARTS` | `1` | Auto-restarts before giving up and marking the migration `failed` |
| `WATCHDOG_MAX_SIZE_MB` | `100` | Disk-size cap — at or above this, a repo is "large" |
| `WATCHDOG_MAX_COMMITS` | `50000` | Commit-count cap |
| `WATCHDOG_MAX_ISSUES` | `5000` | Issue-count cap |
| `WATCHDOG_MAX_PRS` | `5000` | Pull-request-count cap |

---

## Target cleanup (optional, off by default)

When a migration fails *after* GitHub created the target repo, a restart hits a
422 (the name is taken). This feature lets an operator rename that repo aside
(reversible) or delete it (irreversible) so the migration can be re-run — but
**only** for a repo this tool created, proven by a multi-vector identity check,
never one that pre-existed.

| Variable | Default | Description |
|---|---|---|
| `TARGET_CLEANUP` | `off` | `off` · `rename` · `delete` (`delete` also permits rename) |
| `GH_TARGET_ADMIN_PAT` | — | Dedicated PAT with `Administration: write` — **required** to enable; never the migration token |
| `TARGET_CLEANUP_DISABLED` | `false` | Hard kill switch — `true` forces cleanup off regardless of the above (org-policy override) |

A target is eligible only when **all** hold: cleanup enabled and not killed ·
the action is permitted by the mode · the migration is `failed`/`cancelled` ·
the target did **not** pre-exist · the live repo's immutable `node_id` still
matches the one recorded at creation · owner/name still match · the repo was
created within the migration's run window · the typed confirmation matches. Any
mismatch refuses. A confirmation modal shows every gate's pass/fail before any
action, and every action and refusal is recorded in the migration's event log.

---

## Custom logo (optional)

Drop a logo file into `static/imgs/` and the dashboard header displays it
automatically — no configuration needed. The first match wins, in this order:

1. `logo.svg`
2. `logo.webp`
3. `logo.png`

If none are present, no logo is shown. In Docker, mount your file to
`/app/static/imgs/logo.svg` (or `.webp`/`.png`).

A ready-to-edit [docker-compose.yml](../docker-compose.yml) and
[.env.example](../.env.example) cover all of the above.
