# Development

The repository uses Bun 1.4.4, SvelteKit 3, Svelte 5, TypeScript, Tailwind 4,
Biome, and Playwright.

## Setup

```bash
bun install
bun run dev
```

The development server listens on port 5173 on all interfaces. Use
`http://localhost:5173` on the development host or the host's LAN address from
another device. To keep it local, run `bun run dev -- --host 127.0.0.1`. Before
exposing it to other devices, set `GH_MIGRATE_ALLOW_UNAUTHENTICATED=false` and a unique
bootstrap password as described in [Configuration](configuration.md#run-bun-run-dev-against-local-source-containers).
Server code uses `bun:sqlite`, so run all scripts and tests with
Bun. `bun run dev` explicitly loads the root `.env` into the development server
when the file exists; it is optional.

SvelteKit configuration lives in `vite.config.ts`. The existing `$lib` import
convention is retained through an explicit alias; `tsconfig.json` extends
SvelteKit's generated `$app/tsconfig`.
Knip excludes unlisted-dependency reporting for this config because `$app` is
generated, not an npm package. Madge resolves hook types through SvelteKit's
declarations because its resolver does not recognize the new hook export.

Server-only modules read dynamic configuration from `node:process`, matching
the Bun runtime and analyzer rather than SvelteKit's deprecated `$env` modules.

## Tests

```bash
bun run test
bun run test:changed
bun run test:e2e
```

The package test commands, coverage gate, and mutation runner disable automatic
dotenv loading with `--no-env-file`, so local operator configuration does not
leak into deterministic tests. For a direct focused run, use
`bun test --no-env-file path/to/module.test.ts`; plain `bun test` loads local
dotenv files. Explicitly exported environment variables are still inherited.
Development and deliberately configured live provider contracts retain their
environment loading behavior.

Unit and route integration tests are colocated with production modules under
`src/`. Browser tests live under `tests/e2e`, and provider contract tests live
under `tests/providers`. `bun run verify provider-fixtures` loads the live contract
modules and validates their checked-in Compose inputs without Docker, a license,
or a provider connection. It does not run a live contract. The scheduled GitLab
and Bitbucket workflows run those separately on dedicated runners; see
[Provider Contracts](provider-contracts.md#verification).

Prefer real in-memory SQLite stores for persistence and route behavior. When a
module owns external I/O or time, use its explicit test dependency hook instead
of a partial global module mock.

## Quality Gates

```bash
bun run check
bun run typecheck
bun run lint
bun run docs:check
bun run build
bun run verify
```

`bun run verify` is the release go/no-go manifest. It covers tests and enforced
coverage, generated icons, TypeScript/Svelte diagnostics, formatting, lint,
documentation, duplicate/dead code, architecture boundaries, cycles, build,
mutation configuration integrity, Playwright E2E workflows, bundle checks,
dependency audit, and packaging checks. Playwright uses its seeded `.e2e-data`
store and starts an isolated development server without loading local dotenv
files. Fixture timestamps are relative to seed time so startup retention remains
enabled without aging out the test records.

For a six-month synthetic migration history without changing profile fixtures,
run `bun run seed --migrations-only`. This replaces migration fixtures with
reserved `seed-` prefixes. The default 90-day migration retention will prune
older fixtures on restart; set `MIGRATION_RETENTION_DAYS=190` before starting
the dashboard to retain the full test history.

CI also builds both production container targets and runs
`scripts/packaging/container-smoke.sh DASHBOARD_IMAGE ANALYZER_IMAGE`. This
complements the dev-server browser suite with production login, API origin
protection, SQLite backup, and analyzer startup checks, followed by image scans.
The analyzer smoke test also suspends and resumes the isolated analyzer process
to check that its container health changes independently of dashboard readiness.

Run a focused gate by passing its name through `verify`, for example
`bun run verify boundaries`, `bun run verify coverage`, or
`bun run verify format`. Validate mutation configuration with
`bun run mutation --check`; run the full suite with
`bun run mutation --force`.

Dependency upgrades can leave generated icons or the Biome configuration schema
out of date. Regenerate icons with `bun scripts/packaging/generate-icons.ts` and,
when Biome reports a schema mismatch, run `bunx --bun biome migrate --write`.
Review and commit those updates alongside the dependency changes, then rerun
the verification suite. Address coverage failures with tests for meaningful
untested behavior rather than lowering the 90% function and line thresholds.

### TypeScript Checking

`bun run typecheck` synchronizes SvelteKit, then uses Bun's native checker for
both the application and scripts projects with two threads per invocation.
The `--no-script` flag bypasses the existing `check` package script. The same
`typecheck` gate runs in local verification and CI; there is no separate
`tsc` gate.

`bun run check` remains responsible for Svelte diagnostics. The TypeScript
dependency is retained for editor and tooling support; Bun's native checker
follows TypeScript 7 semantics while that dependency is currently TypeScript 6.

## Architecture Rules

- `application` may compose `core` and server domains.
- `core` and server domains cannot import `application`.
- `core` cannot import a server domain.
- Server domains cannot import sibling domains.
- Domain-owned ports are implemented by `application/adapters` when concrete
	behavior requires another domain.
- Routes handle HTTP transport and delegate cross-domain policy to
	`application`.
- Browser-capable modules cannot import `$lib/server`, including by relative
  path or through a type re-export.
- `schemas.ts` is the durable-domain composition root.
- Root-level production server modules are rejected unless they are the schema
	composition root.
- Public DTOs belong to their client-safe domain module.

Run `bun run verify boundaries` after moving server modules or changing imports.

### Migration list pagination

Migration history, search, and batch pages count stored rows matching the request's filters and access scope. SQLite selects the requested page before the application reads its migration records. An unreadable record occupies its original position and is omitted from the returned data. A page can therefore contain fewer items than its limit, including zero, while its total and later page offsets still include that record.

## Svelte Work

Use Svelte 5 runes and the existing component conventions. Keep server-only data
out of page serialization. After component changes, run `bun run check` and the
focused configured Playwright workflow, then inspect the affected page manually
at a 390px viewport. Verify that dialogs, tables, controls, and long repository
names do not introduce document overflow.
Use the [Migration Workbench](design-system/migration-workbench.md) design system for page composition,
component states, responsive behavior, and visual review requirements.

Generated icons are updated with
`bun scripts/packaging/generate-icons.ts`; CI checks that the generated output
and client bundle remain current.

## Documentation

Most documentation is maintained by hand. Four sections in
`docs/architecture.md` are generated from production contracts and schema
metadata:

- `support-matrix`
- `migration-lifecycle`
- `ghes-import-phases`
- `durable-tables`

Generated sections are enclosed by `BEGIN GENERATED` and `END GENERATED`
comments. Do not edit their contents directly. Update the owning production
contract or durable table metadata, then synchronize the document:

```bash
bun run docs:sync
bun run docs:check
```

Run `bun run docs:sync` whenever a supported migration path, lifecycle state,
GHES phase, or durable table contract changes. Then update any surrounding
hand-written explanation affected by the change.

`bun run docs:check` verifies that generated sections match production,
Markdown links and anchors resolve, documented API operations exist, documented
configuration matches environment reads, and referenced package scripts are
valid. It runs as part of `bun run verify`, so documentation drift blocks the
release gate.
