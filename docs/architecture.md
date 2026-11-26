# Architecture

The supported deployment uses two Bun processes: a SvelteKit dashboard and a
repository-analysis worker. They coordinate through one SQLite database. The
dashboard server code is split into `core`, `source`, `profile`, and `migrate`
domains behind an explicit application composition layer.

- [Migration pipeline](#migration-pipeline)
- [Profile flow](#profile-flow)
- [Mannequin attribution](#mannequin-attribution)
- [Concurrency and recovery](#concurrency-and-recovery)
- [Operational boundaries](#operational-boundaries)
- [Real-time progress](#real-time-progress)
- [Authentication](#authentication)
- [Persistence](#persistence)
- [Domain boundaries](#domain-boundaries)

## Profile flow

Profile runs gather provider inventory and repository signals, persist
normalized results, and evaluate migration readiness. GitHub uses organization
and repository crawls; GitLab and Bitbucket Server use their provider adapters
to discover projects and collect project metrics. The profile domain owns the
run lifecycle and analysis in both cases.

```mermaid
sequenceDiagram
	actor Operator
	participant API as Profile API
	participant Profile as Profile service
	participant Provider as Source provider
	participant DB as SQLite
	participant Events as Profile events

	Operator->>API: Start profile
	API->>Profile: Create running profile
	Profile->>Provider: Discover inventory and collect signals
	loop Projects and repositories
		Provider-->>Profile: Normalized observations
		Profile->>DB: Persist inventory, metrics, and findings
		Profile->>Events: Publish progress
	end
	Profile->>DB: Persist summary and terminal state
	Profile->>Events: Publish terminal frame
	Events-->>Operator: Stream progress and result
```

### Repository analysis

After a GitHub profile completes, the operator can start a separate repository
analysis run. Durable jobs clone each non-empty repository into the analyzer
workspace, collect normalized Git and LFS evidence, and persist immutable
results. The profile page can cancel a run or retry an individual failed job.
Before obtaining credentials, the worker checks the recorded GitHub instance and
repository against the current profile scope. Only the current, unexpired claim
attempt may renew its lease or publish a result or failure. A malformed LFS
inventory fails the analysis rather than recording zero pointers.

The analyzer runs as a separate process with the same `DATA_DIR` and its own
temporary `ANALYSIS_DIR`. GitHub batch creation requires successful analysis
for each selected repository that has profile warnings or blockers; clear
repositories remain eligible without it. GitLab and Bitbucket Server migrations
do not use this gate.

## Migration pipeline

The migration manager selects an executor from the source provider and target
platform, persists the request, and submits it to an app-wide FIFO queue.

Bitbucket, GitLab, and GitHub use separate source-specific executors. Bitbucket
and GitLab clients and exporters stay in their own provider modules; GitHub
source archive operations stay separate from them. The executor registry and
application adapters compose these implementations. Common GHEC import APIs,
GHES import orchestration, target authentication, and resource counts are shared
target infrastructure, not calls into another source provider.

<!-- BEGIN GENERATED: support-matrix -->
| Source | Target | Executor |
|---|---|---|
| GitHub | GitHub Enterprise Cloud | `github-api` |
| GitHub | GitHub Enterprise Server | Not supported |
| GitLab | GitHub Enterprise Cloud | `gitlab-native` |
| GitLab | GitHub Enterprise Server | Not supported |
| Bitbucket Server | GitHub Enterprise Cloud | `bitbucket-server-native` |
| Bitbucket Server | GitHub Enterprise Server | `bitbucket-server-ghes` |
<!-- END GENERATED: support-matrix -->

<!-- BEGIN GENERATED: migration-lifecycle -->
**Migration states:** `queued`, `pending`, `running`, `cancelling`, `succeeded`, `failed`, `cancelled`, `reconciliation_required`.

**GHEC observation phases:** `QUEUED`, `PENDING_VALIDATION`, `EXPORTING`, `IMPORTING_GIT`, `IMPORTING_METADATA`, `SUCCEEDED`, `FAILED`, `UNKNOWN`.
<!-- END GENERATED: migration-lifecycle -->

```mermaid
flowchart LR
	Request[Request persisted] --> Capacity{Slot available?}
	Capacity -->|No| Queued[Queued]
	Queued -->|Slot opens| Pending[Pending]
	Capacity -->|Yes| Pending
	Pending --> Running[Running]
	Running -->|Completed| Succeeded[Succeeded]
	Running -->|Definitive failure| Failed[Failed]
	Running -->|Cancel requested| Cancelling[Cancelling]
	Cancelling -->|Confirmed| Cancelled[Cancelled]
	Cancelling -->|Remote outcome unclear| Review[Needs review]
```

Every executor reports the same top-level lifecycle. All GHEC targets use
GitHub's migration GraphQL API to create a migration source and start and monitor
the target import. GitHub sources use the GitHub archive path; a GHEC source
needs no explicit archive URLs, while a GHES source exports archives first.
GitLab and Bitbucket Server use provider-native source exports, upload those
archives through GitHub's archive API, and then start the same repository
migration mutation. The executor IDs identify the source-side strategy.

GHES targets use a containerized Bitbucket Server exporter plus
`ghe-migrator` instead of the GitHub migration APIs.

For GHEC targets, execution progresses through provider-specific preflight,
archive/export, upload, import start, monitoring, and completion operations.
GHES source export POSTs are not retried after an ambiguous response. A lost
source export acknowledgement, or a target start without a valid migration ID,
requires reconciliation before restart. An explicit rejection of the first
export differs from a gateway timeout or an unreadable success response. Once
GHES acknowledges the Git archive, even a rejection of the metadata export
leaves a partial pair to reconcile. Both export IDs are process-local: an
interruption while polling, transferring, or preparing the target import also
requires review rather than starting another pair. Once a target import ID is
saved, recovery monitors that import instead.
The final successful observation supplies persisted resource counts so
post-migration indexing lag cannot overwrite them with transient zeroes.

### GHES imports

Bitbucket Server can target an administrator-configured GHES
profile. A one-shot exporter writes an archive into the shared archive volume.
The dashboard verifies its hash, transfers it over host-key-pinned SSH, then
runs the prepare, mapping, import, audit, unlock, and cleanup operations.
Once GHES finishes importing the archive, the pipeline shows both Git and
metadata as complete during audit and unlock. Done waits for success.
Exporter containers never receive GHES credentials.

Target remapping can reveal further conflicts, such as an existing team in
the destination organization. The importer rechecks conflicts after each map
and applies the same mapping policy. A team merge requires an approved mapping
to a target team slug; a GHES recommendation is not sufficient.
Repeated unresolved mappings or more than three mapping passes stop for
operator review before import.

After the imported repository is unlocked on GHES, resource counts are read
through the target's REST and GraphQL APIs and persisted with the result.
A count lookup failure is reported without changing the successful import
state. The detail page distinguishes unavailable counts from zero and lets
operators inspect current totals when no completion snapshot exists. The
read validates the stored target against its current profile and timestamps
the observation. It never substitutes it for historical counts.
Count failures report local configuration guidance or target API unavailability;
upstream diagnostics are not copied into the page, logs, or migration events.

<!-- BEGIN GENERATED: ghes-import-phases -->
**GHES import phases:** `pending`, `exporting`, `archive_ready`, `transferring`, `preparing`, `mapping`, `importing`, `auditing`, `unlocking`, `succeeded`, `failed`, `cancelled`, `reconciliation_required`.
<!-- END GENERATED: ghes-import-phases -->

Ambiguous remote writes are never replayed automatically. An interruption
during prepare, mapping, or import becomes `reconciliation_required` when the
dashboard cannot prove whether the remote operation completed.
After import, the saved GUID and audit/unlock phase survive errors and
cancellation. A restart continues finalization on that GUID; it does not
prepare or import the archive again. For a legacy failed job with a GUID but
no trustworthy phase, inspect `ghe-migrator` on the appliance rather than
submitting another import.

## Mannequin attribution

The identity workspace supports configured GHEC and GHES target profiles.
Saved mappings are visible before the page finishes loading. The mapping type
switcher, Add, Import CSV, and Edit enable once their browser handlers are ready;
Remove is a server form and does not require JavaScript.
Dashboard administrators can save mappings manually or import a CSV before accounts and
mannequins exist. Decisions are scoped to the target API, organization, source
type, and exact source identity; unrelated source URLs and mannequin logins are
not automatically equated. Administrators can check user and membership readiness.
GHES imports performed with `ghe-migrator` discover user conflicts over SSH and
apply matching approved URLs after checking target users exist.

For mannequin attribution, the workspace matches IDs or unique logins across
the complete organization list and sends invitations only to active members.
It skips duplicate or ambiguous matches and records invitation attempts and
operator audit events.

Discovery and invitation submission are live GitHub operations, not durable
migration jobs. The dashboard records approved decisions and whether an
invitation was sent or has an uncertain outcome. It shows GitHub's current
claimant when available, but does not poll invitation rejection transitions.
Verify uncertain or rejected invitations in GitHub before taking further action.

## Concurrency and recovery

The manager enforces one app-wide limit of ten executing migrations. Requests
beyond capacity remain durable in `queued` state. When an execution promise
settles, a transactional dequeue claims the oldest recoverable item and starts
it. The configured GHES appliance runs one dashboard migration at a time because
`ghe-migrator` holds an appliance-wide lock. Other GHES requests wait in order,
including single runs and restarts. Cloud work can use the remaining slots.
This does not coordinate imports started outside the dashboard.
Batch migrations use the same queue; a batch is durable membership and
identity metadata rather than a second execution mechanism.

On startup, queued requests using server-owned environment PAT or GitHub App
credentials are re-enqueued. Executing migrations using those credentials can
resume from persisted GitHub, native export, or GHES import checkpoints when
the next action is safe to repeat. Per-request credentials are never persisted,
so work that depends on them is not crash-recoverable.

```mermaid
flowchart TD
	Start[Process starts] --> Lock[Acquire the data-directory lock]
	Lock --> Schema[Apply schemas and classify interrupted work]
	Schema --> Profiles[Mark interrupted profiles failed]
	Schema --> Migration{Interrupted migration}
	Migration -->|Environment auth and safe checkpoint| Resume[Resume the executor]
	Migration -->|Environment auth and queued request| Requeue[Return to the FIFO queue]
	Migration -->|Remote outcome is ambiguous| Review[Require operator reconciliation]
	Migration -->|No recoverable credentials or checkpoint| Fail[Mark failed]
	Resume --> Queue[Migration capacity manager]
	Requeue --> Queue
```

An interrupted profile is retained as failed audit history and must be run
again. A migration enters `reconciliation_required` when repeating a remote
write could duplicate or corrupt work; the operator must inspect the source and
target before confirming it is safe to restart. A saved GHEC import ID means
monitor that import, never submit it again automatically. A native export ID is
only resumable *before* the target-start checkpoint. Without a target ID after
that checkpoint, **Needs review** takes precedence over the export ID.

Immediate, queued, and restarted jobs use the admitted source host and saved
nonsecret options. Restart credentials do not replace those options. If a
legacy GHEC job has no saved plan, review the settings and explicitly choose
target visibility before restarting. For native GHEC jobs, source counts are
unavailable; upgrading clears previously sampled GitHub source counts from
those jobs and their events without changing target counts.

The process holds an exclusive lock in its data directory for its lifetime.
This keeps in-memory queue ownership, SQLite state, and recovery decisions
single-writer even when deployment configuration accidentally requests more
than one process.

## Operational boundaries

| Boundary | Current behavior |
|---|---|
| Source and target support | All three providers can target GHEC. Only Bitbucket Server can target a configured GHES profile. |
| Migration capacity | At most ten migrations execute app-wide. Additional requests remain durable in FIFO order. |
| Batch size | A batch accepts at most 500 repository mappings and uses the same queue as single migrations. |
| Profile capacity | One profile per source provider can run at a time. |
| Source inventory | Provider inventories stop at the provider-neutral 10,000-project envelope. |
| Durable state | Migration requests, states, events, batches, analysis jobs, and acknowledged provider, GitHub, and GHES checkpoints survive a restart. |
| Process-local state | Active controllers, API clients, and request-scoped credentials do not survive a restart. Interrupted profiles are marked failed. |

Provider-specific constraints also apply:

- GitHub sources can target GHEC only.
- GitLab-to-GHEC exports are bounded by archive-size and download-timeout settings.
  GitLab-to-GHES execution is paused. Recovery fails unstarted queued jobs and
  retains jobs with uncertain remote outcomes for operator review without resuming them.
- Bitbucket Server and Data Center discovery enforces the supported server
	version. Native GHEC exports require pinned SFTP access to shared home, while
	GHES migrations require the configured external exporter.

See [Provider Contracts](provider-contracts.md) for collection behavior and
[Configuration](configuration.md) for operator-set bounds and prerequisites.

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

GitHub source and target credentials for migration requests are resolved
independently. The supported migration modes are request PAT, request GitHub
App, environment PAT, and environment GitHub App. Request credentials take
precedence when credential override is enabled, which is the default. Profile
collection, repository analysis, Mannequins, GitLab, and Bitbucket use
server-owned credentials. Server credentials are restricted to their
configured source namespaces and target-profile organizations.

Dashboard users and sessions are stored in SQLite. Passwords use Argon2id.
Browser cookies contain random 32-byte session tokens; only SHA-256 token
digests are persisted. Session resolution in the request hook populates the
authenticated user in request locals, which is the sole downstream identity
source. Disabled users, expired sessions, and revoked sessions are rejected.

Administrators grant access on the user record. Operators share the existing
dashboard, profile reports and migration screens. Their scope is the exact
provider, source instance and namespace paired with a target profile, instance
and organization. A user may have several distinct pairs with independent
permissions; granting a second pair does not imply their cross-product.
The profile planner sends its selected grant ID and repository names, not a
client-provided organization or host. Admission matches the grant to the report;
dispatch and restart recheck current permission on the persisted pair.
Viewing a project does not authorize submitting migrations, and viewing a
migration is not permission to modify another operator's job. Private routes
are denied unless they enforce that scope. Session-scoped responses are not
publicly cacheable. Shared provider credentials never imply access.

User administration, migration commands, profile starts, and
mannequin invitation submissions append durable audit events. Failed sign-ins
are throttled by username/address pair and client address without permanently
locking a user. When authentication is enabled, the root layout returns only
`authEnabled` until a user is resolved, so operational names and failures are
not serialized to unauthenticated clients.

## Persistence

SQLite runs in WAL mode with foreign keys enabled. Domain schemas are applied
in dependency-safe order by `src/lib/server/schemas.ts`; startup hooks perform
schema upgrades, interrupted-run recovery, and retention pruning.

<!-- BEGIN GENERATED: durable-tables -->
| Table | Purpose | Notes |
|---|---|---|
| `app_users` | Dashboard user identities and credentials | Usernames are unique case-insensitively; passwords are stored as Argon2id hashes |
| `app_sessions` | Revocable dashboard sessions | Stores SHA-256 token digests, never raw cookie values |
| `auth_login_attempts` | Persistent sign-in throttling | Bounded failed attempts keyed by username and client address |
| `audit_events` | Authentication and operator action attribution | Stores actors and resources without credentials or session tokens |
| `self_service_routes` | Exact source-to-destination routes available for delegation | Identities include the source provider and instance, not an ephemeral profile run |
| `self_service_grants` | Named operator assignments | Grants inventory access with a separate migration permission |
| `target_organizations` | Administrator-listed migration destinations | Organization logins belong to one target connection and API instance; listing grants no access |
| `app_schema_versions` | Per-domain schema versions | Supports idempotent startup upgrades |
| `migrations` | One row per repository migration | Includes batch ID, source provider, native and GitHub checkpoints, state, pipeline step, auth mode, request options, counts, and timestamps |
| `events` | Append-only migration event log | Replayed for SSE catch-up |
| `ghes_import_jobs` | Durable exporter-to-GHES import state | Stores exporter identity, archive path and hash, ghe-migrator GUID, source lock state, phase, and failure reason |
| `migration_batch_items` | Durable batch membership | Enforces unique source and target identities per batch |
| `migration_identity_mappings` | Approved source-to-target identity decisions | Scoped by target API, organization, source kind, and source identity |
| `profile_queue` | Namespaces awaiting a profile run | One pending entry per provider and namespace; dispatch failures are retained until retried |
| `profile_runs` | Profile lifecycle and rollups | Stores provider, namespace, counters, API calls, timestamps, and terminal failure |
| `profile_repos` | Repository analysis within a profile | Idempotent per run and repository; queried in filtered pages |
| `profile_source_inventories` | Provider-neutral inventory summary | One normalized summary per profile run |
| `profile_source_inventory_projects` | Source inventory projects | Ordered, normalized project rows for paginated access |
| `profile_source_project_profiles` | Provider-specific project profiles | Stores normalized per-project profile payloads keyed to inventory rows |
| `profile_repository_analysis_runs` | Repository analysis lifecycle and rollups | One nonterminal child run per completed GitHub profile |
| `profile_repository_analysis_jobs` | Durable repository analysis queue | One leased job per selected repository and analysis run |
| `profile_repository_analysis_results` | Immutable repository analysis evidence | Normalized Git metrics and bounded artifacts per job attempt |
| `profile_repository_analysis_lfs_pointers` | Historical LFS pointer evidence | Normalized OIDs, sizes, and representative paths per analysis result |
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
| `src/lib/server/application/` | Cross-domain use cases, request policy, startup reporting, and concrete adapters for domain-owned ports |
| `src/lib/server/core/` | Database primitives, GitHub auth and clients, sessions, SSE, and shared infrastructure |
| `src/lib/server/source/` | GitLab and Bitbucket clients, discovery, profiling, export, and provider configuration |
| `src/lib/server/profile/` | Provider-neutral profile lifecycle, analysis, events, and persistence |
| `src/lib/server/migrate/` | Queue, executors, migration runs, events, persistence, and source-runtime port contracts |
| `src/lib/server/schemas.ts` | Durable-domain composition root |
| `src/routes/api/` | HTTP transport that delegates request policy and domain work |

The application layer may compose `core` and all domains. `core` and domains
cannot import the application layer; `core` cannot import a domain; and sibling
domains cannot import one another. Domain-owned ports invert dependencies that
need concrete provider behavior: migration declares the source-runtime
contract, while `application/adapters` implements it using the source domain.
Provider clients and discovery functions are injected into profile services at
the API route boundary. `schemas.ts` is the separate persistence composition
root.

Every production module under `src/lib/server/` must belong to one of these
classified layers. Browser-capable modules cannot import server modules. The
`boundaries` gate enforces these constraints for absolute and relative imports.
It also rejects cross-provider imports between source clients, exporters, and
executors, while allowing shared target protocols and composition modules.

Client-facing provider, migration, and profile contracts live outside
`src/lib/server` so Svelte components can consume them without pulling server
implementations into the browser bundle.

`src/lib/profile/migration-catalog.ts` is the canonical migration-readiness
catalog. Each entry describes a limitation or required follow-up, its severity
and scope, the profiler detector that evaluates it, remediation guidance, and
the supporting GitHub documentation. Profile analysis combines this reference
data with collected source signals; the catalog itself performs no detection.