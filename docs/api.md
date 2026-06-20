# API Reference

All endpoints return JSON. SSE streams emit migration/batch state changes as
they happen. When basic auth is enabled, every route except `/login`, `/logout`,
and the `/api/health` liveness probe requires a valid session cookie;
unauthenticated `/api/*` requests get `401`. `/api/health` is always reachable
(the container HEALTHCHECK calls it with no cookie) but only returns its
auth-configuration details to authenticated callers.

Migration endpoints are namespaced under `/api/migrate/*` (the Migrate
workspace) and profiler endpoints under `/api/profile/*` (the Profile
workspace). `/api/health` and `/api/rate-limits` are workspace-agnostic and stay
at the root.

- [Migrations](#migrations)
- [Batches](#batches)
- [Profile](#profile)
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

## Profile

The Profiler workspace (`/api/profile/*`) crawls a source organization — or an
entire enterprise, fanning out to every accessible org — and reports per-repo
migration *considerations* (things the GitHub export won't carry over) and
actionable insights, so you can assess readiness before migrating.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/profile` | Start a profiling run (org by default, or an enterprise) |
| `GET` | `/api/profile` | List profiling runs (most recent first) |
| `GET` | `/api/profile/:id` | Org run details — status, per-repo considerations, insights |
| `GET` | `/api/profile/:id/events` | Per-run SSE stream of live progress |
| `POST` | `/api/profile/:id/pause` | Ask a running org run to pause at a safe point |
| `POST` | `/api/profile/:id/resume` | Resume a paused org run |
| `GET` | `/api/profile/:id/repo/:nameWithOwner` | One repo's full detail (URL-encoded `owner/name`) |
| `GET` | `/api/profile/enterprise/:id` | Enterprise run details + its child org runs |
| `GET` | `/api/profile/enterprise/:id/events` | Per-enterprise SSE stream of live progress |
| `POST` | `/api/profile/enterprise/:id/pause` | Pause a running enterprise run |
| `POST` | `/api/profile/enterprise/:id/resume` | Resume a paused enterprise run |

A profiling run needs only the org login (or enterprise slug) — source
credentials come from the server environment (the same source auth the Migrate
workspace uses). The optional `scope` selects the kind of run; it defaults to
`"org"`, so the original `{ "org": … }` body keeps working unchanged:

```jsonc
// Organization (default scope)
{
  "org": "octo-org"          // required; a GitHub org login
}

// Enterprise
{
  "scope": "enterprise",
  "enterprise": "octo-ent"   // required; an enterprise slug
}
```

The run record is created synchronously and returned with `201`; the crawl then
proceeds in the background (poll the detail endpoint or subscribe to the event
stream for progress). `POST` returns `400` if the org login / enterprise slug is
missing or malformed, or if no source credentials are configured on the server.
An enterprise run fans out to one child org run per accessible organization;
orgs the source token can't see are skipped and counted in `inaccessible_orgs`.

`GET /api/profile` returns `{ "runs": [ … ] }` (most recent first).
`GET /api/profile/:id` returns the run plus its per-repo results (each with its
applying considerations and derived insights), or `404` if the id is unknown. It
accepts optional `?limit=&offset=` to page through the repos; omit both to get
the full detail (the backward-compatible default). `GET /api/profile/enterprise/:id`
returns the enterprise run together with its child org runs.

Pause and resume are **cooperative**. `POST …/pause` and `POST …/resume` return
`202 Accepted` (or `404` for an unknown id). A pause takes effect at the crawl's
next checkpoint — the run flips to `paused` shortly after, signalled over SSE;
resume re-dispatches the crawl from where it stopped. Pausing an enterprise run
pauses its in-flight child crawls too.

### Profile progress stream

`GET /api/profile/:id/events` and `GET /api/profile/enterprise/:id/events` stream
`text/event-stream`. Each event is JSON with a `type` discriminator. The two
streams share the `done` frame but carry different `progress` frames:

- Org run: `{ "type": "progress", "profiled": <n>, "total": <n>, "repo": "owner/name", "phase": <phase> }`
  — emitted as each repository is profiled.
- Enterprise run: `{ "type": "progress", "profiledOrgs": <n>, "totalOrgs": <n>, "org": "org-login", "phase": <phase> }`
  — emitted as each child org settles.
- Both: `{ "type": "done", "state": "completed" | "failed" | "paused" }` —
  emitted once when the run settles or pauses, after which the stream closes.

Unlike the migration streams, profile progress is ephemeral: there is no event
replay or `?after=` cursor. A reconnecting client simply refetches the run detail
for the current snapshot. An unknown run id → `404`.

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
