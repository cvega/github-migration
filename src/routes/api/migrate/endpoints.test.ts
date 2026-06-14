/**
 * Characterization tests for the API POST endpoints' request validation.
 *
 * These lock in the *current* request-validation contract (HTTP status + which
 * field is rejected) so the upcoming swap to schema-based validation can be
 * proven behavior-preserving. They assert status codes and that the offending
 * field is named in the error — never the exact prose — so they survive a
 * change of validation library.
 *
 * The manager module is mocked so valid requests don't touch the DB or start a
 * real migration; only the endpoint's validation/orchestration is exercised.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Manager mock ─────────────────────────────────────────────────────────────
// Mutable impls so individual tests can make a manager call throw.
let startImpl: (req: unknown, batchId?: unknown) => unknown;
let startBatchImpl: (req: unknown) => unknown;
let restartImpl: (id: unknown, body: unknown) => unknown;
let getBatchImpl: (id: unknown) => unknown;

const emptyPage = { data: [], total: 0, page: 1, limit: 20, totalPages: 0 };

// Spread the real manager so a leaked mock can't wipe its other exports for
// suites that run later in the same `bun test` process. `mock.module` is global
// and permanent (mock.restore() does not undo it), and Bun's file order isn't
// stable across machines — so a partial stub here would otherwise poison any
// later suite importing the real manager. We override only what these tests use.
const realManager = await import("$lib/server/migrate/manager");
mock.module("$lib/server/migrate/manager", () => ({
  ...realManager,
  start: (req: unknown, batchId?: unknown) => startImpl(req, batchId),
  startBatch: (req: unknown) => startBatchImpl(req),
  restart: (id: unknown, body: unknown) => restartImpl(id, body),
  restartBatch: () => ({ restarted: 1, errors: [] }),
  getBatch: (id: unknown) => getBatchImpl(id),
  listPaginated: () => emptyPage,
  searchPaginated: () => emptyPage,
  listBatchesPaginated: () => emptyPage,
}));

// The four POST handlers read only `request` and `params` from their event.
// Typing them by that surface lets one plain fixture drive all four without
// fabricating SvelteKit's route-specific RequestEvent. The `as PostHandler`
// casts adapt each route handler to that shared shape (test-only).
type PostHandler = (event: {
  request: Request;
  params: Partial<Record<string, string>>;
}) => Promise<Response>;
const migrationsPost = (await import("./migrations/+server")).POST as PostHandler;
const batchesPost = (await import("./batches/+server")).POST as PostHandler;
const migrationRestartPost = (await import("./migrations/[id]/restart/+server"))
  .POST as PostHandler;
const batchRestartPost = (await import("./batches/[id]/restart/+server")).POST as PostHandler;

// ── Test fixtures ────────────────────────────────────────────────────────────
/** Build the minimal event a POST handler reads: request body + route params. */
function postEvent(body: unknown, params: Record<string, string> = {}) {
  const request = new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { request, params };
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: string };
  return body.error ?? "";
}

// Credentials that satisfy validateAuthAvailable without env config.
const creds = { sourceToken: "ghp_s", targetToken: "ghp_t" };

