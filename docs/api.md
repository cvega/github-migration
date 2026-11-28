# API Reference

Endpoints return JSON except Server-Sent Event streams and the Prometheus
metrics endpoint. Protected deployments require the dashboard session cookie
obtained from `/login`, except for metrics, which uses a separate bearer token.
Validation failures return `{ "error": "..." }` with an appropriate 4xx
status. Credentials are accepted only by documented migration requests and are
never returned.

Named operators can use only the profile and migration operations authorized by
their assignments. Unassigned resources and administrative endpoints are not
discoverable through the operator session; equivalent page and API access
checks apply regardless of whether a link is visible.

## Operations

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Process liveness probe |
| `GET` | `/api/ready` | Database and startup readiness probe |
| `GET` | `/api/metrics` | Token-protected Prometheus migration metrics |
| `GET` | `/api/rate-limits` | Provider quotas, active count, and GitHub status |
| `POST` | `/api/profile` | Start a provider profile |
| `POST` | `/api/profile/queue` | Discover and queue enterprise profiles (`sourceProvider`, `scope: "enterprise"`, `enterprise`: GitHub enterprise slug or GitLab group). Returns `422` when no namespace remains after the configured scope and `502` with a safe `reason` when discovery fails |
| `GET` | `/api/profile/queue` | Read pending and failed-to-start counts for `provider` |
| `GET` | `/api/profile` | List profile runs |
| `GET` | `/api/profile/discover` | Discover a page of visible namespaces for `provider`; pass the returned `next` as `cursor` |
| `GET` | `/api/profile/:id` | Read profile status and paginated repository detail |
| `POST` | `/api/profile/:id` | Queue `{ "grantId": "...", "repos": ["repo"] }` for an operator's assigned source and destination. The grant must belong to this user, match this report's source and permit migration. |
| `GET` | `/api/profile/:id/events` | Stream profile progress and terminal state |
| `POST` | `/api/migrate` | Start one repository migration |
| `GET` | `/api/migrate` | List or search migrations |
| `GET` | `/api/migrate/activity` | List recent migration activity |
| `GET` | `/api/migrate/events` | Stream events across all migrations |
| `POST` | `/api/migrate/batches` | Start a normalized migration batch |
| `GET` | `/api/migrate/batches` | List migration batches |
| `GET` | `/api/migrate/batches/:id` | Read a batch summary and paginated members |
| `DELETE` | `/api/migrate/batches/:id` | Request cancellation for active batch members |
| `POST` | `/api/migrate/batches/:id/restart` | Restart eligible batch members |
| `GET` | `/api/migrate/:id` | Read migration detail and persisted events |
| `DELETE` | `/api/migrate/:id` | Request migration cancellation |
| `GET` | `/api/migrate/:id/events` | Replay and stream one migration's events |
| `POST` | `/api/migrate/:id/confirm-restart` | Attest that remote work is inactive after review, including a legacy failed GHES import holding its batch |
| `POST` | `/api/migrate/:id/restart` | Restart an eligible migration |

## Pagination

List endpoints accept positive `page` and `limit` query parameters and clamp
limits to their route maximum. The migration list accepts `q`. Profile
repository detail accepts `search` and `readiness`; `view=status` returns only
run status and `view=repos` returns only the filtered repository page.
For Bitbucket profiles, `view=lfs` downloads the captured repositories' default
branches and root LFS tracking-rule observations (`found`, `none`, or `unknown`) as JSON.
`view=activity&page=1` returns paged repository review
observations and coverage across the whole captured inventory.
Statistics routes add their documented UI filters. Responses include the
selected page, total rows, total pages, and effective limit.

## Starting Migrations

Single requests identify `sourceProvider`, source API/organization/repository,
target profile and organization/repository, plus optional credentials and
execution options. Every new batch requires an explicit `targetProfileId` (`ghec`
for Cloud, or the configured GHES profile ID). All items share that destination;
to change platforms, create a new batch rather than restarting the old one.
Batch requests carry the common source/target configuration
and either a bounded `repos` path list or an `items` mapping list. Each `items`
entry identifies `sourceRepo` and may override `targetRepo`. The server
validates provider scope, target support, duplicate identities, credential
policy, and the maximum batch size before persisting work. When a batch refers
to a completed GitHub profile, each selected repository with profile warnings
or blockers must have a successful repository analysis result. The server
rejects missing, active, failed, or cancelled analysis jobs for those
repositories. Clear repositories remain eligible without analysis, and GitLab
and Bitbucket Server batches do not use this gate.

The intentional cutover removed the former `/api/migrate/migrations` prefix.
There are no compatibility aliases.

## Browser Workflows

Repository analysis is started, cancelled, and retried through form actions on
the profile detail page; its latest detail is returned by
`GET /api/profile/:id`. Mannequin discovery and attribution invitations are
form actions on `/mannequins`. Neither workflow currently exposes a public REST
mutation endpoint.

## Server-Sent Events

Event streams use `text/event-stream`. Migration event IDs are durable numeric
cursors. Clients may reconnect with `Last-Event-ID` or the `after` query
parameter; only non-negative integer cursors are accepted. A bounded replay is
sent before the connection subscribes to live events. Terminal per-resource
streams close after their final frame.

The global migration stream can contain events from any migration. Consumers
must route each event by its `migrationId` rather than assuming one active
repository.

## Probes

`GET /api/health` proves that the HTTP process can respond. `GET /api/ready`
also verifies that initialization completed and SQLite can acquire a write
transaction. Deployments should use readiness, not health, before routing
operator traffic.

## Prometheus Metrics

Set `GH_MIGRATE_METRICS_TOKEN` in the dashboard process environment to enable
`GET /api/metrics`. Use a separate, cryptographically random token without
whitespace. The endpoint requires `Authorization: Bearer <token>` even when
dashboard login is disabled or a browser session is present. It returns 404
when disabled, 401 for a missing or incorrect token, and 503 for invalid token
configuration. Protect the token in transit with TLS or a trusted private
network; do not put it in a URL.

Example Prometheus configuration (store the token in a protected file):

```yaml
scrape_configs:
  - job_name: migration-toolkit
    metrics_path: /api/metrics
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/migration-toolkit-token
    static_configs:
      - targets: ["migrate.example.com"]
```

The endpoint returns Prometheus text exposition format 0.0.4. All metrics are
gauges, grouped by `source` (`github`, `gitlab`, `bitbucket-server`), `target`
(`ghec`, `ghes`, or `other`), `mode` (`single` or `batch`), and current
`state`. Unknown stored states are grouped under `other`; repository names,
organization names, URLs, and failure messages are not labels.

| Metric | Meaning |
|---|---|
| `gh_migrate_migrations` | Number of retained migration records in the current state |
| `gh_migrate_migration_duration_observations` | Retained records with a nonnegative recorded duration |
| `gh_migrate_migration_duration_observed_seconds` | Sum of those recorded durations in seconds |

For example, `sum by (state) (gh_migrate_migrations)` graphs state counts.
Average recorded duration for successful migrations is
`sum(gh_migrate_migration_duration_observed_seconds{state="succeeded"}) / sum(gh_migrate_migration_duration_observations{state="succeeded"})`;
the result is undefined when there are no recorded durations.

These are snapshots of retained database rows, not lifetime event counters or
histograms. Counts and duration sums can decrease when records are pruned,
deleted, restarted, or change state; do not use `rate()` or `increase()` as a
count of completed migrations. Scraping begins a new time series in
Prometheus; it does not backfill historical changes, and short-lived states
between scrapes may not be observed.