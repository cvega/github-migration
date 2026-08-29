# Dashboard Port Plan

Status: validated
Source baseline: `5965aa3425121825f6bcfd0fb7780f409c194ac9`
Source branch: `test/migration-reliability-hardening`
Target: `/home/casey/gh-migrate-dashboard`
Manifest: `plans/2026-08-17-dashboard-port-map.json`

## Resume Here

At the start of each work session:

1. Read this section and the manifest.
2. Confirm the source baseline or record a deliberate baseline update.
3. Resume the first manifest entry whose status is not `validated` or `excluded`.
4. Update the manifest immediately after each focused validation.
5. Update `Current State` and `Next Action` before stopping.

### Current State

- The source repository is clean at the baseline commit above.
- The target is an architecture scaffold and is not a Git repository.
- Target configuration can build an empty SvelteKit application.
- The source database, API routes, browser workflows, dependencies, docs, and assets are fingerprinted
  in `plans/2026-08-17-dashboard-port-baseline.json`.
- Production dependencies, build and release scripts, CI workflows, container behavior, formatting,
  lint, architecture boundaries, and cycle analysis are ported and validated.
- Client-safe migration, profile, source, status, formatting, navigation, icon, SSE, consideration,
  and migration-plan contracts are ported and validated with 107 focused tests.
- Core startup, schema composition, auth/session handling, graceful shutdown ordering, health,
  readiness, rate-limit, login, and logout handlers are rewired. The focused core suite passes 53
  tests and SvelteKit reports zero diagnostics.
- Global Primer/Tailwind styling, document metadata, root layout data/polling, application header,
  notification feed, login UI, setup workflow, root dashboard, and shared auth/status components are
  ported. All 15 baseline static assets match their recorded SHA-256 hashes.
- Core runtime is validated against isolated unauthenticated and authenticated instances: health and
  readiness pass, shell routes SSR, protected routes redirect, invalid credentials fail, and a valid
  login issues the expected session cookie and grants root access.
- A WAL-consistent source database snapshot initializes identically under source and target startup.
  All 21 schema objects, schema version 7, durable row/state/provider counts, latest event ID 43249,
  recoverable migration IDs, and zero foreign-key violations match. The focused persistence suite
  passes 47 tests across 11 files.
- GitLab and Bitbucket source-provider clients, configuration, pagination, inventory, profiling, and
  archive behavior pass 103 offline tests across 15 files. Real-client wire contracts now verify
  authentication headers, canonical API paths, pagination, and normalized inventory output without
  TODO cases; credentialed contracts remain isolated under `tests/live`.
- Profile collection, analysis, persistence, service, API, SSE, list/detail UI, and migration planner
  pass 108 tests across 27 files with zero TODOs. The composed route test covers creation, live
  progress, terminal persistence, detail reads, and reconnect replay. Unreachable standalone plan
  scaffolds were removed in favor of the source-authoritative route-local planner.
- Migration manager, queue, active-run tracking, recovery, lifecycle events, validation, GitHub and
  native executors, exporters, GHES import, GHEC monitoring, and persistence integration pass 125
  tests across 36 files with zero TODOs. Docker sandbox command construction and both GHES wrapper
  source-identity guards now have behavior coverage.
- The migration-owned event reducer and rune-based live state are ported without compatibility
  stores. They reuse the existing `$lib/sse` transport and call only the approved `/api/migrate`,
  `/api/migrate/:id/events`, and `/api/migrate/events` paths. Reducer, URL, replay, and reconnect
  behavior pass 20 focused tests; Svelte diagnostics remain clean.
- The migration dashboard loader, search, independent migration/batch pagination, global counts,
  live SSE updates, batch summaries, migration cards, disconnected state, and empty state are ported.
  Five focused live-state tests, Svelte diagnostics, the production build, and desktop/mobile browser
  checks pass; the 390px viewport has no document overflow. Unused list/stats placeholders were
  removed because the source-authoritative layouts are route-local.
- The migration detail loader, event replay, SSE and polling updates, progress display, cancellation,
  exact reconciliation confirmation, restart form, completion verification, failure detail, and event
  log are ported. Eleven focused manager/live/API tests pass with zero TODOs in the detail routes. A
  seeded terminal migration renders cleanly on desktop and at 390px with no document overflow,
  console warnings, or page errors; its detail JSON and terminal SSE frame also pass live probes.
