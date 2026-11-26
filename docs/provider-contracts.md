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
pagination and requests statistics where available. For each selected project,
profiling collects issues, merge requests, commits, branches, tags, and releases
under bounded concurrency and request budgets.

Native GHEC migration requests a project export, polls completion, downloads
the archive with a size and timeout bound, and records a durable export
checkpoint. GitLab-to-GHES execution is paused; configuring a GitLab exporter
does not enable it.

## Bitbucket Server

The client uses server-owned credentials and rejects insecure HTTP unless the
administrator opts in. Discovery validates the minimum supported server
version, traverses configured projects and repositories, and normalizes paging
even when server responses omit optional totals.

For each selected repository, profiling collects commits, pull requests,
branches, tags, and fork data. Native GHEC migration starts the Bitbucket export
and retrieves its archive from shared home over pinned SFTP. GHES migration uses
the read-only external exporter and does not lock the source. See
[Bitbucket Data Center to GHES](bitbucket-datacenter-to-ghes.md) for deployment and a pilot.

On the Migrations list and batch detail pages, Bitbucket-to-GHES results show **Bitbucket API → GHES
import over SSH**. This describes the transport, not a health check. GitHub
source results retain the source credential indicator; cloud targets retain
the target credential and GitHub service status. Indicators that do not apply
to every visible route are omitted.

Provider credentials, archive limits, timeouts, project scopes, and SSH pinning
are listed in [Configuration](configuration.md).

## Verification

Offline provider tests use deterministic HTTP fixtures and real clients to
assert headers, canonical paths, pagination, response parsing, bounds, and
failure classification. `bun run verify provider-fixtures` also checks that the
live contract modules load and the pinned Compose manifests have the required
services and health checks. This is an offline input check, not a live test.

The scheduled [GitLab](../.github/workflows/gitlab-provider.yml) and
[Bitbucket](../.github/workflows/bitbucket-provider.yml) workflows create disposable
provider instances, seed repositories, and exercise the production discovery and
profile clients. Each checks all 101 paginated entries and the seeded per-repository
metrics. GitLab also exports a project and verifies the downloaded repository bundle.

On a dedicated runner, install dependencies and run `bun run verify provider-fixtures`
first. `bun scripts/providers/gitlab.ts config` and `bun scripts/providers/bitbucket.ts config`
validate Compose without starting services or using a license. The `run` subcommand
starts, seeds, tests, and removes the stack **including its volumes**; reserve
loopback ports 8929 (GitLab) and 7990 (Bitbucket) for the fixtures. Do not run
these harnesses against an operator instance. Bitbucket `run` requires the runner's
`BITBUCKET_PROVIDER_LICENSE`; no license or provider credentials belong in the checkout.