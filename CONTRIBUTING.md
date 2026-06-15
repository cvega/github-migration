# Contributing

Thanks for your interest in improving the GitHub Migration Dashboard. This guide
covers the workflow and the quality bar a change has to clear.

For the full development reference (stack, gates, testing, tooling), see
[docs/development.md](docs/development.md).

## Workflow

1. **Branch** from the current working branch with a descriptive name
   (`fix/…`, `feat/…`, `refactor/…`, `docs/…`).
2. **Make a focused change.** Keep the diff scoped to one concern — avoid
   opportunistic refactors that widen the blast radius.
3. **Add or update tests.** New behavior needs a test; a bug fix needs a test
   that fails before the fix and passes after. Before refactoring untested code,
   add a characterization test that locks in current behavior.
4. **Run the gate suite** until it's green:
   ```bash
   bun run verify
   ```
5. **Commit atomically** with a message that explains the *root cause* and the
   fix, not just the symptom.
6. **Open a PR** describing the change, the reasoning, and how you verified it.

## The verify contract

Every change must pass `bun run verify` — typecheck, svelte-check (0 errors /
0 warnings), Biome lint + format, the coverage floor, duplication, dead-code,
circular-import, build, and audit gates. CI runs the same suite. See
[docs/development.md](docs/development.md#the-gate-suite-verify) for what each
gate enforces.

`bun run gates` gives the same result as a compact JSON summary, handy for
scripting or quickly seeing which gate failed.

## What not to do

A gate must be made to pass by fixing the underlying problem — **not** by:

- `any`, or an `as` cast / non-null `!` whose only purpose is to silence the
  compiler;
- `@ts-ignore` / `@ts-expect-error`, `biome-ignore`, or similar ignore comments;
- deleting, skipping, or weakening a test;
- loosening `tsconfig`, the Biome config, or any gate's strictness.

If a suppression is genuinely correct (e.g. a typed third-party gap), include an
inline justification comment explaining why.

## Conventions

- **Runtime:** Bun only — `bun` / `bun run` / `bun test`, never `node`/`npm`.
- **Style:** Biome owns lint + format; run `bun run format` before committing.
- **Svelte:** Svelte 5 runes only in new/edited code — no legacy `export let`,
  `$:`, or `on:click`. Prefer `$derived` over `$effect`-that-writes-state.
- **Server boundaries:** DB access, secrets, and auth live under `$lib/server/`;
  validate all external input with a Zod schema at the boundary.

## License

This project does not yet include a `LICENSE` file. If you intend to contribute,
open an issue to confirm the licensing terms first.
