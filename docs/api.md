# API Reference

All endpoints return JSON except Server-Sent Event streams. Protected
deployments require the dashboard session cookie obtained from `/login`.
Validation failures return `{ "error": "..." }` with an appropriate 4xx
status. Credentials are accepted only by documented migration requests and are
never returned.

## Operations

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Process liveness probe |
| `GET` | `/api/ready` | Database and startup readiness probe |
| `GET` | `/api/rate-limits` | Provider quotas, active count, and GitHub status |
| `POST` | `/api/profile` | Start a provider profile |
| `GET` | `/api/profile` | List profile runs |
| `GET` | `/api/profile/:id` | Read profile status and paginated repository detail |
| `GET` | `/api/profile/:id/events` | Stream profile progress and terminal state |
| `POST` | `/api/migrate` | Start one repository migration |
| `GET` | `/api/migrate` | List or search migrations |
| `GET` | `/api/migrate/activity` | List recent migration activity |
| `GET` | `/api/migrate/events` | Stream events across all migrations |
| `POST` | `/api/migrate/batches` | Start a normalized migration batch |
| `GET` | `/api/migrate/batches` | List or search migration batches |
| `GET` | `/api/migrate/batches/:id` | Read a batch summary and paginated members |
| `DELETE` | `/api/migrate/batches/:id` | Request cancellation for active batch members |
| `POST` | `/api/migrate/batches/:id/restart` | Restart eligible batch members |
| `GET` | `/api/migrate/:id` | Read migration detail and persisted events |
| `DELETE` | `/api/migrate/:id` | Request migration cancellation |
| `GET` | `/api/migrate/:id/events` | Replay and stream one migration's events |
| `POST` | `/api/migrate/:id/confirm-restart` | Confirm an uncertain outcome before restart |
| `POST` | `/api/migrate/:id/restart` | Restart an eligible migration |

## Pagination

List endpoints accept positive `page` and `limit` query parameters and clamp
limits to their route maximum. Migration and batch lists also accept `search`;
statistics and detail routes add their documented UI filters. Responses include
the selected page, total rows, total pages, and effective limit.

## Starting Migrations

Single requests identify `sourceProvider`, source API/organization/repository,
target profile and organization/repository, plus optional credentials and
execution options. Batch requests carry the common source/target configuration
and a bounded `repositories` mapping list. The server validates provider scope,
target support, duplicate identities, credential policy, and the maximum batch
size before persisting work.

The intentional cutover removed the former `/api/migrate/migrations` prefix.
There are no compatibility aliases.

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