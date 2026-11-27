# Review: migration correctness and recovery

- **Review issue:** `gh-migrate-dashboard-b0x.1` (parent epic `gh-migrate-dashboard-b0x`)
- **Reviewed revision:** `ee17bd9` (branch `cvega/gh-migrate-dashboard-b0x.1`)
- **Date:** 2026-11-26
- **Scope:** `src/lib/server/migrate/` covering the manager, `runs/` (queue, active
  registry, recovery, finisher, events), `executors/`, `github/` (archive
  export, monitor, migration source), `ghes/` and `exporters/` (GHES import
  orchestration and the Docker exporter), and `database/` (migrations, columns,
  schema recovery, import jobs). The startup and shutdown calls in
  `src/hooks.server.ts` were also read.
- **Method:** I did a read-only code review against the AGENTS.md contracts and
  `.agents/skills/github-migration-development` (migration lifecycle reference).
  No live systems were contacted and no code was changed. Evidence is limited to
  code references and invariant analysis.

## Summary

The core remote-write safety contracts hold on every current entry point I
traced. The four findings below are about queue and recovery robustness. None
of them blocks production (no P0 or P1). Two are P2 because, if triggered, they
could release a durable hold on an ambiguous remote outcome. Two are P3
defensive hardening items.

| ID | Priority | Title |
|---|---|---|
| `gh-migrate-dashboard-eow` | P2 | Recovery fails checkpointed migrations when their route has no executor |
| `gh-migrate-dashboard-tp0` | P2 | GHES queue admits new imports while an earlier GHES import is ambiguous |
| `gh-migrate-dashboard-d9k` | P3 | Queue drain leaves claimed migrations ownerless when launch fails |
| `gh-migrate-dashboard-sae` | P3 | GHES exporter wait has no deadline; a recovered created-but-unstarted container blocks the GHES slot |

Each finding is filed as its own Beads issue, linked `discovered-from` this
review, with acceptance criteria and the files it touches.

## Invariants verified

These are the AGENTS.md checks named in the review issue. Each was traced
through the code and holds on the current entry points.

### Unknown remote outcomes keep their checkpoints and become `reconciliation_required`

- **GHEC start.** `executors/archive-to-ghec.ts:112-131` writes the
  `ghec_starting` checkpoint and sets `markRemoteStartMayHaveSucceeded(true)`
  before `startRepositoryMigration`, which runs with SDK retries disabled
  (`github/migration-source.ts:105`). It persists the returned ID with the
  `monitoring` step before clearing the flag. If the process stops in this
  window, `UNRESOLVED_REMOTE_WORK_SQL` (`database/columns.ts:47-50`) classifies
  the row as `reconciliation_required` at startup (`database/schema.ts:348-372`).
- **Executor errors.** The GitHub executor (`executors/github-to-ghec.ts:260-291`)
  and the native classifier (`executors/native-to-ghec.ts:328-362`) map these
  cases to `reconciliation_required`:
  - an unknown start outcome
  - a saved GHEC ID
  - an accepted source export, including an incomplete git/metadata pair
    (`github/exports.ts:170-203`)
  - a cancellation that could not be confirmed
- **Unexpected throws.** `runs/finish.ts:318-341` consults
  `hasUnresolvedRemoteWork`. Failure text is fixed and nonsecret, and raw
  provider errors are not persisted.
- **Monitor exhaustion.** Ten consecutive monitor poll failures throw
  (`github/monitor.ts:122-139`). The saved ID makes the outcome ambiguous, so it
  is not marked failed.
- **GHES.** `ghes/import.ts:405-434` treats prepare without a GUID, mapping,
  import, audit, and unlock as ambiguous. It keeps the job phase whenever a GUID
  exists, so the checkpoint is not overwritten with a terminal phase.
- **Restart.** `resetMigration` (`database/migrations.ts:552-571`), the only path
  that clears checkpoints, accepts only `failed` or `cancelled`. Leaving
  `reconciliation_required` requires the explicit typed confirmation in
  `confirmRestart` (`manager.ts:339-370`).

**Exception (latent):** startup recovery fails a checkpointed row whose route
has no executor. See `gh-migrate-dashboard-eow`.

### A saved GHEC import ID resumes monitoring, not submission

- `resumeGitHubToGhecMigration` (`executors/github-to-ghec.ts:306-370`) only
  monitors.
- `resumeNativeToGhecMigration` (`executors/native-to-ghec.ts:207-245`) prefers
  the saved `githubMigrationId` and uses the monitor path before considering any
  export checkpoint.
- `PRE_IMPORT_EXPORT_SQL` requires `github_migration_id IS NULL`, and the
  `ghec_starting` step is excluded from resumable steps
  (`database/columns.ts:32-36`).
