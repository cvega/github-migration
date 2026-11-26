# Providers, observations, and repository analysis

## Source map

- Client-safe contracts: `src/lib/source/{types,inventory,observations,profile}.ts`
  and `src/lib/source-provider.ts`.
- Provider implementations: `src/lib/server/source/gitlab/` and `source/bitbucket/`.
- Cross-domain wiring: `src/lib/server/application/adapters/` and
  `src/lib/server/migrate/ports/source-runtime.ts`.
- Readiness reference data: `src/lib/profile/migration-catalog.ts`; detection
  and analysis: `src/lib/server/profile/analysis/`.
- Worker: `src/bin/profile-analyzer.ts`, `profile/repository-analysis/`, and
  `profile/database/repository-analysis-{runs,jobs,results}.ts`.

Read `docs/provider-contracts.md` for the collection contract. Keep provider
authentication, pagination and response parsing in provider clients; lifecycle
orchestration belongs to the consuming domain. Inject concrete provider behavior
at the application/route boundary rather than importing `source` from `migrate`
or `profile`.

## Observation semantics

`src/lib/source/observations.ts` validates a strict discriminated union:

- `exact`: a reported or enumerated value with scope.
- `at-least`: a lower bound with the limiting reason.
- `unavailable`: an explicit reason such as forbidden, not-reported, malformed,
  unsupported, or transient-failure.

Keep provider, endpoint family, collection time and scope with the observation.
Do not convert absent statistics into `0`, a forbidden result into an empty
repository, or a capped enumeration into an exact count. Use the canonical
readiness catalog for limitations and remediation; do not duplicate its rules
inside UI components or invent a second catalog.

Collection must preserve namespace/project restrictions, the current 10,000
project envelope, bounded concurrency/request budgets, and accounting for every
actual page/request. Parse provider responses before persistence and reject
invalid or cross-provider payloads.

## Provider-specific constraints

- GitLab: preserve encoded project paths, token destination, explicit pagination,
  archive size/time bounds, and the acknowledged export checkpoint.
- Bitbucket: preserve version validation, configured project scope, pagination
  without optional totals, and explicit insecure-HTTP opt-in. Native GHEC exports
  use pinned SFTP to shared home. GHES uses the external read-only exporter.
- Adding exporter configuration does not enable a route. A new supported route
  requires coherent provider/target contracts, capabilities, admission, executor
  registration, recovery behavior, tests, and generated support documentation.
- Preserve archive hash/path checks, SSH host-key pinning, exporter confinement,
  and separation of source and target credentials when touching archive transport.

## Analysis worker

The analyzer is a separate Bun process sharing the dashboard's SQLite store;
its temporary workspace is separate. Do not move its durable queue into a page
request or assume dashboard in-memory state coordinates workers.

Preserve atomic job claiming, lease ownership/renewal, attempt identity,
immutable result evidence, and terminal-run rollups. Test expired-lease reclaim,
late completion, cancellation, retry, and result retention when changing these
paths. Check the existing owner predicates before adding a new concurrency rule.

GitHub batch admission requires successful repository analysis for selected
repositories with profile warnings/blockers; clear repositories can be eligible
without it. GitLab and Bitbucket do not share that gate. Trace the actual
admission policy before broadening or bypassing this requirement.

## Verification

Use colocated provider tests and `tests/providers/{gitlab,bitbucket}/contract.test.ts`.
Exercise the real parser/client against deterministic HTTP fixtures, asserting
canonical paths, authentication headers, pagination, limits, observations and
failure classification. The repository does not ship credentialed live-provider
suites. Run `bun run verify boundaries` after changing imports and synchronize
generated docs when supported routes or durable contracts change.
