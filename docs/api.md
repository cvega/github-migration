# API Reference

All endpoints return JSON. SSE streams emit migration/batch state changes as
they happen. When basic auth is enabled, every route except `/login` and
`/logout` requires a valid session cookie; unauthenticated `/api/*` requests get
`401`.

- [Migrations](#migrations)
- [Batches](#batches)
- [System & streams](#system--streams)
- [Request validation](#request-validation)
- [SSE streams](#sse-streams)

---

## Migrations

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/migrations` | List migrations (paginated via `?page=&limit=`) |
| `POST` | `/api/migrations` | Start a single migration |
| `GET` | `/api/migrations/:id` | Migration details |
| `DELETE` | `/api/migrations/:id` | Cancel an in-flight migration |
| `POST` | `/api/migrations/:id/restart` | Restart a failed/cancelled migration |
| `GET` | `/api/migrations/:id/events` | Per-migration SSE stream |
| `GET` `POST` | `/api/migrations/:id/cleanup` | Preview / execute guarded target cleanup |

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
| `GET` | `/api/batches` | List batches (paginated) |
| `POST` | `/api/batches` | Start a batch (≤ 500 repos) |
| `GET` | `/api/batches/:id` | Summary + member migrations |
| `DELETE` | `/api/batches/:id` | Cancel all active migrations in the batch |
| `POST` | `/api/batches/:id/restart` | Restart all failed/cancelled in the batch |

A batch request takes the same option/credential fields plus a `repos` array
(`["org/repo", …]`, or bare `repo` names when `GH_SOURCE_ORG` is configured) and
a `targetOrg`.

---

## System & streams

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Liveness/health check |
| `GET` | `/api/events` | Global SSE stream (all migrations) |
| `GET` | `/api/rate-limits` | Live source/target rate-limit info |
| `GET` | `/api/activity` | Recent-activity feed (notification bell) |

---

## Request validation

Every request body is validated at the boundary with a [Zod](https://zod.dev)
schema (`$lib/server/schemas.ts`) before use. Invalid shape → `400` naming the
offending field. Missing credentials (no per-request token/App and no env auth
for a side) → `400` mentioning auth. Unexpected internal failures → `500` with a
generic message (details are logged server-side, never returned to the client).

---

## SSE streams

The `/api/migrations/:id/events` and `/api/events` endpoints stream
`text/event-stream`. Each event is JSON with an `eventType` discriminator
(`step`, `phase_change`, `snapshot`, `complete`, `failure`, `milestone`,
`banner`, `restart`) and a typed `payload`. Clients reconnect automatically with
capped exponential backoff; a per-migration stream supports `?after=<id>` to
resume from a cursor.

If the server runs behind a proxy, ensure it does not buffer SSE responses
(for nginx, set `X-Accel-Buffering: no`).
