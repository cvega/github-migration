# Security review: auth, sessions, credentials, grants

Review issue: `gh-migrate-dashboard-b0x.2` (child of epic `gh-migrate-dashboard-b0x`)
Branch: `cvega/gh-migrate-dashboard-b0x.2` at base `ee17bd9`
Type: defensive, read-only code review. No exploit code was written, no
vulnerability was reproduced, and no live system or remote service was contacted.

## Verdict

**No P0 or P1 findings.** The core invariants hold in the code that was
reviewed: no credential is persisted, request-scoped credentials are never
written to durable request options, and operator access is enforced
server-side with grants and job ownership revalidated at dispatch and recovery.
Nine hardening findings were filed (3 × P2, 6 × P3). None blocks production on
its own; the three P2 items should be fixed before an internet-facing
multi-operator deployment.

Priority scale: P0 blocks production, P1 fix before release, P2 fix soon,
P3 hardening.

## Scope and method

In scope: `src/lib/server/core/` (auth, sessions, GitHub clients, SSE, targets,
GHES target and SSH config), `src/hooks.server.ts`, `src/routes/**` (server
loads, actions, API handlers), request locals (`src/app.d.ts`), and the
application layer those routes call for grants, ownership and credential
scope (`application/self-service/*`, `migration-policy.ts`,
`core/credential-scope.ts`). To trace persistence and dispatch I also read the
migration manager, run recovery, queue, finisher and event modules under
`src/lib/server/migrate/`, plus the repository-analysis credential handling.

Method: read each entry point from request validation through policy,
persistence and public result, including the background dispatch and restart
recovery paths that execute the same operation later. Verification actually run:

| Check | Result |
|---|---|
| `bun install --frozen-lockfile` | up to date |
| `bun audit` | **No vulnerabilities found (checked 511 packages)**, exit 0 |
| `bun test src/lib/server/core src/lib/server/application/self-service src/lib/server/migrate/runs src/lib/server/migrate/manager.test.ts src/routes` | 318 pass, 0 fail, 57 files |

## Limitations

- This was a read-only source review. Nothing ran against a live deployment,
  so proxy and TLS behavior (`ORIGIN`, `ADDRESS_HEADER`, `XFF_DEPTH`),
  container hardening and the Docker socket override were assessed from code,
  Compose files and docs only.
- The full `bun run verify` gate was not run (docs-only change; focused tests
  above only). The focused run shows route and module coverage output but is
  not a full-suite pass.
- `bun audit` reflects the advisory data available when it ran. It covers
  declared npm dependencies, not the container base image or Alpine packages
  (those are scanned in `.github/workflows/verify.yml`, which was not run).
- Not reviewed in depth: provider-specific collectors under `source/`, the
  profile analysis worker beyond its credential handling, and Svelte component
  code. Page serialization was assessed at the server `load` boundary.
- Whether GitHub's migration `migrationLogUrl` ever carries a signed query
  string was not verifiable offline (see SEC-7).

## Findings

| ID | Beads issue | Priority | Title |
|---|---|---|---|
| SEC-1 | `gh-migrate-dashboard-730` | P2 | Throttle sign-in attempts atomically before password verification |
| SEC-2 | `gh-migrate-dashboard-lef` | P2 | Enforce administrator role inside every admin-only handler, not only in the request hook |
| SEC-3 | `gh-migrate-dashboard-b6r` | P2 | Stop persisting and logging raw provider error text and error objects |
| SEC-4 | `gh-migrate-dashboard-2uk` | P3 | Bound and normalize sign-in usernames before throttling and audit storage |
| SEC-5 | `gh-migrate-dashboard-1il` | P3 | Close open event streams when the viewing session ends |
| SEC-6 | `gh-migrate-dashboard-9ks` | P3 | Gate the `noSslVerify` option behind explicit administrator policy and audit it |
| SEC-7 | `gh-migrate-dashboard-lb6` | P3 | Validate and normalize migration log URLs before persisting or sending credentials |
| SEC-8 | `gh-migrate-dashboard-1o7` | P3 | Audit repository-analysis actions and CLI administrator password resets |
| SEC-9 | `gh-migrate-dashboard-any` | P3 | Fail closed when credential-scope parsing cannot derive a repository namespace |

Each issue is linked `discovered-from` this review issue and carries its own
acceptance criteria in Beads; the summaries below record the invariant that
fails and the files involved.

### SEC-1 (P2): sign-in throttle is check-then-act

- Invariant: failed-login limits (5 per user and address, 20 per address per
  15 minutes) should bound password guesses.
- Evidence: `src/routes/login/+page.server.ts` calls `isLoginThrottled()`,
  then awaits `verifyCredentials()`, and only afterwards `recordFailedLogin()`.
  Concurrent requests all read the same under-limit count. Each in-flight
  request also runs Argon2id with a 64 MiB memory cost before the limit
  engages, so the endpoint can be used to amplify memory use without
  authentication.
- Files: `src/routes/login/+page.server.ts`,
  `src/lib/server/core/auth/throttle.ts`,
  `src/lib/server/core/auth/users.ts`.
