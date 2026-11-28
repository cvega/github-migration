# Repository development

This is the GitHub Migration Toolkit: a Bun/SvelteKit dashboard and a separate
repository-analysis worker sharing SQLite. Preserve migration correctness,
durable history, and access scope when changing behavior.

## Start here

- Read `CONTRIBUTING.md` and the relevant section of `docs/development.md`.
- Use `package.json`, `scripts/gates.ts`, production contracts, and nearby tests
  for current commands and behavior. Design documents can describe future work;
  an executor file or environment setting alone does not establish support.
- Use Bun at the version in `package.json` (currently 1.4.4). Server code depends
  on `bun:sqlite`; do not substitute Node, npm, or a different test runner.
- Install with `bun install --frozen-lockfile`. For direct tests in a fresh
  checkout, first run `bunx --bun svelte-kit sync` to generate aliases/types.
- Keep changes within the requested behavior. Preserve existing public payloads
  and durable schemas unless the task includes their migration or cutover.

## Ownership

| Location | Owns |
|---|---|
| `src/lib/server/application/` | Cross-domain policy, use cases, concrete adapters |
| `src/lib/server/core/` | SQLite primitives, auth, sessions, GitHub clients, SSE |
| `src/lib/server/source/` | Provider clients, configuration, discovery and collection |
| `src/lib/server/profile/` | Profile lifecycle, analysis, durable analysis jobs |
| `src/lib/server/migrate/` | Migration queue, executors, recovery, persistence and events |
| `src/lib/server/schemas.ts` | Durable-domain composition root |
| `src/routes/` | HTTP/page transport and UI composition |
| `src/lib/migrate/`, `src/lib/profile/`, `src/lib/source/` | Client-safe domain contracts and behavior |

`application` may compose core and domains. Core cannot import a domain or
application; domains cannot import application or sibling domains. Core and
domains cannot import the schema composition root. Use domain-owned ports and
`application/adapters` for cross-domain behavior. Provider implementations must
not import other providers; shared target protocols must remain provider-neutral.
Browser-capable code cannot import server modules. Do not add unclassified
production modules directly under `src/lib/server/`.

## Pre-1.0 policy
- Until 1.0 there are no supported deployments. Do not add compatibility for
  older databases, stored events, message strings, checkpoints, or environment
  variables. Change the current schema directly; a release may require a fresh
  data directory, stated in its release notes.
- Where other sections require history-preserving upgrades or legacy handling,
  they apply from 1.0 on.

## Contracts that matter

- Determine supported routes from `src/lib/source-provider.ts`,
  `src/lib/migration-target.ts`, application capabilities, and executor registry.
  Currently GitHub, GitLab and Bitbucket Server target GHEC; only Bitbucket Server
  targets GHES. GitLab-to-GHES is paused despite retained exporter code.
- A timeout, abort, or lost response does not prove a remote write failed.
  Preserve checkpoints and `reconciliation_required` when the outcome is unknown.
  A saved GHEC import ID resumes monitoring, not submission. Keep approved
  nonsecret request options and admitted source/target identity on restart.
- Keep batches and restarts on the shared queue. Preserve run-token ownership,
  settling capacity, transactional claims, and GHES serialization.
- Request-scoped credentials are not durable recovery credentials. Never put
  tokens, private keys, signed URLs, or raw provider error objects in persisted
  request options, user-visible failures, events, page data, fixtures, or logs.
- Use request locals for authenticated identity. Enforce exact source-to-target
  grants and job ownership server-side; view access does not imply migration
  permission. Revalidate current authorization at dispatch and recovery.
- Preserve exact, lower-bound, and unavailable observations. Missing provider
  data must not silently become a measured zero.
- Keep schema upgrades idempotent and history-preserving. Prefer real in-memory
  SQLite tests; use file-backed fixtures when testing reopen/upgrade behavior.

## Task-specific guidance

Read only the skill relevant to the work:

| Work | Skill file |
|---|---|
| Backend policy, migrations, providers, persistence, auth, analysis worker | `.agents/skills/github-migration-development/SKILL.md` |
| Svelte implementation and responsive behavior | `.github/skills/svelte-frontend-engineering/SKILL.md` |
| Product workflow or visual composition | `.github/skills/product-interface-design/SKILL.md` |
| `/styleguide` and system documentation | `.github/skills/design-system-reference/SKILL.md` |
| Live component specimens | `.github/skills/component-showcase/SKILL.md` |
| Fonts and text hierarchy | `.github/skills/interface-typography/SKILL.md` |

These explicit paths also allow agents to read existing `.github/skills` files
when their host does not discover that directory automatically. Do not load all
five frontend skills for an ordinary component fix. If a frontend skill names
Svelte MCP tools that are unavailable, use the installed project checks and
browser tooling and report that limitation; do not claim to have run the autofixer.

For UI changes, use Svelte 5 runes, existing components, Primer tokens, and generated
Octicons. Follow `docs/design-system/migration-workbench.md`. Keep server-only data
out of page serialization; expose approved client-safe DTOs. Check the affected
interaction and layout at desktop and 390px,
including long repository names, keyboard use, and relevant error/empty states.

## Verification and generated files

- During development, run the nearest behavior tests and relevant gates, e.g.
  `bun run verify boundaries` after changing server imports.
- Before submitting a development change, run `bun run verify` as required by
  `CONTRIBUTING.md`. It is the shared local/CI gate manifest. A focused pass is
  not a full-suite pass; report failures or unavailable prerequisites precisely.