- Migration batch detail now uses the manager-owned paginated summary, global migration SSE,
  reusable migration cards, aggregate progress, bounded pagination, cancel-all confirmation, and
  shared restart form. Six focused loader/API tests pass with no batch TODOs. The seeded batch API
  and desktop/mobile route render pass with no console errors or document overflow.
- Migration statistics now uses manager-owned aggregates and a shared, validated URL filter parser.
  Twenty-one focused filter, aggregate, and neighboring loader tests pass. The complete dashboard
  renders five seeded migrations on desktop and at 390px with no console errors or document overflow;
  a GitLab/GHEC/single query returns one matching migration with synchronized controls and reset.
- The new-migration workflow now owns route selection, guided single/batch repository setup,
  credential and target configuration, execution options, readiness review, production confirmation,
  and approved single/batch submission paths. Eleven focused workflow and endpoint tests pass with
  zero Svelte diagnostics. A seeded single migration traverses every stage, focuses invalid fields,
  resolves repository mappings, and renders at 390px with no document or button overflow.
- Routes and UI are validated at the approved API paths. The schedule domain, compatibility aliases,
  placeholder modules, and TODO test scaffolds are removed.
- Consolidation is complete: Knip, cycle analysis, architecture boundaries, documentation contracts,
  formatting, lint, typecheck, and Svelte diagnostics all pass.
- The full release manifest passes with 90.58% function coverage, 90.43% line coverage, a successful
  adapter-node build and client-bundle check, and zero audit vulnerabilities.
- The production image builds and serves successful health, readiness, and setup probes. Deployment
  documentation includes stopped-volume backup, pinned-image promotion, and rollback commands.

### Next Action

Promote a pinned image using the backup and rollback procedure in `docs/deployment.md`.

## Goal

Move the working application into the approved domain-oriented layout in one production cutover. The
result must have one implementation for each behavior, preserve durable data and runtime semantics,
and remove all architecture placeholders before release.

This is primarily a code ownership and organization change. It is not permission to redesign the
database, migration lifecycle, provider contracts, or user workflows while moving them.

## Non-Negotiable Contracts

- Existing SQLite databases remain readable without export/import.
- Existing table names, columns, indexes, foreign keys, and domain schema versions remain compatible.
- Startup remains: instance lock, database open, schema application, recovery, request handling.
- Shutdown classifies interrupted migration/profile work before closing SQLite and releasing the lock.
- Credentials remain server-only and are never persisted in events or sent in page data.
- Queue capacity, recovery decisions, SSE replay, pagination limits, and provider bounds remain intact.
- Request and response payloads remain compatible unless this plan names an intentional API break.
- No compatibility barrels, duplicate stores, route aliases, or old/new implementations coexist at
  release.
- No placeholder endpoint, empty production module, TODO test, or speculative schedule behavior ships.
- The source repository remains untouched while the target implementation is built.

## Approved Structural Decisions

### Server Domains

```text
src/lib/server/
  core/       process-wide infrastructure and shared primitives
  migrate/    migration requests, execution, persistence, recovery, and progress
  profile/    assessment collection, analysis, persistence, and execution
  source/     GitLab and Bitbucket provider clients and normalized source contracts
  schedule/   excluded until real schedule behavior exists
  schemas.ts  composition root for domain database schemas
```

`core` cannot import a domain. Server domains cannot import sibling domains. Shared contracts move to
`core` or client-safe `$lib` modules only when they are genuinely shared.

### Public Server Boundaries

- `migrate/manager.ts` is the route-facing migration boundary.
- `profile/service.ts` is the route-facing assessment boundary.
- Database modules do not become route-facing convenience APIs.
- Executors own source-to-target workflows; provider clients do not orchestrate migrations.

### Client-Safe Contracts

The source catch-all `src/lib/types.ts` will be split by ownership:

```text
src/lib/migrate/types.ts
src/lib/profile/types.ts
src/lib/source/types.ts
```

Svelte components and browser modules must not import from `$lib/server`. Internal execution and row
types stay inside their server domain.

### Components

