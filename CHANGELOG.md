# Changelog

All notable changes to this project are documented in this file.
Commit conventions follow [Conventional Commits](https://www.conventionalcommits.org).
## [0.2.0] - 2026-06-15

### ♻️ Refactoring

- **profile:** Merge org rulesets into the resources-to-recreate box
- **profile:** Dedup summary tiles, add org composition (stale/empty/archived %)
- **profile:** Count commits via REST Link header, not a graph walk

### ⚡ Performance

- **profile:** Read Pages from discovery, drop the per-repo /pages probe

### 🎨 Styling

- **profile:** Refine the rate-limit pill and header spacing

### 🐛 Bug Fixes

- **profile:** Keep repo chips on one line (no mid-label wrap)
- **profile:** Clean repo table — drop owner prefix, fix metadata separators

### 🚀 Features

- **profile:** Add Active % to the org composition row
- **profile:** Webhooks/Pages/code-scanning signals, API-call counting, risk ordering
## [0.1.0] - 2026-06-15

### ♻️ Refactoring

- **profile:** Use the shared Pagination component for the repo list
- **profile:** List repos via REST, gather counts via batched GraphQL
- **profile:** Two-pass crawl — cheap counts first, verification later
- Replace GEI wording with "GitHub export"

### ⚡ Performance

- **profile:** Batch the cheap totalCount pass wide + add fork/ruleset signals
- **profile:** Fix GraphQL 502 timeouts by shrinking the augment query
- **profile:** Release-partition the augment pass + concurrent chunks

### 🐛 Bug Fixes

- **profile:** Make discovery 502-resilient and the repo list non-fatal
- **profile:** Cap augment repo-batch at 10-15 (FULL=10, LITE=15)
- **profile:** Survive GitHub GraphQL timeouts + add crawl observability
- **profile:** Scope repo rulesets to includeParents:false + handle null
- **csp:** Detect dev via argv so HMR websocket isn't blocked
- **ci:** Commit CHANGELOG.md on the first release

### 📚 Documentation

- Document the Profile API and correct the gate count
- **development:** Document the release:prep flow

### 📦 Build & Tooling

- **release:** Add git-cliff version-bump script

### 🚀 Features

- **profile:** Add client-side search and pagination to the repo list
- **profile:** Detect workflow run history (.github/workflows)
- **profile:** Gather org-level resources (secrets, runners, properties)
- **profile:** Gather org rulesets via REST
- **profile:** Detect oversized release assets (>10 GiB)
- **profile:** Migration summary + duration estimate
- **profile:** Drill into a repo for its individual counts
- **profile:** Add per-metric icons to the scale and summary tiles
- **profile:** Collect content counts, batch augment, size blockers

### 🧹 Chores

- **scripts:** Rename verify:json to gates and align gate file names
## [0.0.3] - 2026-06-14

### 🐛 Bug Fixes

- **docker:** Patch base image OpenSSL to clear the release scan
- **lint:** Scope Biome's Svelte-template a11y rules to off

### 📦 Build & Tooling

- **deps-dev:** Bump the js-minor-patch group with 5 updates
## [0.0.2] - 2026-06-14

### ♻️ Refactoring

- **server:** Extract GEI operations into migrate/github-ops
- **lib:** Group domain modules under lib/migrate and lib/profile
- **server:** Move the migration domain into server/migrate
- **server:** Move github, auth, and validate into core
- **server:** Split the database into core/db + per-domain stores
- **server:** Introduce server/core for shared leaf primitives
- **profile:** Rename "gap" to "consideration" across the registry, engine, and UI
- **routes:** Namespace the migration API under /api/migrate
- **routes:** Move the migration UI under /migrate
- **deadcode:** Remove unused exports flagged by knip
- **ui:** Extract shared CancelConfirmModal component
- **ui:** Extract shared RestartModal component
- **sse:** Extract rune-free reconnecting EventSource client
- **migration:** Extract startArchiveExports() helper
- **cleanup:** Single gate list + describeCleanupGates (for modal)
- **auth:** Rename auth mode 'pat' -> 'request-pat'
- **validation:** Remove dead hand-rolled validators
- **api:** Validate POST bodies with Zod schemas
- **dry:** Extract request base type, auth resolver, batch SQL; test pipeline finalize
- **dry:** Extract API request validators; tighten dup gate
- **dry:** Extract pagination param parser and SSE response factory
- **dry:** Extract shared UI helpers (timeAgo, state display, report)
- Share migration form state and modernize restart modals
- **github:** Dedupe throttle options, drop dead branch
- **ui:** Extract shared AuthModeFields component

### ⚙️ CI/CD

- Add Dependabot for deps, actions, and Docker
- Bump actions to Node 24 runtimes
- Surface failing test names in the coverage gate
- Remove ci.yml, superseded by the pr/main/verify workflows
- Split into PR / main / release workflows with a reusable gate
- Run the full verify suite in CI and release (gate parity)
- Enforce test, coverage, and audit gates on PRs

### 🎨 Styling

- **lint:** Enforce import organization in the verify gate
- **test:** Apply Biome formatting to github.test.ts
- Use yellow-400 for all yellow text to match pills

### 🐛 Bug Fixes

- **health:** Make /api/health a public liveness probe (fixes Docker healthcheck)
- **build:** Make the prepare script safe for production installs
- **test:** Make the store and credential suites order-independent
- Generate .svelte-kit before gates so CI passes on a clean checkout
- **test:** Spread real modules in mock.module to stop cross-file leaks
- Generate .svelte-kit before gates so CI passes on a clean checkout
- **scripts:** Typecheck scripts/ and fix the real errors it surfaced
- **github:** Fail closed on an unparseable GHES version (A06)
- **security:** Stop leaking raw error messages from API 500s (A02/A10)
- **dup:** Use jscpd v5 ignorePattern key so tests are actually excluded
- **test:** Make validateAuthAvailable tests hermetic
- **ui:** Center the restart modal for better alignment
- **cleanup:** Confirmation gate tracks live input, not a pre-fill
- **cleanup:** Center the cleanup modal
- **types:** Remove remaining non-null assertions via narrowing
- **types:** Remove non-null asserts, dead suppression, unchecked cast
- **stats:** Make Top Source Organizations bars meaningful
- **security:** Re-enable CSRF origin check; document ORIGIN for TLS proxies
- **github:** Enforce GHES >= 3.15 to match documented minimum + tests
- **upload:** URL-encode archive name in single-upload query string
- **security:** Enforce server-side session token expiry
- **seed:** Correct import paths after script moved into scripts/
- **auth:** Set session cookie secure flag based on HTTPS
- **ui:** Use client-side navigation for batch link

### 📚 Documentation

- Split the README into a docs/ directory + landing page
- **test:** Justify the FakeClient third-party-type casts
- De-market capabilities, expand SSE, document custom logo
- Bump coverage badge to 82%
- Refresh dashboard screenshots
- Document test workflow and fix env/ignore accuracy
- Trim duplicated compose YAML and condense API table
- Condense Project Structure tree in README

### 📦 Build & Tooling

- **verify:** Add a boundary check that enforces the server layering
- **verify:** Add verify:json — compact JSON gate summary for agents
- **make:** Sync Makefile with current gate suite
- **discovery:** Add madge (cycles gate) + stryker (mutation, opt-in)
- **deadcode:** Wire knip in as a permanent gate; resolve its findings
- Align Bun version and harden container
- **dry:** Tighten duplication threshold 3.5 → 3 (now at 2.64%)
- **dry:** Pin jscpd as devDependency so the dup gate is deterministic
- **dry:** Add jscpd duplication gate to verify
- Add full gate suite + bun test harness with characterization tests

### 🚀 Features

- **profile:** Recover interrupted profiling runs on startup
- **profile:** Add per-repo migration insights
- **profile:** Stream live run progress over SSE
- **profile:** Add the /profile workspace UI and API (slice 5)
- **profile:** Add the synchronous profile runner (slice 4a, orchestration)
- **profile:** Persist profiling runs and per-repo results (slice 4a, persistence)
- **profile:** Add the gap-analysis engine (Profiler slice 3)
- **profile:** Add per-repo GraphQL signal augmentation (Profiler crawl, slice 2)
- **profile:** Add org repository discovery (Profiler crawl, slice 1)
- **profile:** Add a workspace landing page at /
- **profile:** Add the GEI gap registry
- **ui:** Server-config defaults, queue-on-cap, accurate counts, modal/color polish
- **cleanup:** Guarded confirmation modal + docs (Phase 3)
- **cleanup:** Guarded rename/delete service + endpoint (Phase 2b-2)
- **cleanup:** Pure eligibility evaluator + config (Phase 2a)
- **provenance:** Track target-repo origin for safe cleanup
- **validation:** Add Zod request schemas (server-only)
- **notifications:** Add navbar activity bell
- **search:** Repo/org/ID search across migrations and batches
- **dashboard:** Enrich overview tiles with global state metadata
- **dashboard:** Add clickable section overview bar
- **card:** Add copy-error button to failed migration cards
- Add migration statistics dashboard and segment bar component
- Add logo loading state management for improved visibility
- Update logo size in README for improved visibility
- Enhance header layout with logo and improved styling for migration stats

### 🧪 Testing

- **session:** Cover rate-limit window expiry (found via mutation)
- **api:** Characterize POST endpoint validation contract
- Cover pipeline SSRF, auth-mode, and throttle helpers
- Emit-handler state machine + github helpers; coverage visibility (Tier 2/3)
- Cover security + operational logic (Tier 1)
- **manager:** Add pipeline-runner seam and orchestration tests
- **store:** Characterize SQLite persistence layer

### 🧹 Chores

- Comment out GH_ALLOW_CREDENTIAL_OVERRIDE in .env.example
- Comment out GH_ALLOW_CREDENTIAL_OVERRIDE in .env.example
- Remove outdated README screenshots section
- **ts:** Enable noUncheckedIndexedAccess, narrow all index access
- **ts:** Enable noImplicitOverride (free ratchet)
- **security:** Pin picomatch & cookie via overrides to clear audit
- **biome:** Sync config schema to installed 2.4.16
- **deps:** Upgrade all dependencies to latest
## [0.0.1] - 2026-02-17

### ♻️ Refactoring

- Centralize database schema management and update dependencies
- Update getRepoCounts calls to use GraphQL clients

### 🐛 Bug Fixes

- Remove trailing newline in applySchema function for cleaner code
- Remove unnecessary newline in initStore function for cleaner code
- Update GitHub status label from 'Operational' to 'Healthy'
- Update error handling in migration functions for clearer terminal state reporting
- Update README for improved clarity and structure, add missing badges
- Guard against null terminalPhase after monitor exits on cancel
- Cancellation flow — signal forwarding, state logic, spurious failure event
- WarningsCount overwrite, archiveSource in batch, SSE tracking cap, XFF spoofing, debounce leak
- Remove double error log in recoverOrphans, document event mutation
- **security:** Enable CSP nonces, remove unsafe-inline for scripts
- **upload:** Stream archives from disk, remove buffer double-copy
- Type-safe narrowing, SSE event IDs, source counts passthrough
- **manager:** Extract shared emit handler and pipeline result helpers
- Phase 2 — store/query optimizations
- Phase 1 — foundation utilities
- Update font files for Mona Sans and Mona Sans Mono
- Simplify font-face src declarations for Mona Sans and Mona Sans Mono
- Update type assertion for parsed data in batch and migration POST handlers
- Define Error interface with message property in app.d.ts
- Add missing Bun reference for seed script

### 🚀 Features

- Add release workflow for automated build and publish on version tags
- Enhance migration handling with support for request options and auth mode persistence
- Update Dockerfile and entrypoint.sh for improved volume ownership handling
- Update README with new features, improved auth handling, and architecture details
- Enhance migration and upload handling with support for env-pat authentication and improved retry logic
- Enhance Makefile with linting and formatting commands; refactor code for readability
- Implement AuthPill component for displaying authentication rate limits and integrate it into relevant pages
- Add batch link and GitHub status display in batch detail page
- Enhance authentication handling with support for environment PATs and improved context management
- Implement cookie-based session authentication with login/logout functionality
- Add .env to .gitignore for environment variable management
- Increase icon size in restart modals for better visibility
- Add restart functionality for failed/cancelled migrations
- Enhance progress bar visualization with segmented display for migration states
- Implement migration queue management with state updates and UI enhancements
- Enhance migration functionality with improved error handling, state management, and new utility functions
- Enhance CI workflow with linting step and concurrency management
- Integrate GitHub status API and display status in the dashboard
- Add meta description to app.html for SEO
- Add response compression for HTML/JSON and update GitHub logo
- Add database seeding script for stress-testing and include favicon
- Add CI workflow for linting, building, and Docker deployment
- Implement crash recovery for in-flight migrations with new schema and logic