- Direct executor resume recomputes the checkpoint itself
  (`getResumableSourceExportId`). Startup classification is therefore not the
  only guard.
- A configured source URL change since submission returns
  `reconciliation_required` (`native-to-ghec.ts:246-254`).

### Run-token ownership

- `ActiveMigrationRuns` (`runs/active.ts`) issues a fresh `Symbol` per claim.
  `attach`, `finish`, the event handler (`runs/events.ts:104-105`), and both
  settle paths (`runs/finish.ts:261, 319`) check ownership.
- A run token is released only after the executor promise settles. Restart
  refuses while a previous run is still registered (`manager.ts:294-296`), so a
  stale promise cannot settle or emit into a newer attempt.

### Settling capacity

- `getCapacityUsage` (`runs/queue.ts:34-41`) counts active runs whose durable
  state is already terminal. Capacity is freed only in `finish()` after the token
  is released.

### Transactional claims

- Queue claims (`runs/queue.ts:45-51`), restart resets (`manager.ts:317-329`),
  start admission (`manager.ts:220-238`), cancellation claims
  (`manager.ts:256-263`), and reconciliation confirmation each run in a SQLite
  transaction guarded by state.
- Cancellation preserves `cancelling` against late settlement through
  `preserveCancellation` (`database/migrations.ts:388-432`) and the finisher's
  `cancelling` handling.

**Exception (defensive):** claim-then-launch has no compensation. See
`gh-migrate-dashboard-d9k`.

### GHES serialization

- `shouldQueueMigration` and `drainMigrationQueue` admit at most one GHES row
  in `pending`, `running` or `cancelling`, whether it is in-process or durable.
- Recovery relaunches only rows that were admitted before the process stopped,
  so it cannot exceed the limit.

**Exceptions:** an ambiguous GHES outcome releases the slot (see
`gh-migrate-dashboard-tp0`), and an unbounded exporter wait can hold the slot
indefinitely (see `gh-migrate-dashboard-sae`).

### Idempotent restarts and recovery

- `recoverInterruptedMigrations` (`database/schema.ts:315-378`) runs at startup
  and shutdown. It fails only provably local interruptions and quarantines
  ambiguous ones. It classifies paused GitLab-to-GHES rows first, and leaves
  env-credential executing rows with recoverable checkpoints for the manager.
- Recovery revalidates:
  - persisted credential scope and the configured source URL
    (`validate.ts:50-64`)
  - operator authorization through the owned-dispatch policy, returning
    `reconciliation_required` if the policy now rejects the job
    (`manager.ts:113-144`)
  - the GHES target URL (`ghes/import.ts:155-158`)
- Restart reuses admitted identity through `requestForMigration`
  (`validate.ts:98-112`), and approved options through `restartRequest`. The
  legacy missing-plan visibility check is retained (`manager.ts:275-288`).
- A GHES restart continues finalization on the saved GUID. A legacy GUID without
  a reliable phase is refused (`ghes/import.ts:165-220`).

### Secrets in persisted data

- `serializeRequestOptions` (`validate.ts:82-96`) and the strict persisted
  schema (`database/migrations.ts:143-157`) exclude tokens and app credentials.
- Request-scoped queued requests live only in memory. On restart they are failed
  rather than persisted (`database/schema.ts:370`).

## Findings

### `gh-migrate-dashboard-eow` (P2): recovery fails checkpointed migrations when their route has no executor

**Evidence.** `runs/recovery.ts:179-186` sets every recoverable row to `failed`
when `hasExecutor()` is false. Rows are selected by `RECOVERABLE_CHECKPOINT_SQL`
(`database/columns.ts:38-45`), so each one has one of:

- a saved GHEC ID
- a native pre-import export checkpoint
- a GHES import job

`failed` is restartable, and `resetMigration` clears `github_migration_id`,
`source_export_id` and `pipeline_step`.

**Invariant broken.** Unknown remote outcomes must keep their checkpoints and
`reconciliation_required`. Paused or unsupported routes must keep their current
classification.

**Reachability.** The issue is latent today. The only paused route
(GitLab-to-GHES) is classified earlier, in `database/schema.ts:318-327`.

**Why it matters.** The repository already has a precedent of pausing a route
while keeping its code. A future pause or capability toggle would expose a
duplicate target submission on restart.

**Remediation.** Classify these rows as `reconciliation_required` and keep their
checkpoints. Queued rows without remote work can stay `failed`.

### `gh-migrate-dashboard-tp0` (P2): GHES queue admits new imports while an earlier GHES import is ambiguous

**Evidence.**

- `ghesBusy` (`runs/queue.ts:19-24`) and `hasExecutingGhesMigration`
  (`database/migrations.ts:641-646`) ignore `reconciliation_required` rows.
