# Repository Scripts

This directory contains repository automation for development, validation,
packaging, fixtures, provider diagnostics, and releases. These scripts are not
part of the dashboard request-handling runtime.

Run scripts through the commands in [`package.json`](../package.json) unless a
workflow or this document explicitly shows a direct invocation. Use Bun for all
TypeScript scripts.

## Verification

[`gates.ts`](gates.ts) is the release verification orchestrator:

```bash
bun run verify
```

It synchronizes SvelteKit once, runs the configured gates serially, and exits
non-zero when a gate fails. The default output is compact JSON for automation;
`bun run verify` enables verbose, fail-fast output for local use. Individual
gates can be selected when narrowing a failure:

```bash
bun run verify typecheck lint
```

The regular verification run validates mutation configuration but does not run
the full mutation suite. The expensive four-lane suite runs in the scheduled
mutation workflow or manually with:

```bash
bun run mutation --force
```

## Directory Map

| Path | Responsibility |
|---|---|
| [`auth/`](auth/) | Administrative recovery commands, including password reset. |
| [`checks/`](checks/) | Coverage, dependency, architecture, workflow, runtime, and mutation policy gates. |
| [`docs/`](docs/) | Generated semantic documentation and source-derived documentation checks. |
| [`fixtures/`](fixtures/) | Development and Playwright SQLite datasets. |
| [`packaging/`](packaging/) | Icon generation, production build patching, bundle budgets, and container smoke tests. |
| [`providers/`](providers/) | Manual GitLab and Bitbucket Server integration harnesses. |
| [`release/`](release/) | Version and changelog preparation. |
| [`tsconfig.json`](tsconfig.json) | TypeScript configuration for repository scripts. |

Files such as `boundary-policy.ts`, `mutation-manifest.ts`,
`semantic-docs-lib.ts`, fixture data modules, and `providers/harness.ts` are
support modules imported by executable scripts rather than standalone commands.

## Commands That Modify State

Review these commands before running them:

| Command | Effect |
|---|---|
| `bun run seed` | Adds or replaces development fixture records in `data/gh-migrate.db`. |
| `bun scripts/fixtures/seed-e2e.ts` | Deletes and recreates the `.e2e-data` directory. |
| `bun scripts/packaging/generate-icons.ts` | Rewrites `src/lib/icons.generated.ts`. |
| `bun scripts/packaging/generate-gitlab-metrics.ts` | Rewrites the `*.generated.ts` GitLab metric module lists. |
| `bun run docs:sync` | Rewrites generated sections in `docs/architecture.md`. |
| `bun run release:prep` | Updates the package version and `CHANGELOG.md`; it does not commit, tag, or push. |
| `bun run auth:reset --username <name>` | Resets an administrator password and revokes that user's sessions. |
| `bun scripts/providers/gitlab.ts` | Creates, seeds, tests, and removes the local GitLab provider environment. |
| `bun scripts/providers/bitbucket.ts` | Creates, seeds, tests, and removes the local Bitbucket provider environment. |

Provider harnesses require a working Compose implementation. They detect
`docker compose`, `podman-compose`, or `docker-compose`, redact known secrets
from output, and enforce startup and command timeouts. Their supported
subcommands are `config`, `up`, `ready`, `seed`, `test`, `diagnostics`, `down`,
and `run`; omitting a subcommand selects `run`.

## Adding Or Changing Scripts

- Add user-facing entry points to `package.json`; documentation checks reject
  documented `bun run` commands that do not exist.
- Keep executable orchestration in a small entry point and reusable policy or
  data in an importable helper module.
- Use deterministic inputs and explicit exit codes for verification scripts.
- Avoid loading local dotenv credentials in deterministic tests. Package test
  commands, the coverage gate, and both mutation process layers use
  `--no-env-file`; for direct tests, use `bun test --no-env-file <test-path>`.
  This does not clear explicitly exported variables or change development and
  opt-in live provider configuration.
- Add release-critical checks to `gates.ts` and expose useful metrics when their
  output is stable enough to parse.
- Update the owning workflow when a script changes CI, image, mutation, or
  release behavior.
- Run `bun run verify` before landing a change to repository automation.

See the [development guide](../docs/development.md) for test and architecture
conventions and the [deployment guide](../docs/deployment.md) for container,
backup, promotion, and recovery procedures.