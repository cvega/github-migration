# Development

How to work on the GitHub Migration Dashboard: the dev loop, the gate suite that
every change must pass, the testing approach, and the discovery tooling used to
keep the codebase honest.

- [Stack](#stack)
- [Dev loop](#dev-loop)
- [The gate suite (`verify`)](#the-gate-suite-verify)
- [Machine-readable verify (`verify:json`)](#machine-readable-verify-verifyjson)
- [Testing](#testing)
- [Discovery tooling](#discovery-tooling)
- [Seeding the database](#seeding-the-database)
- [Conventions](#conventions)

---

## Stack

- **Runtime / package manager / test runner:** [Bun](https://bun.sh) (≥ 1.3.9).
  Use `bun` for everything — never `node`/`npm`.
- **Framework:** SvelteKit 2 with Svelte 5 runes (`$state`, `$derived`,
  `$props`, `$bindable`, snippets), `adapter-node`.
- **Styling:** Tailwind CSS v4. Icons: Primer Octicons (`size` ∈ {12, 16, 24}).
- **Lint/format:** [Biome](https://biomejs.dev) (not ESLint/Prettier).
- **Database:** `bun:sqlite` (WAL mode).
- **TypeScript:** strict, plus `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noUnusedLocals`, `noUnusedParameters`.

---

## Dev loop

```bash
bun install                  # install deps
bun run dev                  # dev server → http://localhost:5173
```

While iterating, run individual gates (they're fast):

```bash
bun run check                # svelte-check + TS diagnostics (0 errors / 0 warnings)
bun run lint                 # Biome lint (errors on warnings; includes .svelte)
bun test                     # unit suite
```

Before committing, run the whole suite — see below.

---

## The gate suite (`verify`)

`bun run verify` is the single go/no-go. It runs every gate in sequence and
fails on the first red one:

```bash
bun run verify
```

| Gate | Command | What it catches |
|---|---|---|
| `typecheck` | `tsc --noEmit` (app **and** `scripts/`) | Type errors the editor might miss |
| `check` | `svelte-check --fail-on-warnings` | Svelte/TS diagnostics incl. a11y; must be **0/0** |
| `lint` | `biome check --error-on-warnings` | Lint + formatting + import-organization across `.ts`/`.js`/`.svelte` |
| `format:check` | `biome format` | Formatting drift (explicit) |
| `coverage:check` | `scripts/check-coverage.ts` | Test coverage below the floor (85% func / 82% line) |
| `dup` | `jscpd` | Code duplication above 3% (lines) |
| `deadcode` | `knip` | Unused files / exports / dependencies |
| `cycles` | `madge --circular` | Circular imports |
| `build` | `vite build` + postbuild | The production build actually compiles |
| `audit` | `bun audit` | Dependency advisories |

A few notes:

- **Coverage** isn't enforced by Bun directly (it reports but doesn't fail), so
  `scripts/check-coverage.ts` parses the summary and enforces the floor itself.
  Floors sit a notch below actuals; ratchet them up as coverage climbs.
- **Duplication** is measured on production code only (tests are excluded). The
  3% threshold is evaluated against the *lines* percentage. Some duplication is
  intentionally accepted (documented in the config and commit history) — don't
  chase it to zero.
- **Dead-code:** types used only within their own module must not be `export`ed,
  or knip flags them.

---

## Machine-readable verify (`verify:json`)

`bun run verify:json` runs the same gates but emits a single compact JSON object
instead of ~150 lines of human output — built for CI and AI/automation:

```jsonc
{ "ok": true, "ms": 18950, "failures": [],
  "gates": { "typecheck": { "ok": true, "ms": 2767, "metrics": { "errors": 0 } }, … } }
```

- Per-gate metrics are parsed from each tool (error counts, coverage %, clone
  count, vuln count, build time).
- Only **failing** gates carry a trimmed output excerpt, so a green run is tiny
  and a red run still has enough to act on.
- It runs **all** gates (collecting every failure) rather than stopping at the
  first, and exits non-zero iff any gate failed.
- Pass gate names to run a subset: `bun run verify:json typecheck lint`.

---

## Testing

Tests use `bun test` and live next to the code as `*.test.ts`. The suite is
currently **337 tests** at **~88% function / ~86% line** coverage.

Patterns used in this repo:

- **In-memory DB:** store/manager tests call `initStore(":memory:")` in
  `beforeEach`.
- **Env isolation:** tests that read `GH_*` env (auth/validation) save, clear,
  and restore those keys so they're deterministic regardless of a local `.env`.
- **Injectable clocks:** time-dependent code (session tokens, rate-limit
  windows) takes an optional `nowMs` param so expiry/window logic is testable.
- **Characterization first:** before refactoring uncovered code, a test is
  written that locks in current correct behavior — so a refactor can be proven
  behavior-preserving.
- **Dependency injection for I/O:** the manager's pipeline runner is swappable
  (`__setPipelineRunnerForTests`) so queue/SSE logic can be exercised without
  network; Octokit-facing helpers take the client as an argument.

Runes-based UI (`.svelte`/`.svelte.ts` using `$state`) can't be unit-tested
under `bun test`; that behavior is verified in the browser instead, and reactive
logic is extracted into rune-free, testable modules where practical.

---

## Discovery tooling

Beyond the hard gates, these surface issues the gates can't:

| Command | Tool | Purpose |
|---|---|---|
| `bun run deadcode` | knip | Unused files/exports/deps (a hard gate) |
| `bun run cycles` | madge | Circular imports (a hard gate) |
| `bun run dup` | jscpd | Duplication (a hard gate) |
| `bun run mutation` | Stryker | **Opt-in.** Mutates code to prove tests actually assert, not just execute |

Mutation testing is **not** part of `verify` (it's slow). It's scoped per-module
in `stryker.conf.json` and run against a module's own test file(s). Use it when a
module's tests look thin — a surviving mutant is an unasserted code path.

---

## Seeding the database

The seed script generates ~3,800 migrations (151 batches) across all states for
UI testing. It's idempotent — only touches rows with `seed-`-prefixed IDs.

```bash
bun run seed                 # writes to ./data/gh-migrate.db
bun run dev                  # dev server reads the same file
```

To seed inside a running container:

```bash
bun run seed
docker compose cp ./data/gh-migrate.db gh-migrate:/data/gh-migrate.db
docker compose restart
```

---

## Conventions

- **Fix root causes, not symptoms.** Don't silence a gate with `any`, a
  type-silencing `as`, a non-null `!`, an ignore comment, a skipped/weakened
  test, or a loosened config. If a suppression is genuinely correct (e.g. a
  typed third-party gap), justify it inline.
- **Every gate must stay green.** A change that fixes one thing but reddens
  another is a regression — fix it forward before moving on.
- **Small, atomic commits** with a clear message describing the root cause.
- **Verify before committing:** `bun run verify` (or `verify:json`) must pass.

See [CONTRIBUTING](../CONTRIBUTING.md) for the contribution workflow and
[Architecture](architecture.md) for how the pieces fit together.
