# Architecture

The dashboard is a single Bun process serving a SvelteKit application and a
SQLite database. Its server code is split into `core`, `source`, `profile`, and
`migrate` domains with explicit route-level composition.

- [Migration pipeline](#migration-pipeline)
- [Concurrency and recovery](#concurrency-and-recovery)
- [Real-time progress](#real-time-progress)
- [Authentication](#authentication)
- [Persistence](#persistence)
- [Domain boundaries](#domain-boundaries)

## Migration pipeline

The migration manager selects an executor from the source provider and target
platform, persists the request, and submits it to an app-wide FIFO queue.

<!-- BEGIN GENERATED: support-matrix -->
| Source | Target | Executor |
|---|---|---|
| GitHub | GitHub Enterprise Cloud | `github-api` |
| GitHub | GitHub Enterprise Server | Not supported |
| GitLab | GitHub Enterprise Cloud | `gitlab-native` |
| GitLab | GitHub Enterprise Server | `gitlab-ghes` |
| Bitbucket Server | GitHub Enterprise Cloud | `bitbucket-server-native` |
| Bitbucket Server | GitHub Enterprise Server | `bitbucket-server-ghes` |
<!-- END GENERATED: support-matrix -->

<!-- BEGIN GENERATED: migration-lifecycle -->
**Migration states:** `queued`, `pending`, `running`, `cancelling`, `succeeded`, `failed`, `cancelled`, `reconciliation_required`.

**GHEC observation phases:** `QUEUED`, `PENDING_VALIDATION`, `EXPORTING`, `IMPORTING_GIT`, `IMPORTING_METADATA`, `SUCCEEDED`, `FAILED`, `UNKNOWN`.
<!-- END GENERATED: migration-lifecycle -->

Every executor reports the same top-level lifecycle. All GHEC targets use
GitHub's migration GraphQL API to create a migration source and start and monitor
the target import. GitHub sources use the GitHub archive path; a GHEC source
needs no explicit archive URLs, while a GHES source exports archives first.
GitLab and Bitbucket Server use provider-native source exports, upload those
archives through GitHub's archive API, and then start the same repository
migration mutation. The executor IDs identify the source-side strategy.

GHES targets use containerized GitLab or Bitbucket Server exporters plus
`ghe-migrator` instead of the GitHub migration APIs.

For GHEC targets, execution progresses through provider-specific preflight,
archive/export, upload, import start, monitoring, and completion operations.
The final successful observation supplies persisted resource counts so
post-migration indexing lag cannot overwrite them with transient zeroes.

### GHES imports

GitLab and Bitbucket Server can target an administrator-configured GHES
profile. A one-shot exporter writes an archive into the shared archive volume.
The dashboard verifies its hash, transfers it over host-key-pinned SSH, then
runs the prepare, mapping, import, audit, unlock, and cleanup operations.
Exporter containers never receive GHES credentials.

<!-- BEGIN GENERATED: ghes-import-phases -->
**GHES import phases:** `pending`, `exporting`, `archive_ready`, `transferring`, `preparing`, `mapping`, `importing`, `auditing`, `unlocking`, `succeeded`, `failed`, `cancelled`, `reconciliation_required`.
<!-- END GENERATED: ghes-import-phases -->

Ambiguous remote writes are never replayed automatically. An interruption
during prepare, mapping, or import becomes `reconciliation_required` when the
dashboard cannot prove whether the remote operation completed.

## Concurrency and recovery

The manager enforces one app-wide limit of ten executing migrations. Requests
beyond capacity remain durable in `queued` state. When an execution promise
settles, a transactional dequeue claims the oldest recoverable item and starts
it. Batch migrations use the same queue; a batch is durable membership and
identity metadata rather than a second execution mechanism.

On startup, administrator-authenticated queued requests are re-enqueued.
Running GHEC migrations resume from a persisted GitHub migration ID. Native
exports and GHES imports resume only from durable checkpoints whose next action
is safe to repeat. Per-request credentials are never persisted, so work that
depends on them is not crash-recoverable.

The process holds an exclusive lock in its data directory for its lifetime.
This keeps in-memory queue ownership, SQLite state, and recovery decisions
single-writer even when deployment configuration accidentally requests more
than one process.

## Real-time progress

Migration progress is delivered with Server-Sent Events:

- `/api/migrate/[id]/events` streams one migration.
- `/api/migrate/events` streams dashboard-wide activity.

Event IDs are durable SQLite sequence values. Reconnecting clients send a
cursor, receive a bounded replay window, and then subscribe to live events.
Malformed, stale, or future cursors are handled explicitly so reconnects do not
silently skip history.

Profile progress uses `/api/profile/[id]/events`. Profile runs persist terminal
state before publishing their final frame, allowing a reconnect to recover the
result even if it missed the live event.

## Authentication

GitHub source and target credentials are resolved independently. The supported
modes are request PAT, request GitHub App, environment PAT, and environment
GitHub App. Request credentials take precedence only when credential override
is enabled. GitLab and Bitbucket credentials are server-owned.

Optional dashboard authentication uses a signed, expiring session cookie. When
authentication is enabled, the root layout returns only the public
`authEnabled` contract until a valid session is present; operational URLs,
organization names, repository names, and failures are not serialized into an
unauthenticated page response.

## Persistence

SQLite runs in WAL mode with foreign keys enabled. Domain schemas are applied
in dependency-safe order by `src/lib/server/schemas.ts`; startup hooks perform
schema upgrades, interrupted-run recovery, and retention pruning.

<!-- BEGIN GENERATED: durable-tables -->
| Table | Purpose | Notes |
|---|---|---|
| `app_schema_versions` | Per-domain schema versions | Supports idempotent startup upgrades |
| `migrations` | One row per repository migration | Includes batch ID, source provider, native and GitHub checkpoints, state, pipeline step, auth mode, request options, counts, and timestamps |
| `events` | Append-only migration event log | Replayed for SSE catch-up |
| `ghes_import_jobs` | Durable exporter-to-GHES import state | Stores exporter identity, archive path and hash, ghe-migrator GUID, source lock state, phase, and failure reason |
| `migration_batch_items` | Durable batch membership | Enforces unique source and target identities per batch |
| `profile_runs` | Profile lifecycle and rollups | Stores provider, namespace, counters, API calls, timestamps, and terminal failure |
| `profile_repos` | Repository analysis within a profile | Idempotent per run and repository; queried in filtered pages |
| `profile_source_inventories` | Provider-neutral inventory summary | One normalized summary per profile run |
| `profile_source_inventory_projects` | Source inventory projects | Ordered, normalized project rows for paginated access |
| `profile_source_project_profiles` | Provider-specific project profiles | Stores normalized per-project profile payloads keyed to inventory rows |
<!-- END GENERATED: durable-tables -->

There is no separate batch aggregate table. Migrations carry `batch_id`, while
`migration_batch_items` enforces durable source and target identity within a
batch. Profile inventories store metadata separately from ordered project rows
so large profiles can be filtered and paginated without loading one unbounded
JSON payload.

## Domain boundaries

The server layers are:

| Path | Responsibility |
|---|---|
| `src/lib/server/core/` | Database primitives, GitHub auth and clients, sessions, SSE, and shared infrastructure |
| `src/lib/server/source/` | GitLab and Bitbucket clients, discovery, profiling, export, and provider configuration |
| `src/lib/server/profile/` | Provider-neutral assessment lifecycle, analysis, events, and persistence |
| `src/lib/server/migrate/` | Queue, executors, migration runs, events, and persistence |
| `src/lib/server/schemas.ts` | Durable-domain composition root |
| `src/routes/api/` | HTTP validation and cross-domain dependency composition |

`core` cannot import a domain. Sibling domains cannot import one another.
Provider clients and discovery functions are injected into profile services at
the API route boundary. Browser-capable modules cannot import server modules.
The `boundaries` gate enforces these constraints for absolute and relative
imports.

Client-facing provider, migration, and profile contracts live outside
`src/lib/server` so Svelte components can consume them without pulling server
implementations into the browser bundle.

`src/lib/profile/migration-catalog.ts` is the canonical migration-readiness
catalog. Each entry describes a limitation or required follow-up, its severity
and scope, the profiler detector that evaluates it, remediation guidance, and
the supporting GitHub documentation. Profile analysis combines this reference
data with collected source signals; the catalog itself performs no detection.