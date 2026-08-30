# Development

The repository uses Bun 1.4.0, SvelteKit 2, Svelte 5, TypeScript, Tailwind 4,
Biome, and Playwright.

## Setup

```bash
bun install
bun run dev
```

The development server listens on `http://localhost:5173`. Server code uses
`bun:sqlite`, so run all scripts and tests with Bun.

## Tests

```bash
bun test
bun run test:changed
bun run test:e2e
```

Unit and route integration tests are colocated with production modules under
`src/`. Browser tests live under `tests/e2e`, and provider contract tests live
under `tests/providers`. The repository does not currently ship credentialed
live-provider suites.

Prefer real in-memory SQLite stores for persistence and route behavior. When a
module owns external I/O or time, use its explicit test dependency hook instead
of a partial global module mock.

## Quality Gates

```bash
bun run check
bun run typecheck
bun run lint
bun run format:check
bun run boundaries
bun run cycles
bun run docs:check
bun run mutation:check
bun run build
bun run verify
```

`bun run verify` is the release go/no-go manifest. It covers tests and enforced
coverage, generated icons, TypeScript/Svelte diagnostics, formatting, lint,
documentation, duplicate/dead code, architecture boundaries, cycles, build,
mutation configuration integrity, Playwright E2E workflows, bundle checks,
dependency audit, and packaging checks. Playwright uses its seeded `.e2e-data`
store and starts an isolated development server for the browser run.

## Architecture Rules

- `application` may compose `core` and server domains.
- `core` and server domains cannot import `application`.
- `core` cannot import a server domain.
- Server domains cannot import sibling domains.
- Domain-owned ports are implemented by `application/adapters` when concrete
	behavior requires another domain.
- Routes handle HTTP transport and delegate cross-domain policy to
	`application`.
- Browser-capable modules cannot import `$lib/server`.
- `schemas.ts` is the durable-domain composition root.
- Root-level production server modules are rejected unless they are the schema
	composition root.
- Public DTOs belong to their client-safe domain module.

Run `bun run boundaries` after moving server modules or changing imports.

## Svelte Work

Use Svelte 5 runes and the existing component conventions. Keep server-only data
out of page serialization. After component changes, run `bun run check` and the
focused Playwright workflow at desktop and 390px widths. Verify that dialogs,
tables, controls, and long repository names do not introduce document overflow.
Use the [Migration Workbench](design-system/migration-workbench.md) design system for page composition,
component states, responsive behavior, and visual review requirements.

Generated icons are updated with `bun run generate:icons`; CI checks that the
generated output and client bundle remain current.

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