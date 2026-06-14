# API Reference

All endpoints return JSON. SSE streams emit migration/batch state changes as
they happen. When basic auth is enabled, every route except `/login`, `/logout`,
and the `/api/health` liveness probe requires a valid session cookie;
unauthenticated `/api/*` requests get `401`. `/api/health` is always reachable
(the container HEALTHCHECK calls it with no cookie) but only returns its
auth-configuration details to authenticated callers.

Migration endpoints are namespaced under `/api/migrate/*` (the Migrate
workspace). `/api/health` and `/api/rate-limits` are workspace-agnostic and stay
at the root.

- [Migrations](#migrations)
- [Batches](#batches)
- [System & streams](#system--streams)
- [Request validation](#request-validation)
- [SSE streams](#sse-streams)

---

## Migrations

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/migrate/migrations` | List migrations (paginated via `?page=&limit=`) |
| `POST` | `/api/migrate/migrations` | Start a single migration |
| `GET` | `/api/migrate/migrations/:id` | Migration details |
| `DELETE` | `/api/migrate/migrations/:id` | Cancel an in-flight migration |
| `POST` | `/api/migrate/migrations/:id/restart` | Restart a failed/cancelled migration |
| `GET` | `/api/migrate/migrations/:id/events` | Per-migration SSE stream |
| `GET` `POST` | `/api/migrate/migrations/:id/cleanup` | Preview / execute guarded target cleanup |

A single migration request body (all credential/option fields optional):

```jsonc
{
  "sourceApiUrl": "https://ghes.example.com/api/v3", // optional; defaults to GHEC
  "sourceRepo": "octo-org/widget",                    // required, "org/repo"
  "targetOrg": "my-ghec-org",                         // required
  "targetRepo": "widget",                             // optional; defaults to source repo name
  "sourceToken": "ghp_…",                             // or sourceApp { appId, privateKey, installationId }
  "targetToken": "ghp_…",                             // or targetApp { … }
  "noSslVerify": false,
  "skipReleases": false,
  "lockSource": false,
  "directPassthrough": false,
  "targetRepoVisibility": "private"                   // private | public | internal
}
```

---

## Batches

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/migrate/batches` | List batches (paginated) |
| `POST` | `/api/migrate/batches` | Start a batch (≤ 500 repos) |
| `GET` | `/api/migrate/batches/:id` | Summary + member migrations |
| `DELETE` | `/api/migrate/batches/:id` | Cancel all active migrations in the batch |
| `POST` | `/api/migrate/batches/:id/restart` | Restart all failed/cancelled in the batch |

A batch request takes the same option/credential fields plus a `repos` array
(`["org/repo", …]`, or bare `repo` names when `GH_SOURCE_ORG` is configured) and
a `targetOrg`.

---

## System & streams

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Liveness/health check |
| `GET` | `/api/migrate/events` | Global SSE stream (all migrations) |
| `GET` | `/api/rate-limits` | Live source/target rate-limit info |
| `GET` | `/api/migrate/activity` | Recent-activity feed (notification bell) |

---

## Request validation

Every request body is validated at the boundary with a [Zod](https://zod.dev)
schema (`$lib/server/migrate/schemas.ts`) before use. Invalid shape → `400` naming the
offending field. Missing credentials (no per-request token/App and no env auth
for a side) → `400` mentioning auth. Unexpected internal failures → `500` with a
generic message (details are logged server-side, never returned to the client).

---

## SSE streams

The `/api/migrate/migrations/:id/events` and `/api/migrate/events` endpoints stream
`text/event-stream`. Each event is JSON with an `eventType` discriminator
(`step`, `phase_change`, `snapshot`, `complete`, `failure`, `milestone`,
`banner`, `restart`) and a typed `payload`. Clients reconnect automatically with
capped exponential backoff; a per-migration stream supports `?after=<id>` to
resume from a cursor.

If the server runs behind a proxy, ensure it does not buffer SSE responses
(for nginx, set `X-Accel-Buffering: no`).
