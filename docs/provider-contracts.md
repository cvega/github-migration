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
pagination and reuses any statistics returned by the group listing. For projects
whose listing statistics are null or missing, inventory requests
`GET /projects/:id?statistics=true` with at most four requests in flight and the
client's existing timeout and retry limits. Listing calls, detail calls, and
retries all count toward the cutoff for optional detail calls: 10,000 attempts
for a direct caller, and for a profile run that cutoff or the profile request
budget below, whichever is reached first.
Required listing pages can still finish after that cutoff. A failed detail
request or exhausted budget leaves the project in the inventory with
unavailable observations. Source storage
reports job and pipeline artifacts separately, along with snippets and container
registry storage. The project statistics commit count is retained in inventory
alongside the default-branch commit metric collected during enrichment.

For each selected project, profiling collects issues, merge requests, commits,
branches, tags, releases, CI configuration, and protected branch and tag rules
under bounded concurrency and request budgets. Protection rule counts are separate from ref
counts: project branch rules exclude rules inherited from a group, inherited
rules are counted once per project by merging the project's `inherited` flags
with `GET /groups/:id/protected_branches` (read once per run, and only when the
profiled namespace is a top-level group), and a wildcard rule counts once.
A rule without an `inherited` flag is classified only by a complete group list;
otherwise only flagged rules count, as a lower bound when the request budget
cut the evidence short and as unavailable (with the group list's reason) when
the group list is unsupported, forbidden or not reported.
HTTP 401/403 on these lists records `forbidden`, a project 404
`not-found-or-hidden`, and a group 404 `not-reported` (the endpoint needs
Premium or Ultimate); the profile continues. The source profile flags the
total as protection rules to recreate, because the importer does not migrate them.

Each profile metric is a set of files that share one stem. The client-safe
`src/lib/source/gitlab-metrics/<stem>.metric.ts` declares the key, collection
`order`, any extra stored fields and the "Repository contents" card with its
display `position`; `<stem>.fixture.ts` holds a valid stored observation; and
`src/lib/server/source/gitlab/metrics/<stem>.collector.ts` binds the collector to
the same key. Adding a metric adds these three files and nothing else:
`bun scripts/packaging/generate-gitlab-metrics.ts` regenerates the
`*.generated.ts` module lists (no `import.meta.glob`, because the analysis worker
and scripts run under Bun without Vite), the `gitlab-metrics` gate fails when they
are stale, and a missing or mismatched file is rejected at generation, compile
and load time. Keys, `order` and card `position` must each be unique. Tests and seeds that need
complete stored metrics call `gitLabMetricFixtures(overrides)` from
`src/lib/source/gitlab-metrics/fixtures.ts` and override only the metrics their
scenario is about, so a new metric never edits them;
`tests/scripts/gitlab-metric-extension.test.ts` proves it by adding a probe metric
to an isolated copy of the tree and running the affected tests and type check. A profile run has one request budget
(`GITLAB_SOURCE_PROFILE_REQUEST_BUDGET`) shared by inventory statistics requests
and every collector. It counts every attempt from the start of the run, including
listing pages, retries and further pages, and concurrent workers cannot exceed it.
Once it is spent no further budgeted calls are made and the profile still
completes: counts already partly enumerated stay lower bounds, a commit count
whose default-branch head id (non-blank) was read stays at least one, and everything else is
unavailable with reason `request-budget`. Expired authentication (HTTP 401) is
not a budget outcome and still fails the profile.

CI configuration detection uses only same-project metadata: `GET /projects/:id`
for `builds_access_level`, `ci_config_path` and `auto_devops_enabled`, then a
`HEAD` request for the local config file (default `.gitlab-ci.yml`) at `HEAD`.
Because GitLab also answers 404 when the repository is hidden, a missing file
counts as absent only after a `HEAD` request confirms the default branch is
readable (or the inventory reports an empty repository); otherwise the result
stays unavailable.
Cross-project (`path@group/project`) and external URL references are classified
without being requested, and raw paths and file contents are not retained. The
per-project value is 1 when GitLab CI needs conversion to Actions (local file
found, external reference, or enabled Auto DevOps without a local file) and 0
when CI/CD is disabled or no file exists and Auto DevOps is disabled; the scope
records which case applied and that the importer generates no Actions workflow.
On these optional requests HTTP 401 or 403 records `forbidden`, 404 records
`not-found-or-hidden`, and an omitted setting (for example Auto DevOps below Maintainer) records
`not-reported`; the profile continues, while an expired token still fails it
through the required metrics. Enabled Auto DevOps keeps a project
counted when the file probe is forbidden or refused for budget.

CI/CD variable counts never receive a variable: the list endpoints return names
and values and cannot be field-selected, so the collector sends only
`HEAD /projects/:id/variables?per_page=1` and `HEAD /groups/:id/variables?per_page=1`,
never reads a body, and uses `X-Total`; a missing total stays `not-reported` even when
a next page is announced. It never falls back to `GET`. The observation is the
project-local count; the group-local count over admitted ancestor groups (each read
once per run) is the separate `groupLocal` field. HTTP 401/403 records `forbidden`,
404 `not-reported`, 405/501 `unsupported`; contradictory pagination headers (for example a next page with one total page, or a
single entry with zero total pages) are `malformed`;
each attempt spends the shared request budget. Nothing is logged and no name, value
or environment scope is stored.

Merge request approval evidence comes from paginating
`GET /projects/:id/approval_rules` for selected projects. The profile stores a
visible rule count and whether a rule requires approvals, including whether
any required rule explicitly targets protected branches. Approvers, rule
names, branch names, and raw responses are not stored. It does not read
experimental group rules or per-merge-request overrides. HTTP 401/403 is
`forbidden`; a hidden or unlicensed endpoint (404) is `not-reported`. The
profile continues and preserves counts already observed as lower bounds when
access or budget cuts pagination short. Missing evidence does not establish
that approvals are optional. Recreate required approval policies on GitHub;
imported review history does not enforce them.

Branch, tag, and release counts enumerate all pages; a missing `X-Total` does
not make them unavailable. Malformed or contradictory pagination evidence
keeps the count unavailable rather than reporting zero or a partial count.
The server logs the affected endpoint family and the client's validation
failure, without response bodies, header values, project paths, or credentials.

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