# Authorization, credentials, and operator views

## Source map

Read `src/hooks.server.ts`, `src/lib/server/core/request-handler.ts`,
`src/lib/server/core/auth/`, and the affected module in
`src/lib/server/application/self-service/`. Credential scope is separate from
dashboard identity: see `core/credential-scope.ts`, `core/auth.ts`, and
`application/migration-policy.ts`.

## Preserve the two authorization layers

Dashboard authentication resolves sessions into request locals. Passwords use
the shared Bun Argon2id policy; persisted sessions contain token digests, not
cookie tokens. Preserve disabled/revoked/expired-session handling, forced
password change, final-administrator invariants, and mutation audit events.

An operator grant is an exact source-to-target route:

`(provider, source API instance, namespace) → (target profile, target API instance, organization)`

Source A → target X and source B → target Y do not authorize A → Y. A target
catalog entry is not a grant. Inventory visibility does not imply `canMigrate`.
Job visibility does not imply permission to cancel or restart another user's job.

Admission uses a selected grant ID and repository selection, then reconstructs
the route server-side. Recheck current grant, configured instance, repository
eligibility, and ownership at dispatch, restart, and recovery. An unset dispatch
policy must not silently mean administrator access. Inspect `self-service/jobs.ts`
and the manager's owned dispatch path, not only the HTTP handler.

## HTTP and presentation boundaries

- The request handler uses resolved route IDs, including page-data requests, to
  restrict operator routes. Updating a page alone is insufficient for access.
- Preserve API cross-origin mutation protection and private/no-store responses.
  Do not broaden public paths or introduce a cache that ignores user scope.
- Reuse `self-service/visible-jobs.ts` and `visible-events.ts` for operator data.
  Provider failure text, admin logs and signed artifact links are not safe DTOs.
- Preserve unauthenticated layout redaction. Hiding a control does not prevent
  secrets or operational names from being serialized in page data.

## Credential handling

Source and target credentials resolve independently. Request overrides are
conditional on configuration; server credentials remain constrained to their
configured sources and destinations. GitLab, Bitbucket, GHES target operations,
profiling and analysis have server-owned credential paths.

Persist approved nonsecret options and identities, never request credentials.
Check error propagation as well as successful responses: provider exceptions
can retain GraphQL variables, headers and signed URLs. Prefer an existing safe
error classification over logging or serializing the exception object.

## Tests to select

Use request-handler/auth tests, the matching self-service tests, route tests,
and `tests/e2e/scoped-dashboard.e2e.ts` for browser scope changes.

For affected paths, cover: unauthenticated access; admin access; allowed operator;
view-only grant; a crossed pair; another user's job; revoked or changed grant
before dispatch; changed configured instance; page-data and event/download
access; absence of sensitive values in returned/persisted data. Use synthetic
credential markers to assert redaction rather than real tokens.
