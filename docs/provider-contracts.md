# Provider Contracts

GitLab and Bitbucket integrations normalize provider responses into shared
source inventory and profile contracts before profile or migration code uses
them. Provider clients own authentication, pagination, response validation, and
bounded collection; they do not orchestrate migration lifecycles.

## Shared Inventory Rules

- Inventory is scoped to the requested namespace or configured project allowlist.
- Collection stops at the provider-neutral 10,000-project envelope.
- Every project has a stable provider ID, path, visibility, archive state, and normalized size observations.
- Numeric values distinguish exact, lower-bound, and unavailable observations.
- Invalid or cross-provider payloads fail before persistence.
- API-call accounting includes every actual paginated request and profile-collection request.

## GitLab

The client sends a private token to the configured GitLab API and percent-
encodes project paths. Discovery traverses namespace projects with explicit
pagination and requests statistics where available. Profile collection gathers
issues, merge requests, commits, branches, tags, and releases under bounded
concurrency and request budgets.

Native GHEC migration requests a project export, polls completion, downloads
the archive with a size and timeout bound, and records a durable export
checkpoint. GHES migration uses the external exporter and restores source lock
state after a safe terminal outcome.

## Bitbucket Server

The client uses server-owned credentials and rejects insecure HTTP unless the
administrator opts in. Discovery validates the minimum supported server
version, traverses configured projects and repositories, and normalizes paging
even when server responses omit optional totals.

Profile collection gathers commits, pull requests, branches, tags, and fork data.
Native GHEC migration starts the Bitbucket export and retrieves its archive from
shared home over pinned SFTP. GHES migration uses the read-only external
exporter and does not lock the source.

## Verification

Offline provider tests use deterministic HTTP fixtures and real clients to
assert headers, canonical paths, pagination, response parsing, bounds, and
failure classification. Credentialed checks under `tests/live` are opt-in and
must target disposable provider data.