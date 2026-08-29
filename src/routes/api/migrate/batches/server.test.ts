import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { __setBatchRouteDependenciesForTests, GET, POST } from "./+server";

let restore: (() => void) | undefined;

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(() => {
  restore?.();
  restore = undefined;
  closeStore();
});

test("lists an empty batch collection", async () => {
  const response = await GET({ url: new URL("http://localhost/api/migrate/batches") } as never);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: [], total: 0, page: 1 });
});

test("rejects incomplete and foreign profile-backed batches", async () => {
  const request = (body: unknown) =>
    new Request("http://localhost/api/migrate/batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  restore = __setBatchRouteDependenciesForTests({
    getProfileRun: () => ({ state: "running" }) as never,
  });
  let response = await POST({
    request: request({
      profileRunId: "run",
      items: [{ sourceRepo: "acme/repo", targetRepo: "repo" }],
      targetOrg: "target",
    }),
  } as never);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Profile run is not completed" });
  restore();
  restore = __setBatchRouteDependenciesForTests({
    getProfileRun: () =>
      ({
        id: "run",
        state: "completed",
        sourceProvider: "github",
        sourceApiUrl: "https://api.github.com",
      }) as never,
    findMissingProfileProjectPaths: () => ["acme/repo"],
  });
  response = await POST({
    request: request({
      profileRunId: "run",
      items: [{ sourceRepo: "acme/repo", targetRepo: "repo" }],
      targetOrg: "target",
    }),
  } as never);
  expect(await response.json()).toEqual({
    error: "Repository 'acme/repo' is not part of the profile run",
  });
});