- Remediation: reserve the attempt atomically before verification, clear it
  on success, and cap concurrent Argon2 verifications.

### SEC-2 (P2): admin-only routes rely on one central allowlist

- Invariant: view access must not imply migration permission, enforced
  server-side.
- Evidence: operators are confined by the `operatorReads`/`operatorWrites`
  route-id allowlist in `core/request-handler.ts` (deny by default, 404). That
  layer is correct today and is tested. But only `routes/admin/*` and
  `account/password` call `requireAdmin`/`requireUser`. Handlers that use
  server-held source and target credentials or mutate migrations have no role
  check of their own: `POST /api/migrate`, `/api/migrate/batches*`,
  `confirm-restart`, global SSE, `POST /api/profile`, `profile/queue`,
  `profile/discover`, `/api/rate-limits`, the whole `/mannequins` page
  (including invitations made with the target token), `/migrate/stats`,
  `/setup`. A mistaken allowlist edit or route-id change would expose them.
- Files: see the Beads issue; primarily `core/request-handler.ts`,
  `core/auth/authorization.ts`, `src/routes/api/**`, `routes/mannequins`.
- Remediation: handler-level `requireAdmin`, per-route tests that call the
  handler with operator locals directly, and a route-inventory test that
  forces new routes to be classified.

### SEC-3 (P2): raw error text and objects reach persistence and logs

- Invariant: no raw provider errors, tokens, headers or signed URLs in
  persisted request options, user-visible failures, events or logs.
- Evidence: `migrate/runs/finish.ts` already replaces unexpected executor
  errors with a fixed message for exactly this reason, and the analyzer uses
  curated reasons. Other paths do not follow it:
  `migrate/ghes/import.ts` stores `error.message` as `failureReason` and in the
  GHES import checkpoint; `executors/bitbucket-to-ghec.ts` embeds remote status
  text; `github/upload.ts` throws and logs response bodies; `hooks.server.ts`
  `handleError` and several `console.error(..., error)` calls in API routes log
  whole error objects, including `cause`. These values reach
  `migrations.failure_reason`, admin page data and SSE.
- No concrete token-bearing path was demonstrated, and operators receive
  curated text only (`visible-events.ts`), so this is an enforcement gap
  rather than a confirmed leak.
- Remediation: one shared safe-error helper plus tests that inject
  token-, header- and signed-URL-bearing errors.

### SEC-4 (P3): unbounded, unauthenticated username storage

- Evidence: the login action writes the raw username field to
  `auth_login_attempts` and to `audit_events.metadata`. There is no length or
  pattern bound, `audit_events` is never pruned, and `auth_login_attempts` is
  pruned only at startup (documented). Users who paste a password into the
  username box leave it permanently in the audit trail.
- Remediation: reject over-length values and store a normalized or digested
  value when the input does not match the username policy.

### SEC-5 (P3): open streams outlive their session

- Evidence: `sseResponse()` authenticates only at connect. Logout, disable,
  password reset, role change, revocation and expiry do not close open
  `/api/migrate/events`, `/api/migrate/[id]/events` or
  `/api/profile/[id]/events` streams. Only administrators can open these
  (operators get curated JSON), so the exposure is limited to a revoked or
  demoted administrator's existing connection.
- Remediation: record the session token hash per stream and revalidate on
  keepalive or revocation.

### SEC-6 (P3): `noSslVerify` is available without policy or audit

- Evidence: administrators may set `noSslVerify` on any allowlisted GitHub
  source. It disables certificate validation for the Octokit agent and for
  archive downloads that carry the source credential, is persisted in
  `request_options`, is replayed on restart, and is not recorded in audit.
- Remediation: require an explicit environment opt-in naming permitted
  sources, audit use, and document it.

### SEC-7 (P3): migration log URL handling

- Evidence: `migrate/github/monitor.ts` sends the target bearer token to any
  `github.com` or `*.github.com` host and refuses `*.ghe.com` tenants. The raw
  `migrationLogUrl` is persisted and returned to administrators in page data,
  SSE snapshots and reports (operators get it blanked). Unverified: whether
  GitHub ever signs this URL.
- Remediation: derive the permitted host from the target profile, persist only
  validated, parameter-free URLs, and send the token only to that host.

### SEC-8 (P3): audit gaps

- Evidence: repository-analysis `startAnalysis`, `cancelAnalysis` and
  `retryAnalysisJob` (they trigger clones with the server source token) and
  the CLI `auth:reset` script write no `audit_events` row. Everything else
  reviewed (sessions, user and grant administration, migrations, batches,
  profiles, mannequins, target catalog, operator batches) is audited.

### SEC-9 (P3): credential-scope check can fail open

- Evidence: `sourceOrganizations()` in `core/credential-scope.ts` catches a
  `getSourceProjectIdentity` error, maps it to an empty string and filters it
  out, so an unparsable repository path is skipped by the server-credential
  namespace check. Today the zod schema and `newMigration()` reject such paths
  afterwards, so this is not exploitable, but the check should not rely on a
  later layer.