- The batch hold (`database/migrations.ts:656-695`) applies only within the same
  Bitbucket-to-GHES batch.
- An import whose mapping, import, audit, unlock, or GUID-less prepare outcome is
  unknown (`ghes/import.ts:405-434`) therefore frees the appliance slot for
  standalone runs, restarts, and other batches. The appliance-wide `ghe-migrator`
  lock may still be held.

**Cascade.** The next run's `ghe-migrator prepare` can fail with "already
running" (`ghes/ssh.ts:250-258`). That failure is itself classified as an
ambiguous prepare, so the new migration also becomes `reconciliation_required`.

**Current tests.** `runs/queue.test.ts:52-112` expects another batch's GHES item
to launch while the blocker is `reconciliation_required`. That test documents
today's behavior and would change with the fix.

**Remediation.**

- Hold GHES admission while a GHES job's outcome is ambiguous, until the
  operator confirms reconciliation.
- Classify the definitive lock-held rejection as non-ambiguous.

### `gh-migrate-dashboard-d9k` (P3): queue drain leaves claimed migrations ownerless when launch fails

**Evidence.** `drainMigrationQueue` (`runs/queue.ts:43-64`) commits
`queued -> pending` in its claim transaction, then calls `launchPipeline`
outside it. It ignores a `false` return, and a synchronous throw is not caught
(`manager.ts:90-95`). Either way, the row stays `pending` with no run
registration. That row then:

- takes up a capacity slot
- blocks GHES admission if it targets GHES
- cannot be cancelled, because it moves to `cancelling` with no controller to
  abort (`manager.ts:271`)

A throw also stops the rest of the drain. When the drain runs from
`finish()`, the exception is swallowed by the run promise's `.catch`
(`manager.ts:107-108`, `runs/finish.ts:256-257`).

**Reachability.** Not reachable today, because routes are validated at
admission. This is hardening of the transactional-claim invariant.

**Remediation.** Compensate durably: re-queue the row, or mark it failed when
there is no remote work. Then continue draining.

### `gh-migrate-dashboard-sae` (P3): GHES exporter wait has no deadline

**Evidence.** `waitForArchive` (`ghes/import.ts:102-122`) polls with no
deadline. The native GHEC executors use 6 hours.

The exporter's container name is durable before submit
(`exporters/worker.ts:99-103`), and submit runs `create` and then `start`
(`exporters/docker.ts:121-187`). If the process stops between those two steps,
recovery resumes the run, and `inspect` reports the never-started container as
`queued` (`exporters/docker.ts:197-198`). The run then waits forever while
holding the appliance-wide GHES slot. A hung exporter has the same effect.

**Remediation.**

- Add a bounded, configurable deadline that ends in local cleanup and a
  `failed` state. This involves no remote write.
- Handle a created-but-unstarted container explicitly on recovery.

## Observations not filed

These are recorded for context. None is a defect in this scope.

- **Transient native export poll errors fail the run.** In the Bitbucket and
  GitLab GHEC executors, an error while polling export status after a confirmed
  export start settles the run as `failed`, not as a resumable checkpoint. The
  Bitbucket client already retries idempotent GETs
  (`src/lib/server/source/bitbucket/client.ts:109-125, 304`). A restart repeats
  only a source export, not a target write. I judged this acceptable.
- **GHES site-admin token in the command line.** `ghe-migrator import` receives
  the token through `-p` on the remote command line (`ghes/ssh.ts:234-237`). This
  is the documented `ghe-migrator` interface, so I am not filing it as a
  migration-correctness defect. It is referred to the credential-handling or
  security review for a decision on remote process-argument exposure.
- **Admin restarts can change nonsecret options.** An administrator restart can
  override approved nonsecret options such as visibility and lock/archive flags
  (`manager.ts:279-288`), while operator restarts cannot
  (`src/routes/api/migrate/[id]/restart/+server.ts:16-26`). This appears
  intentional, and the admitted source/target identity stays authoritative.

## Verification performed

- `bun install --frozen-lockfile` and `bunx --bun svelte-kit sync` in the child
  worktree.
- `bun test src/lib/server/migrate`: 213 pass, 0 fail across 40 files. This is
  the existing suite at the reviewed revision. It was run as context, not as
  proof of the findings, and no new tests were written.

## Limitations

- This is a read-only review. The findings were not reproduced at runtime, and
  each one's acceptance criteria require its own regression tests.
- Provider source clients (`src/lib/server/source/`), application authorization
  adapters, and HTTP routes were read only where migration recovery depends on
  them.
- I did not run the full `bun run verify` or the non-e2e gate set, because the
  only change is this report.
