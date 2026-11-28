# Migration lifecycle and durable state

## Source map

Start with `src/lib/migration-state.ts`, `src/lib/migration-target.ts`, and
`src/lib/source-provider.ts`. Execution is composed in
`src/lib/server/migrate/executors/registry.ts`; orchestration is in
`src/lib/server/migrate/manager.ts` and `runs/{active,queue,recovery,finish,events}.ts`.
Persistence and recovery classification live in `migrate/database/`.

Read the affected provider executor and its tests. Shared GHEC target mechanics
live in `migrate/executors/archive-to-ghec.ts`, `native-to-ghec.ts`, and
`migrate/github/`; GHES orchestration lives in `migrate/ghes/`.

## Recovery decision table

| Persisted evidence | Required behavior to preserve |
|---|---|
| Confirmed GHEC migration ID | Reconnect to that import; do not submit another |
| Confirmed native export checkpoint before target-start, saved plan, valid server credentials/scope | Resume only the safe path recognized by the provider and recovery predicates |
| Target-start may have succeeded, but no target ID | `reconciliation_required`; an older export checkpoint does not establish safety |
| Uncertain source export write | Reconcile source state; do not blindly repeat the export |
| Per-request credentials lost on process restart | Do not persist secrets to make the work recoverable |
| Saved GHES GUID in audit/unlock finalization | Continue finalization on the same GUID; do not prepare/import again |
| Legacy GHES GUID without a trustworthy phase (from 1.0 on; before 1.0 see Pre-1.0 policy in `AGENTS.md`) | Require reconciliation rather than infer a safe replay |
| Paused/unsupported route | Preserve the current classification; do not activate it because credentials exist |

GitLab's acknowledged export checkpoint is not necessarily a provider-issued
export job ID. Inspect the provider's actual checkpoint representation.
Startup classification and direct executor resume must both respect ambiguous
checkpoints; protecting only startup leaves another entry point unsafe.

Cancellation is a request until confirmed. A stale promise or event must not
settle a newer attempt: preserve run-token checks. Do not free queue capacity
while an execution promise is still settling. The current queue has ten shared
slots and serializes dashboard GHES work because of the appliance-wide lock.
Batches are durable membership, not an independent executor or queue.

Restart uses admitted source/target identity and approved nonsecret options;
replacement credentials must not silently replace that plan. Preserve explicit
reconciliation confirmation, including when changing restart UI. From 1.0 on;
before 1.0 see Pre-1.0 policy in `AGENTS.md`. Preserve the legacy missing-plan
visibility check.

## Persistence and progress

- Preserve foreign keys and historical rows in the current schema. From 1.0 on;
  before 1.0 see Pre-1.0 policy in `AGENTS.md`. Preserve domain schema upgrade
  ordering in `src/lib/server/schemas.ts`, keeping upgrades idempotent and
  preserving foreign keys and historical rows across upgrades.
- Persist state/checkpoints at the appropriate remote-write boundary. A log
  message or in-memory controller is not a durable acknowledgement.
- Keep successful completion counts separate from later live target observations.
  Indexing lag must not replace historical counts with transient zeroes.
- Migration event IDs are durable SQLite sequences. Preserve bounded replay,
  cursor validation and the buffered replay/live handoff; test events arriving
  during subscription. Terminal state must survive a missed final frame.
- Operator event requests currently receive scoped, sanitized JSON/NDJSON;
  administrator streaming behavior is different. Do not unify them by exposing
  raw events. See `src/routes/api/migrate/[id]/events/+server.ts` and the
  authorization reference for scope changes.

## Focused regression evidence

Use the closest tests in `migrate/runs/`, `migrate/database/`, the affected
executor, and the changed API route. Useful existing suites include
`runs/native-recovery.test.ts`, `runs/recovery.test.ts`, `runs/queue.test.ts`,
`runs/finish.test.ts`, and `tests/e2e/restart.e2e.ts`.

For a recovery change, assert remote call counts, durable state and checkpoint
values, not just the returned message. Cover the applicable cases: lost remote
acknowledgement, confirmed remote ID, cancellation during settlement, restart
while stopping, invalidated credential scope, and a late event from an old run.
Add no real provider writes to these tests. From 1.0 on; before 1.0 see
Pre-1.0 policy in `AGENTS.md`. Use an old-schema file fixture and reopen the
database when changing upgrade behavior.
