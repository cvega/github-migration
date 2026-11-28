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
- For direct tests in a fresh checkout, first run `bunx --bun svelte-kit sync`
  to generate aliases/types.
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
- Any DDL change bumps that domain’s `version` in its DomainStore, so older
  databases are rejected with the fresh-directory message instead of failing
  later on a missing column.
- This policy takes precedence over the history-preserving upgrade and legacy
  compatibility requirements elsewhere in the guidance.

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
- Prefer real in-memory SQLite tests.
- From 1.0 on, keep schema upgrades idempotent and history-preserving, and use
  file-backed fixtures to test reopening an upgraded store. Before 1.0, see
  Pre-1.0 policy.

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

- In the main checkout, the coordinator runs `git checkout main && git pull`
  before planning each wave. Start workers from up-to-date main.
- Start one worker per Beads issue with `--worktree new-child --name <issue-id>`.
  Workers commit on their own branches. The coordinator handles merges.
- The worker pushes its branch and opens a draft PR with the exact Beads issue
  title.
- The coordinator closes all referenced issues after merge, including when one
  PR covers multiple issues. After each merge, check `bd list --status in_progress`
  and `bd blocked` for stale entries.

## Commits, PRs, and Beads issues

- Use Conventional Commits for commit subjects, PR titles, and Beads issue
  titles. Use the types in `cliff.toml`. Put issue IDs only in the
  `Refs: <issue-id>` footers of commit messages and PR bodies, one per issue.
- Do not include `Co-authored-by`, `Generated with`, or other tool-attribution
  trailers in commits or PR bodies.
- For breaking changes, add `!` before the colon in the subject or title and
  include a `BREAKING CHANGE:` footer. Keep that footer as the last paragraph
  of the squash commit.
- Outside the main checkout, run `BEADS_DIR=<main checkout>/.beads bd ...`.
  Only the coordinator claims and closes issues. Before dispatch, the
  coordinator reads the acceptance criteria with `bd show <issue-id>` and
  claims the issue with `bd update <issue-id> --claim`.

## Agent selection and review

Compass routes only `claude` and `codex`. The coordinator explicitly selects
`copilot` and `qwen-code`. For Compass dispatches, check installed and enabled
agents with `orcacompass agents --json`, use a covering route's `launchArgs`,
and verify with `orcacompass verify --dispatch <dispatch-id>`. Use
`--no-downgrade` when the task requires the requested capability.

### Sensitive paths

- `src/lib/server/migrate/**`, `src/lib/server/core/auth/**`
- `src/lib/server/core/github.ts`, `src/lib/server/core/credential-scope.ts`,
  `src/lib/server/core/db.ts`, `**/database/schema.ts`
- `src/hooks.server.ts`, `src/routes/login/**`, `src/routes/account/**`
- `src/lib/server/schemas.ts`, `src/lib/server/core/auth.ts`,
  `src/lib/server/core/ghes-target.ts`, `src/lib/server/core/targets.ts`,
  `src/lib/server/application/self-service/**`

### Builder, in this order

1. Route P0–P1 work and work touching any sensitive path to Codex or Claude
   Code through OrcaCompass. Stop and reroute here if the scope grows to
   include a sensitive path. Wait for Compass capacity when needed. Copilot
   and Qwen are ineligible for this work.
2. Work is on the critical path if it blocks other ready work or the user is
   waiting for it. Route critical-path work to Codex or Claude Code through
   OrcaCompass. If Compass shows Codex or Claude Code near its usage limit,
   use Copilot for non-sensitive P2–P4 critical-path work.
3. Use Copilot for remaining work unless rule 4 applies. GitHub managed policy
   may set its model. Record the models Copilot reports and select a reviewer
   according to the reviewer selection rules. Run up to six
   Copilot builders concurrently. Pass `--model` only if the installed Orca
   supports overriding the selected agent's model.
4. Use Qwen only when the user asks, for one bounded, non-sensitive P3 task at
   a time. Give it an isolated child worktree and a narrow spec. Keep the model
   and Ollama endpoint in Qwen's local configuration. Give the worker no
   credentials or production data.

Run at most two Codex builders and two Claude Code builders concurrently.
Prioritize reviews over starting Codex or Claude Code builders. Run at most
three full `bun run verify` runs concurrently.

### Reviewer selection

Claude Code builds go to Codex, and Codex builds go to Claude Code. For Copilot
builds whose reported models are all from one family, use the other family
(Codex or Claude Code) as reviewer. If the models are mixed-family or unreported,
use Codex or Claude Code, whichever has more headroom per OrcaCompass.
Third-family builds (such as Gemini or MAI) may be reviewed by Codex or Claude
Code. Qwen-built work goes to Claude Code or Codex, with Claude Code preferred.
For sensitive changes, use Claude Code or Codex directly with its strongest
model at high effort. If an eligible reviewer is unavailable, wait or ask.

### How reviews run

Use one review worker per wave. Review only `git diff main...HEAD` and report
at most five findings per PR with `file:line`, or report “sound.” After fixes,
the same reviewer confirms that blockers are resolved, subject to the review bar.

### Fallback

Retry mechanical format, lint, and type failures with the same agent without
counting them as stops. After two design-level failures, or if Copilot is
unavailable, reroute to Codex through OrcaCompass, subject to the builder
limits and review priority, and record why.

### Record it

Record the effective builder and reviewer agent and model in every PR body;
for Copilot builds, record the models Copilot reports.
At each dispatch, record the builder choice and reason in a Beads comment on
the issue. On merge, add a Beads comment with the time to PR readiness and the
number of blocking review findings.

## Review bar

- Findings use the P0–P4 scale. Block only on P0–P2 findings with a concrete
  failing scenario; unauthorized access, credential exposure, and unsafe
  handling of uncertain remote writes count even without a reproduced wrong
  output. The coordinator files the remaining findings as one deferred P3 issue
  per PR; deferred findings never block merge.
- Allow at most one re-review per PR. Skip areas that had no above-P3
  findings in their last round. The PR is ready once blockers are resolved
  and only non-blocking notes remain.
- If a re-review finds a new P0–P2 introduced by the fix commits, stop and ask
  the human instead of another round.

## Parallel Orca workers

- Start each worktree with `bun install --frozen-lockfile`. Assign each parallel
  worker a unique `E2E_PORT` for its Playwright server.
- Before submitting, run the shared local/CI gate manifest with `bun run verify`.
  A change is docs-only when every changed file is `*.md` or under `docs/`; for
  those, run `bun run verify docs format`.

## Fixing review findings

- Before fixing, search for the same pattern in sibling code paths (other providers,
  other routes, other transports, UI and storage layers that carry the same data).
  Fix sibling occurrences of a blocking finding in the same PR, or file each as
  its own issue at the same priority; never put them in the deferred P3 issue.
- For behavior findings, start with a test that fails on main and make it pass.
- In the PR description, list the sibling paths you checked.