- Use existing dependency-injection test hooks for external I/O/time. Restore
  overrides and environment changes. Keep provider tests deterministic and offline.
- Do not lower coverage thresholds, weaken architecture checks, or skip tests
  to make a change pass. The coverage gate enforces 90% lines and functions.
- Change production contracts/table metadata, then run `bun run docs:sync` and
  `bun run docs:check` for support-matrix, lifecycle, GHES phase, or durable-table
  changes. Do not hand-edit `BEGIN GENERATED` blocks in `docs/architecture.md`.
- Generate `src/lib/icons.generated.ts` with
  `bun scripts/packaging/generate-icons.ts`; do not hand-edit it.
- UI changes also need the affected configured Playwright workflow and visual
  inspection. Full `verify` includes E2E; production container smoke tests and
  image scans run separately in `.github/workflows/verify.yml`.
- Do not point seed, reset, recovery, or destructive scripts at an existing
  operator data directory for development verification. Use isolated fixtures.

Report the behavior changed, meaningful verification actually run, and any
remaining limitation. Development authorization does not itself authorize a live
migration, identity invitation, deployment, or production data reset.

## Branch rules for Orca workers
- The coordinator runs in the main checkout (on `main`). Before planning any wave:
  `git checkout main && git pull`. Workers are always created from up-to-date main.
- Every Beads issue gets its own worker started with `--worktree new-child`.
  Never use `--worktree current` for task work.
- Name the worktree after the issue: `--name <issue-id>` (e.g. github-migration-a1b).
- One issue per worker. Never put two issues in one worktree.
- Workers commit only on their own branch. Never commit to main, never merge.
- When done, the worker pushes its branch and opens a draft PR titled
  "<issue-id>: <issue title>".
- The coordinator (not the worker) closes the Beads issue after merge.
- When one PR implements several Beads issues, list every issue ID in the PR body
  (Refs:) and close all of them after merge. After any merge, check `bd list
  --status in_progress` and `bd blocked` for stale entries.

## Local Qwen and OrcaCompass
- Beads remains the durable task source. Before dispatch, inspect the issue and
  acceptance criteria with `bd show <issue-id>`, then claim it with
  `bd update <issue-id> --claim`.
- For bounded, low-risk coding tasks, the coordinator may explicitly select the
  local Orca agent `qwen-code`. Keep the current Qwen model and local Ollama
  endpoint in Qwen's host-local settings; do not copy credentials or machine-
  specific endpoint settings into the repository.
- Start Qwen with the normal one-issue, one-child-worktree workflow, for example:
  `orca orchestration worker-start --environment local --worktree new-child --base-branch main --name <issue-id> --agent qwen-code --setup run --task-title "<short title>" --spec "<issue, acceptance criteria, files in scope, and verification>"`.
- Qwen Code selects its model from its local configuration. Do not pass
  `--model` unless the installed Orca explicitly supports a Qwen model override.
  An Ollama model listed by another agent does not mean OrcaCompass can route
  the native Qwen agent.
- Before automatic routing, check `orcacompass agents --json`; use Compass only
  when it lists the intended agent as installed and enabled. Require an actual
  covering `route` result and pass its `launchArgs` to Orca. Use `--no-downgrade`
  when the task needs the requested capability level. Verify supported routed
  models with `orcacompass verify --dispatch <dispatch-id>`.
- For Qwen, verify the launched agent and effective local model from its Orca
  dispatch/transcript and Qwen's configured model. A successful worker report
  is not a substitute for tests: inspect its diff, run the relevant checks,
  and get an independent Codex or Claude review before merge. Leave the Beads
  issue open until merge.
- Start with one bounded local Qwen coding task at a time. Orca may give Qwen
  broad tool approval, so use an isolated child worktree and a narrow task
  specification; local inference does not by itself restrict filesystem or
  network actions. Do not give workers credentials or production data.
- Qwen runs well on the local GPU but is slower than Codex/Claude in agent
  loops. Use it when local-only execution matters (offline, private code),
  not for parallel waves; one Qwen worker at a time.

## Parallel Orca workers
- Each worker runs in its own worktree and starts with `bun install --frozen-lockfile`
  (gates refuses to run without node_modules).
- While other workers may be running, verify with every gate except e2e:
  `bun run verify icons typecheck check lint format docs coverage dup deadcode cycles boundaries actions provider-fixtures runtime mutation-config build audit`
- Mechanical gate failures (format, lint autofix, type errors) are fixed and retried, not counted as stops. Stop only on a design-level failure or after 3 attempts.
- Run the full `bun run verify` (including e2e) only for UI changes, and only
  when no other worker is running e2e. CI runs the full suite on the PR regardless.
- If e2e fails with a port-in-use error, that is a collision, not a code failure:
  do not change code for it; report it and retry later.

## Fixing review findings
- Before fixing, search for the same pattern in sibling code paths (other providers,
  other routes, other transports, UI and storage layers that carry the same data).
  Fix every occurrence in scope, or file a linked issue for each one you leave.
- Start with a test that fails on main for the finding's scenario; make it pass.
- In the PR description, list the sibling paths you checked.

## Cross-review
- Claude (claude-sonnet-5-5) reviews any change to auth, sessions, credentials,
  migration recovery/queue/GHES, or schema upgrades, at any priority, while
  Claude session usage is under 50%. Above 50%, Codex with a different model
  than the builder.
- Everything else: Codex with a different model than the builder.
- One review worker per wave; diff only; at most 5 findings per PR with
  file:line, or "sound".
