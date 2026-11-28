---
name: github-migration-development
description: Use when changing or reviewing backend behavior in cvega/github-migration, including migration recovery, provider adapters, scoped authorization, SQLite state, SSE, or repository-analysis jobs. Excludes UI-only styling and operating live migrations.
---

# GitHub Migration Development

Develop against the repository's durable contracts. The main failure to avoid is
making a locally reasonable change that alters remote-write safety, identity
scope, or historical evidence.

Read the root `AGENTS.md` and the owning implementation plus nearby tests. Paths
in the references are repository-relative. Verify current code before relying
on a listed value; this guidance does not freeze the product's capabilities.

## Choose the relevant reference

| Change | Read |
|---|---|
| Execution, retry, cancel, restart, queue, migration schema, SSE | [Migration lifecycle](references/migration-lifecycle.md) |
| Discovery, provider metrics, readiness, analysis worker, new source support | [Providers and analysis](references/providers-and-analysis.md) |
| Sessions, roles, grants, ownership, credentials, operator-visible data | [Authorization](references/authorization.md) |
| Tests, CI, generated contracts, build or packaging | [Verification](references/verification.md) |

Read multiple references only when the change crosses those boundaries.

## Work from the affected contract

1. Trace the entry point through request validation, application policy, domain
   operation, persistence, and public result. Include background dispatch or
   recovery when that can execute the same operation later.
2. Identify what the change must preserve: recorded identity/options, allowed
   transitions, ownership, observation semantics, or public DTO shape. For a
   requested behavior that changes one of these guarantees, explain the concrete
   consequence and scope the policy change explicitly.
3. Put code in the existing owner. Cross-domain behavior uses application
   composition and domain-owned ports; do not make a sibling-domain import to
   avoid an adapter.
4. Add or update a behavior test at the boundary that could regress. For remote
   operations, test uncertainty and interruption as well as success. Reuse
   existing test dependency hooks and real SQLite stores.
5. Update public contracts and documentation where the behavior requires it.
   Use the existing generators for generated sections. From 1.0 on; before
   1.0 see Pre-1.0 policy in `AGENTS.md`. Update persistence upgrades where
   the behavior requires it.
6. Run focused checks, then the repository's required pre-submission verification.
   Report the checks actually run and distinguish unavailable tooling from a
   product failure.

## Example: a native import times out

If an export checkpoint exists but target-start may have succeeded without a
saved target ID, do not restart from that export automatically. Trace the
provider executor, `migrate/database/schema.ts`, checkpoint predicates, and
`migrate/runs/recovery.ts`. Test that no second target submission occurs and
that the durable job stays `reconciliation_required`. Separately test that a
confirmed target ID resumes monitoring. This preserves the distinction between
recoverable work and an ambiguous remote write.

## Common mistakes

- Inferring supported routes from retained executor/exporter files.
- Clearing checkpoints to make a retry button work.
- Treating independently granted endpoints as an authorized pair.
- Returning raw admin events to operators or replacing unknown counts with zero.
- Using a broad module mock that bypasses the parser, persistence, or policy the
  test is supposed to exercise.

This is a development skill. Use offline fixtures and isolated stores; invoking
it grants no authority to run real migrations or mutate deployment data.
