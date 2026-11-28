# Verification for repository changes

The source of truth is `package.json`, `scripts/gates.ts`, and
`.github/workflows/verify.yml`. Inspect them when they change; do not create a
parallel gate runner in this skill.

## Local setup and focused checks

```sh
bun install --frozen-lockfile
bunx --bun svelte-kit sync
bun test src/lib/server/migrate/runs/recovery.test.ts
bun run verify boundaries
```

Replace the example test with the affected suite. `bun run verify` prepares
SvelteKit itself; direct `bun test` in a fresh checkout needs the sync above.
Follow existing explicit dependency hooks for network/time, restore overrides,
and use real in-memory SQLite. From 1.0 on; before 1.0 see Pre-1.0 policy in
`AGENTS.md`. Test persistence upgrades with an old store that can be reopened.
`src/test-setup.ts` owns the global test preload; avoid adding
global partial mocks that hide the real behavior under test.

| Change | Focused evidence |
|---|---|
| Imports/module ownership | `bun run verify boundaries cycles` |
| TypeScript/Svelte behavior | Nearest tests; `bun run typecheck`; `bun run check` |
| Migration lifecycle | Executor, database, queue/recovery and route tests |
| Provider client | Colocated parser/client tests and matching provider contract test |
| Auth/scope | Auth, self-service, affected route and scoped dashboard tests |
| UI | Affected configured Playwright workflow plus desktop/390px inspection |
| Supported routes, states, phases, tables | `bun run docs:sync`, then `bun run docs:check` |
| Generated icons | `bun scripts/packaging/generate-icons.ts`, then `bun run verify icons` |
| Build/config/dependencies | Relevant focused gates, build and required full suite |
| Deployment/runtime packaging | Both Docker targets and CI's container smoke path |

## Pre-submission gate

Follow the pre-submission verification rules in `AGENTS.md`. The full gate
manifest includes icons, typecheck, Svelte check, lint, format, docs, coverage,
duplicate/dead code, cycles, boundaries, workflow action pins, runtime version,
mutation configuration, E2E, build, and dependency audit.

Important distinctions:

- `coverage` runs the tests and enforces 90% function and line coverage.
  `bun test` alone is not the enforced coverage gate.
- `mutation-config` validates configuration; it does not run mutation testing.
  `bun run mutation --force` is a separate, more expensive suite.
- `bun run typecheck` uses Bun's native checker for app and scripts. There is no
  separate `tsc` gate to substitute for it. `bun run check` covers Svelte diagnostics.
- Production image builds, container smoke tests and image scans are separate
  jobs in the reusable CI workflow, beyond local `verify`.
- Playwright seeds `.e2e-data`, starts its own server, and does not reuse an
  existing server. Preserve project dependencies; the scoped-dashboard project
  follows chromium. The current server command uses POSIX `exec`; use a suitable
  Linux/WSL environment if Windows cannot execute it, and report unrun checks.

Generated architecture sections are `support-matrix`, `migration-lifecycle`,
`ghes-import-phases`, and `durable-tables`. Edit their owning production contracts
or metadata, regenerate, and inspect the diff. Keep surrounding manual prose
consistent. Documentation validation also checks links, API operations,
configuration and referenced scripts.

Do not seed or reset an existing operator database. Do not use credentials from
a developer environment to make offline tests pass. Report exact commands and
results, including unrun checks; never call a focused pass full verification.