const GH_ENV_KEYS = [
  "GH_SOURCE_PAT",
  "GH_TARGET_PAT",
  "GH_SOURCE_APP_ID",
  "GH_SOURCE_APP_PRIVATE_KEY",
  "GH_SOURCE_APP_INSTALLATION_ID",
  "GH_TARGET_APP_ID",
  "GH_TARGET_APP_PRIVATE_KEY",
  "GH_TARGET_APP_INSTALLATION_ID",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  // Reset manager impls to success defaults.
  startImpl = () => ({ id: "m1", state: "queued" });
  startBatchImpl = () => ({ id: "b1", totalCount: 1 });
  restartImpl = () => ({ id: "m1", state: "queued" });
  getBatchImpl = () => ({ id: "b1", totalCount: 1 });
  // Clear all env auth so "missing auth" is deterministic; valid bodies pass creds.
  savedEnv = {};
  for (const k of GH_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of GH_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── POST /api/migrate/migrations ─────────────────────────────────────────────────────
describe("POST /api/migrate/migrations", () => {
  const valid = { sourceRepo: "octo/widget", targetOrg: "acme", ...creds };

  test("valid request → 201", async () => {
    const res = await migrationsPost(postEvent(valid));
    expect(res.status).toBe(201);
  });

  test("malformed JSON → 400", async () => {
    const res = await migrationsPost(postEvent("{not json"));
    expect(res.status).toBe(400);
  });

  test("non-object body → 400", async () => {
    const res = await migrationsPost(postEvent([1, 2, 3]));
    expect(res.status).toBe(400);
  });

  test("missing sourceRepo → 400 naming sourceRepo", async () => {
    const res = await migrationsPost(postEvent({ targetOrg: "acme", ...creds }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/sourceRepo/i);
  });

  test("sourceRepo without a slash → 400 naming sourceRepo", async () => {
    const res = await migrationsPost(
      postEvent({ sourceRepo: "widget", targetOrg: "acme", ...creds }),
    );
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/sourceRepo/i);
  });

  test("non-boolean boolean field → 400 naming the field", async () => {
    const res = await migrationsPost(postEvent({ ...valid, skipReleases: "yes" }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/skipReleases/i);
  });

  test("invalid targetRepoVisibility → 400 naming the field", async () => {
    const res = await migrationsPost(postEvent({ ...valid, targetRepoVisibility: "secret" }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/visibility/i);
  });

  test("over-length field → 400", async () => {
    const res = await migrationsPost(postEvent({ ...valid, sourceRepo: `o/${"r".repeat(300)}` }));
    expect(res.status).toBe(400);
  });

  test("missing auth → 400 mentioning auth", async () => {
    const res = await migrationsPost(postEvent({ sourceRepo: "octo/widget", targetOrg: "acme" }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/auth/i);
  });

  test("manager throwing (unexpected internal error) → 500", async () => {
    startImpl = () => {
      throw new Error("unexpected failure");
    };
    const res = await migrationsPost(postEvent(valid));
    expect(res.status).toBe(500);
  });

  test("an unexpected internal error does not leak its message to the client", async () => {
    startImpl = () => {
      throw new Error("ENOENT: /srv/secret/path/gh-migrate.db is locked");
    };
    const res = await migrationsPost(postEvent(valid));
    expect(res.status).toBe(500);
    const msg = await errorOf(res);
    // The raw internal detail (paths, driver errors) must not reach the client.
    expect(msg).not.toMatch(/ENOENT|secret|gh-migrate\.db/);
    expect(msg).toBe("Internal server error");
  });
});

// ── POST /api/migrate/batches ────────────────────────────────────────────────────────
describe("POST /api/migrate/batches", () => {
  const valid = { repos: ["octo/a", "octo/b"], targetOrg: "acme", ...creds };

  test("valid request → 201", async () => {
    const res = await batchesPost(postEvent(valid));
    expect(res.status).toBe(201);
  });

  test("missing repos → 400 naming repos", async () => {
    const res = await batchesPost(postEvent({ targetOrg: "acme", ...creds }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/repos/i);
  });

  test("empty repos array → 400 naming repos", async () => {
    const res = await batchesPost(postEvent({ repos: [], targetOrg: "acme", ...creds }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/repos/i);
  });

  test("missing targetOrg → 400 naming targetOrg", async () => {
    const res = await batchesPost(postEvent({ repos: ["octo/a"], ...creds }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/targetOrg/i);
  });

  test("too many repos (>500) → 400", async () => {
    const repos = Array.from({ length: 501 }, (_, i) => `octo/r${i}`);
    const res = await batchesPost(postEvent({ repos, targetOrg: "acme", ...creds }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/repos|500|max/i);
  });

  test("repo entry without a slash → 400", async () => {
    const res = await batchesPost(
      postEvent({ repos: ["octo/a", "bad"], targetOrg: "acme", ...creds }),
    );
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/repo/i);
  });

  test("missing auth → 400 mentioning auth", async () => {
    const res = await batchesPost(postEvent({ repos: ["octo/a"], targetOrg: "acme" }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/auth/i);
  });

  test("an unexpected internal error → 500 (not the stale 429) with a generic message", async () => {
    startBatchImpl = () => {
      throw new Error("TypeError: cannot read property 'id' of undefined at /srv/app/x");
    };
    const res = await batchesPost(postEvent(valid));
    // Over-cap requests queue (never throw), so a throw is an unexpected internal
    // failure → 500, not 429 (which would wrongly signal a retryable rate limit).
    expect(res.status).toBe(500);
    const msg = await errorOf(res);
    expect(msg).not.toMatch(/TypeError|\/srv\/app/);
    expect(msg).toBe("Internal server error");
  });
});

// ── POST /api/migrate/migrations/[id]/restart ────────────────────────────────────────
describe("POST /api/migrate/migrations/[id]/restart", () => {
  test("valid request → 200", async () => {
    const res = await migrationRestartPost(postEvent(creds, { id: "m1" }));
    expect(res.status).toBe(200);
  });

  test("missing auth → 400", async () => {
    const res = await migrationRestartPost(postEvent({}, { id: "m1" }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/auth/i);
  });

  test("not-found from manager → 404", async () => {
    restartImpl = () => {
      throw new Error("Migration not found");
    };
    const res = await migrationRestartPost(postEvent(creds, { id: "nope" }));
    expect(res.status).toBe(404);
  });

  test("ineligible state from manager → 409", async () => {
    restartImpl = () => {
      throw new Error("Cannot restart a running migration");
    };
    const res = await migrationRestartPost(postEvent(creds, { id: "m1" }));
    expect(res.status).toBe(409);
  });

  test("an unexpected internal error → 500 without leaking its message", async () => {
    restartImpl = () => {
      throw new Error("SQLITE_CORRUPT: database disk image is malformed at /data/x.db");
    };
    const res = await migrationRestartPost(postEvent(creds, { id: "m1" }));
    expect(res.status).toBe(500);
    const msg = await errorOf(res);
    expect(msg).not.toMatch(/SQLITE_CORRUPT|\/data\/x\.db/);
    expect(msg).toBe("Internal server error");
  });
});

// ── POST /api/migrate/batches/[id]/restart ───────────────────────────────────────────
describe("POST /api/migrate/batches/[id]/restart", () => {
  test("valid request → 200", async () => {
    const res = await batchRestartPost(postEvent(creds, { id: "b1" }));
    expect(res.status).toBe(200);
  });

  test("unknown batch → 404", async () => {
    getBatchImpl = () => null;
    const res = await batchRestartPost(postEvent(creds, { id: "nope" }));
    expect(res.status).toBe(404);
  });

  test("missing auth → 400", async () => {
    const res = await batchRestartPost(postEvent({}, { id: "b1" }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/auth/i);
  });
});