Component count is not a cleanup target. Components are organized by ownership:

- Global components: application shell and truly reusable interaction primitives.
- `components/migrate`: reused migration presentation and controls.
- `components/profile`: reused assessment presentation.
- Route-local profile planner: migration-plan controls used only by the profile detail workflow.
- Route-local components: wizard/detail components used by one route only.

Do not collapse the migration wizard or profile detail page into monoliths. Consolidate only repeated
interaction mechanics such as dialog lifecycle, type-to-confirm behavior, status labels, form feedback,
and metric tiles after migrated call sites prove the API.

Primer Product is design guidance, not a React dependency. Keep Svelte 5 and Tailwind. Use Primer
Primitives and Octicons directly, and prefer semantic Primer CSS variables in shared components.

## Intentional API Cutover

The application and API move together in one release:

```text
/api/migrate/migrations                   -> /api/migrate
/api/migrate/migrations/:id               -> /api/migrate/:id
/api/migrate/migrations/:id/events        -> /api/migrate/:id/events
/api/migrate/migrations/:id/restart       -> /api/migrate/:id/restart
/api/migrate/migrations/:id/reconcile     -> /api/migrate/:id/confirm-restart
```

Payloads, status codes, pagination, and SSE replay semantics remain unchanged. There are no route
aliases. UI fetches, API documentation, browser tests, and external automation must change together.

Persisted `reconciliation_required` values remain unchanged during the port. User-facing language and
the new endpoint use concrete review/confirmation wording without introducing a risky data migration.

## Implementation Stages

### 0. Baseline and Controls

- Record source commit, branch, and clean worktree state.
- Add this plan and the migration manifest.
- Capture a production-like database fixture outside version control.
- Capture durable table/index inventory, row counts, schema versions, state counts, and latest event ID.
- Record current API operations and key browser workflows.

Exit: baseline can be reproduced and compared after the cutover.

### 1. Production Tooling

- Port runtime and development dependencies with Bun.
- Port Biome, Knip, duplicate/cycle checks, generated icon tooling, docs checks, and gates.
- Port build, Docker, Compose, entrypoint, and packaging behavior.
- Extend boundaries for `core`, `source`, `profile`, `migrate`, and `schedule`.
- Add a client-boundary check forbidding `$lib/server` imports from browser/Svelte modules.

Exit: the target has production-equivalent tooling and can reject architectural drift.

### 2. Shared Client Contracts

- Port formatting, migration state, migration target, source provider, repository-size, navigation, and
  semantic contract modules.
- Split public DTOs from the catch-all source types into domain-owned client-safe modules.
- Port generated icon data and the rune-free SSE transport.
- Preserve serialized field names and discriminants.

Exit: shared modules have focused tests and no client module imports `$lib/server`.

### 3. Application Shell and Core Runtime

- Port static assets, fonts, global CSS, app template, app declarations, and root layout.
- Port hooks, request handling, security headers, login/logout, health, readiness, and rate-limit routes.
- Port database lifecycle, instance lock, auth, session, GitHub client factories, targets, SSH host keys,
  exporter sandbox, validation, polling, and SSE encoding.
- Preserve startup and graceful-shutdown ordering.

Exit: authenticated shell and system probes work against the target runtime.

### 4. Durable Database Compatibility

Move existing SQL, schema upgrades, row parsers, and startup recovery before changing query structure:

```text
migrate schema/store              -> migrate/database/schema.ts, migrations.ts
migrate store-events              -> migrate/database/events.ts
migrate store-batch               -> migrate/database/batches.ts
migrate store-statistics          -> migrate/database/stats.ts
migrate store-import-jobs         -> migrate/database/import-jobs.ts
profile schema/store              -> profile/database/schema.ts, runs.ts, repos.ts
profile inventory persistence     -> profile/database/inventories.ts
profile persisted rollups/results -> profile/database/results.ts
```

Exit: a copied production-like database opens idempotently with identical schema versions, row counts,
state counts, latest event ID, recoverable work classification, and zero foreign-key violations.

### 5. Source Providers