## What was verified and holds

Each item below was traced in code; the cited tests exist and passed in the
focused run.

**Credentials are not persisted, logged or serialized**

- Sessions: only SHA-256 digests of 256-bit random tokens are stored
  (`auth/sessions.ts`, `auth/schema.ts`); the cookie is `httpOnly`,
  `sameSite=lax`, `secure` when the origin is HTTPS. Password changes,
  resets, role changes and disabling revoke sessions; resolution re-reads role
  and `is_active` on every request.
- Passwords: Argon2id (m=64 MiB, t=3) with a dummy-hash comparison for
  unknown users, a 12-128 character policy, and temporary passwords from 144
  random bits with a forced change.
- Request credentials: `serializeRequestOptions()` (`migrate/validate.ts`)
  writes only an allowlist of nonsecret fields, and the persisted-options zod
  schema is `.strict()`, so tokens, app keys or signed URLs cannot round-trip.
  The in-memory queue holds request-scoped tokens only until dispatch.
  Recovery and restart rebuild requests from admitted identity plus server
  credentials, never from request-scoped ones.
- Server secrets (`GH_*_PAT`, app private keys, GHES admin PAT, SSH key,
  Bitbucket and GitLab credentials) stay in `process.env`. Layout and setup
  page data expose only mode, app/installation IDs, URLs, namespace lists and
  readiness booleans. `AuthUser` omits the password hash and
  `sessionTokenHash` is never returned from a load. `app.d.ts` locals are
  server-only.
- Operator read models are built from explicit column lists
  (`visible-jobs.ts`, `visible-events.ts`): no owner ID, request options,
  failure text or log URL, and events are rebuilt from a fixed vocabulary.
- Outbound credential use is constrained: archive downloads use
  `redirect: "manual"` plus an origin check before every hop; upload
  continuation URLs must keep the origin; the analyzer passes its clone
  header through `GIT_CONFIG_*` environment variables (not argv); exporter
  containers receive secrets by variable name (`-e NAME`), not value; SSH to
  GHES verifies a pinned host-key fingerprint with `timingSafeEqual`. Request
  GitHub source URLs must be HTTPS without credentials or query and match the
  administrator allowlist when request credentials are supplied.
- `bun audit` is clean.

**Grants, ownership and revalidation**

- Access is the exact tuple (source provider, API URL, namespace, target
  profile, target API URL, target org). Grants are filtered to active,
  non-password-pending operators and re-checked against current target
  configuration, credential scope and the latest completed inventory snapshot
  (`grants.ts`, `inventory.ts`). Migration permission is a separate flag
  (`can_migrate`) checked on submit (`submitOwnBatch`), cancel and restart.
- Dispatch: `launchPipeline` calls `ownedRequest()` for any job with an owner,
  so queued jobs are re-authorized when a slot opens. An unset policy throws
  instead of falling back to admin behavior. Recovery:
  `launchRecoveredPipeline` re-runs the same policy; a denied owner moves the
  job to `reconciliation_required` (because remote effects may exist) and
  never resumes silently. `jobs.test.ts` covers revoked, disabled and
  inventory-removed cases.
- Operator-reachable routes are an explicit list; every other route returns
  404 for operators (`request-handler.test.ts`). Operator routes that remain
  (`/api/profile/[id]`, `/api/migrate/[id]`, events, profile and migration
  pages) all take the scoped branch. `analysisRunId` is constrained to the
  profile run, so it cannot be used to read another run.
- Revoking a grant or disabling an operator does not stop an already running
  job. This is deliberate and tested ("admins may stop revoked jobs"): the
  operator can no longer cancel or restart, and an administrator can. It is
  noted here so the behavior is not mistaken for a gap.

**Request policy**

- Unsafe `/api/*` methods reject a mismatched `Origin`, JSON endpoints require
  `application/json`, SvelteKit form origin checks remain enabled, and the
  CSP is configured in `vite.config.ts`. Security headers, `private, no-store`
  for authenticated responses, and the metrics endpoint's separate bearer
  token (constant-time compare, fixed low-cardinality labels, disabled when
  unset) were all confirmed.
- Startup refuses contradictory authentication configuration and requires an
  explicit opt-in for unauthenticated mode outside development.

## Observations (no issue filed)

- Mounting the Docker socket into the dashboard (exporter override) is an
  opt-in, documented trade-off (`docs/configuration.md`,
  `docs/bitbucket-datacenter-to-ghes.md`); exporter containers are run
  read-only, cap-dropped and resource-limited. Treat the dashboard as
  host-equivalent in that configuration.
- Login throttling keys on the resolved client address. Without
  `ADDRESS_HEADER`/`XFF_DEPTH` behind a proxy, all users share one address
  bucket; this is documented in `docs/configuration.md`.
- Bootstrap credentials from the environment are not marked
  must-change; the value remains valid and in the deployment environment until
  rotated. Consider documenting rotation.
- Sessions have an absolute 7-day lifetime and no idle timeout.
