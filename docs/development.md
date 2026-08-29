# Development

The repository uses Bun 1.3.14, SvelteKit 2, Svelte 5, TypeScript, Tailwind 4,
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
bun run test:e2e
```

Unit tests are colocated with production modules. Route integration and browser
tests live under `tests/`. Credentialed provider checks are isolated under
`tests/live` and are not part of the normal offline suite.

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
bun run build
bun run verify
```

`bun run verify` is the release go/no-go manifest. It covers tests and enforced
coverage, generated icons, TypeScript/Svelte diagnostics, formatting, lint,
documentation, duplicate/dead code, architecture boundaries, cycles, build,
bundle checks, dependency audit, and packaging checks.

## Architecture Rules

- `core` cannot import a server domain.
- Server domains cannot import sibling domains.
- Routes compose concrete cross-domain dependencies.
- Browser-capable modules cannot import `$lib/server`.
- `schemas.ts` is the durable-domain composition root.
- Public DTOs belong to their client-safe domain module.

Run `bun run boundaries` after moving server modules or changing imports.

## Svelte Work

Use Svelte 5 runes and the existing component conventions. Keep server-only data
out of page serialization. After component changes, run `bun run check` and the
focused Playwright workflow at desktop and 390px widths. Verify that dialogs,
tables, controls, and long repository names do not introduce document overflow.

Generated icons are updated with `bun run generate:icons`; CI checks that the
generated output and client bundle remain current.

## Documentation

Architecture tables are generated from production contracts:

```bash
bun run docs:sync
bun run docs:check
```

The API and configuration tables are also checked against implemented routes
and environment reads. Missing operations, stale variables, broken links, and
invalid package scripts fail the docs gate.