- Port normalized source inventory and observation contracts.
- Port GitLab config, client, inventory, profile, and archive behavior.
- Port Bitbucket config, client, inventory, profile, and archive behavior.
- Move credentialed checks to `tests/live`; keep provider contracts in `tests/providers`.
- Preserve the provider-neutral 10,000-project collection envelope.

Exit: provider contracts and bounded inventory persistence match the source behavior.

### 6. Profile Domain

- Port collection: discovery, counts, commits, rulesets, organization resources, and provider details.
- Port analysis: repository findings, recommendations, summaries, duration estimates, and plans.
- Port profile runner, events, validation, and service boundary.
- Port profile API, SSE, list/detail pages, route-local live controller, and profile/plan components.

Exit: GitHub, GitLab, and Bitbucket assessments reach behavior parity, including interruption handling,
retention, filtered pagination, live progress, and batch-plan creation.

### 7. Migration Domain

- Port GitHub migration source, exports, upload, and monitor behavior.
- Port GHES SSH, organization mapping, import, and durable import-job behavior.
- Port exporter workers and Docker execution.
- Port source-to-target executors and executor registry.
- Port manager request handling, queue, active runs, events, completion, and recovery.
- Preserve ambiguous remote-write handling and durable continuation rules.

Exit: single and batch migrations match queueing, cancellation, restart, recovery, and completion behavior.

### 8. Routes and Live UI

- Port the approved API routes atomically with all browser fetch URLs.
- Port global and per-migration SSE clients.
- Port dashboard, migration detail, batch detail, statistics, and new-migration wizard.
- Move components by actual ownership; do not create wrappers solely to mirror the tree.
- Apply Primer semantics through native Svelte components and existing Tailwind layout utilities.

Exit: primary browser workflows and API contracts match at the new paths.

### 9. Consolidation

- Remove superseded placeholders, old paths, generic catch-all types, compatibility barrels, and duplicate
  component authorities.
- Delete placeholder tests and keep behavior-oriented tests only.
- Remove the `schedule` domain/routes if still unimplemented.
- Update architecture, API, setup, deployment, troubleshooting, and configuration documentation.

Exit: every production file has real ownership and behavior; dead-code, cycles, and boundaries pass.

### 10. Release Rehearsal and Cutover

- Stop a production-like source process cleanly and copy database, WAL, SHM, data, and environment config.
- Start the target build against the copy and compare baseline invariants.
- Exercise profile, single migration, batch, cancellation, confirm-restart, restart, recovery, and SSE.
- Build and smoke-test the adapter-node container.
- Document backup, promotion, and rollback commands.

Exit: release candidate passes the full gate suite and rollback rehearsal.

## Focused Validation Policy

- Validate the smallest moved behavior immediately after each substantive move.
- Do not run the entire suite for placeholder-only work.
- Run domain tests after each completed domain stage.
- Run the complete verification manifest at stages 4, 6, 7, 8, and 10.
- For Svelte edits, run the official Svelte autofixer and focused Svelte check.
- Never interpret TODO tests or empty-module builds as behavior coverage.

## Database Rehearsal Checklist

For every rehearsal, record and compare:

- SQLite table and index inventory.
- `app_schema_versions` rows.
- Row count for each durable table.
- Migration counts by state and profile counts by state/provider.
- Latest migration event ID.
- Recoverable migration and GHES import-job IDs.
- Profile inventory/project/profile row counts.
- `PRAGMA foreign_key_check` output.
- Startup and shutdown recovery changes.

## Rollback Rules

- Back up the database, WAL, SHM, data directory, and environment before promotion.
- Roll back the complete image; never mix old backend and new frontend assets.
- Do not change persisted enum values during this port.
- If a later release changes durable values, it requires an explicit forward and reverse data migration.
- The source application remains the rollback binary until the target passes production rehearsal.

## Definition of Done

- One authority exists for every behavior.
- No target code imports or executes files from the source repository.
- No old route names, compatibility aliases, placeholders, or duplicate stores remain.
- Existing databases initialize and recover idempotently.
- Profile, migration, batch, cancellation, confirmation, restart, recovery, and SSE workflows match.
- Documentation describes the implemented tree and API.
- Typecheck, Svelte check, formatting, lint, boundaries, cycles, dead code, contracts, focused unit and
  integration tests, E2E, build, audit, container smoke, and database rehearsal pass.
