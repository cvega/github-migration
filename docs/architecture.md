# Architecture

How the GitHub Migration Dashboard is put together: the migration pipeline, the
concurrency model, authentication, the GHES/GHEC classification rules, and the
data store.

- [Migration pipeline](#migration-pipeline)
- [Concurrency & the queue](#concurrency--the-queue)
- [Real-time progress (SSE)](#real-time-progress-sse)
- [Authentication modes](#authentication-modes)
- [GHES vs GHEC classification](#ghes-vs-ghec-classification)
- [The stall watchdog](#the-stall-watchdog)
- [Crash recovery](#crash-recovery)
- [Database](#database)
- [Project structure](#project-structure)

---

## Migration pipeline

Each repository migration runs through a five-step pipeline, driven by a
concurrency-limited queue. State and lifecycle:

```
queued → pending → running → succeeded | failed | cancelled
```

The `running` state spans the pipeline's internal steps:

```
preflight → archiving → ghec_starting → monitoring → completion
```

1. **Preflight** — validates the GHES version (≥ 3.15), confirms target-org
   access, and warns if the target repo already exists. For a GHEC → GHEC
   source these checks are skipped (no archive export is needed).
2. **Archiving** (GHES sources only) — triggers the git + metadata archive
   exports on the source, then downloads them to `ARCHIVE_DIR`. Both exports are
   kicked off together by a shared helper and awaited in parallel.
3. **GHEC starting** — uploads the archives to GitHub storage (streaming
   multipart for large files, to keep peak memory to a single archive), then
   calls `startRepositoryMigration` over the GraphQL API.
4. **Monitoring** — polls the GHEC migration status, detects phase transitions,
   and computes per-resource progress deltas (commits, issues, PRs, …).
5. **Completion** — records the final resource counts, elapsed time, and the
   migration log URL.

**Direct passthrough** is a variant that skips the download/upload round-trip
and hands the source archive URLs straight to GHEC — faster, but only viable
when GHEC can reach the source.

### A note on final counts

The monitor returns the resource counts captured from the **final `SUCCEEDED`
snapshot**, and the finalize step prefers those over a fresh re-fetch. This is
deliberate: a re-fetch immediately after success races GHEC's post-migration
indexing lag, which can transiently report `0` issues/PRs while git data is
already correct — persisting wrong totals. Using the success snapshot keeps the
stored counts consistent with the "Migration succeeded — N issues" log line.

---

## Concurrency & the queue

GitHub allows **up to** 10 concurrent migrations per organization. The manager
enforces this with `MAX_CONCURRENT = 10` and a FIFO queue:

- `start()` claims a slot if one is free, otherwise the migration is accepted
  and **queued** (state `queued`) — requests are never rejected for capacity.
- When a running migration reaches a terminal state, `drainQueue()` promotes the
  oldest queued migration. The check-capacity → dequeue → transition sequence
  runs inside a single SQLite transaction so two concurrent drains can't both
  claim the last slot.
- A batch is just N individual migrations sharing a `batch_id`; `startBatch()`
  calls `start()` per repo, so over-cap batch members queue like any other.

The "up to 10" ceiling is not a guarantee — GitHub-side load and throttling can
make the effective limit lower, which is why queuing (rather than rejecting) is
the right model.

---

## Real-time progress (SSE)

Progress reaches the browser over **Server-Sent Events**. There are two streams:

- **Per-migration** — `/api/migrations/:id/events`, used by the detail page.
- **Global** — `/api/events`, used by the dashboard to update all cards at once.

The client transport (`$lib/stores/sse-client.ts`) is a framework-agnostic
reconnecting `EventSource` wrapper with capped exponential backoff (1s → 30s,
≤ 20 attempts) and jitter. The two reactive stores supply the URL and a message
handler; the transport owns the connection lifecycle. Keeping it rune-free makes
the reconnect logic unit-testable.

---

## Authentication modes

Source and target authenticate independently. Four modes:

| Mode | Source | Credentials | Crash-recoverable |
|---|---|---|---|
| `request-pat` | Per request | User-provided PAT | No |
| `request-app` | Per request | User-provided App ID / key / installation | No |
| `env-app` | Environment | `GH_*_APP_*` env vars | Yes |
| `env-pat` | Environment | `GH_*_PAT` env vars | Yes |

**Resolution priority** (per side): per-request PAT → per-request App → env App
→ env PAT → error. GitHub App credentials produce **auto-refreshing**
installation tokens, so long-running migrations don't hit the 60-minute PAT
expiry. Only env-configured migrations are crash-recoverable, because
per-request credentials are never persisted.

There is one env-level source configuration, but each migration request can
override the source API URL and supply its own one-off credentials — so a single
instance can migrate from many different sources side by side. See
[Configuration](configuration.md) for the credential-override controls.

---

## GHES vs GHEC classification

The tool must decide whether a source is GitHub Enterprise **Server** (needs
archive export) or **Cloud** (doesn't). The rule:

> **Cloud** = the source URL contains `github.com` **or** `ghe.com` (including
> data-residency tenants like `api.<tenant>.ghe.com`). Everything else is
> **Server**. GHEC can be a source or a target; GHES is source-only (the target
> is always GHEC).

There are **two classifiers that must stay in sync**:

- **Display** — `migration-display.ts#isGitHubCloud` (substring match) drives the
  platform pill, the stats "Migration Direction" buckets, and the SQL in the
  stats query.
- **Server/pipeline** — `github.ts#isCloudApiUrl` (hostname-based) drives
  `isGhecSource()` (skips the GHES version check + archive export for cloud) and
  `normalizeApiUrl()` (cloud never gets an `/api/v3` suffix).

A stricter `isGitHubDotCom` (github.com only) is used by `sourceBaseUrl` to map
the API host back to its web host.

---

## The stall watchdog

A migration occasionally hangs in an in-progress state for hours without ever
failing, tying up one of the 10 slots. The optional watchdog guards against this.
It acts **only** on migrations that have started importing (GHEC reports
`IN_PROGRESS`) and have made **zero forward progress** for the stall window. It
restarts them up to `WATCHDOG_MAX_RESTARTS` times, then marks them `failed` for
manual review.

**Large repositories are never auto-restarted** — they legitimately take a long
time. "Large" is a composite: a repo is large if **any** dimension (disk size,
commits, issues, or PRs) meets or exceeds its cap. A 3 KB repo with 10k issues
is still large. See [Configuration → Stall Watchdog](configuration.md#stall-watchdog-optional)
for the caps.

---

## Crash recovery

On startup the server reconnects to in-flight migrations that survived a
restart. Only `env-app` / `env-pat` migrations **with a GHEC migration ID** are
resumed (their credentials still exist in the environment). PAT and per-request
App migrations can't be recovered — their credentials weren't persisted — so
they're marked `failed` with reason "Server restarted during migration" and must
be re-run manually.

---

## Database

SQLite via `bun:sqlite` in WAL mode, with two tables.

### `migrations` — one row per repository migration

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | Primary key (UUIDv7, time-sortable) |
| `batch_id` | TEXT | Groups migrations started together (nullable) |
| `github_migration_id` | TEXT | GHEC-assigned migration ID (nullable) |
| `source_api_url` · `source_org` · `source_repo` | TEXT | Where the repo comes from |
| `target_org` · `target_repo` | TEXT | Where the repo lands |
| `state` | TEXT | Lifecycle state |
| `pipeline_step` | TEXT | Current step within the pipeline |
| `auth_mode` | TEXT | `request-pat` · `request-app` · `env-app` · `env-pat` |
| `failure_reason` · `migration_log_url` | TEXT | Populated on failure / completion |
| `warnings_count` | INTEGER | Non-fatal warnings surfaced during migration |
| `source_counts` · `target_counts` | JSON | Commit/issue/PR counts, before and after |
| `started_at` · `completed_at` | TEXT | ISO timestamps |
| `elapsed_seconds` | REAL | Total run time |

### `events` — append-only audit/progress log, one row per state change

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | Primary key (autoincrement) |
| `migration_id` | TEXT | Foreign key → `migrations.id` |
| `event_type` | TEXT | What happened |
| `phase` | TEXT | Pipeline phase at the time (nullable) |
| `payload` | JSON | Event-specific detail |
| `created_at` | TEXT | ISO timestamp |

**States:** `queued` → `pending` → `running` → `succeeded` / `failed` /
`cancelled`. There is no separate batches table — a batch is simply a set of
`migrations` rows sharing the same `batch_id`.

### Why SQLite?

The workload is single-node, low-volume, and read-heavy, and write throughput is
naturally capped by GitHub's limit of up to 10 concurrent migrations per org.
WAL mode lets the dashboard and SSE pollers read while a migration writes, and an
in-process `bun:sqlite` database removes a whole moving part — no separate DB
server to run, network, or back up.

---

## Project structure

```
src/
  hooks.server.ts       auth, security headers, compression, startup init
  lib/
    server/             core logic: manager (queue/SSE), migration (pipeline),
                        monitor, store (SQLite), github (Octokit), auth, upload,
                        session, validate, schemas, watchdog, cleanup
    components/         Svelte UI (cards, timeline, progress, stats, modals, …)
    stores/             client-side SSE transport + runes reactive state
  routes/
    [id]/  new/  batches/  stats/  login/   pages
    api/                REST + SSE endpoints (see api.md)
scripts/                seed, coverage gate, postbuild, verify:json
```

See [Development](development.md) for how the code is built, tested, and gated.
