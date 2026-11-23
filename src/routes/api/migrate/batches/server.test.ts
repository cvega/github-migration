import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { __setBatchRouteDependenciesForTests, GET, POST } from "./+server";

let restore: (() => void) | undefined;
let savedCredentialOverride: string | undefined;

beforeEach(() => {
  savedCredentialOverride = process.env.GH_ALLOW_CREDENTIAL_OVERRIDE;
  process.env.GH_ALLOW_CREDENTIAL_OVERRIDE = "true";
  initStore(":memory:", [migrateStore]);
});
afterEach(() => {
  restore?.();
  restore = undefined;
  if (savedCredentialOverride === undefined) delete process.env.GH_ALLOW_CREDENTIAL_OVERRIDE;
  else process.env.GH_ALLOW_CREDENTIAL_OVERRIDE = savedCredentialOverride;
  closeStore();
});

test("lists an empty batch collection", async () => {
  const response = await GET({ url: new URL("http://localhost/api/migrate/batches") } as never);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: [], total: 0, page: 1 });
});

test("rejects an unconfigured target profile", async () => {
  const response = await POST({
    request: new Request("http://localhost/api/migrate/batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ sourceRepo: "acme/widget", targetRepo: "widget" }],
        targetOrg: "target",
        targetProfileId: "missing",
        sourceToken: "source-token",
        targetToken: "target-token",
      }),
    }),
  } as never);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Migration target profile 'missing' is not configured",
  });
});

test("does not default a destination-less Bitbucket batch to GitHub Cloud", async () => {
  const response = await POST({
    request: new Request("http://localhost/api/migrate/batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceProvider: "bitbucket-server",
        repos: ["PROF01/service-01"],
        targetOrg: "target",
      }),
    }),
  } as never);
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("targetProfileId");
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
      targetProfileId: "ghec",
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
      targetProfileId: "ghec",
      items: [{ sourceRepo: "acme/repo", targetRepo: "repo" }],
      targetOrg: "target",
    }),
  } as never);
  expect(await response.json()).toEqual({
    error: "Repository 'acme/repo' is not part of the profile run",
  });
});

test("rejects only GitHub repositories still awaiting required analysis", async () => {
  restore = __setBatchRouteDependenciesForTests({
    getProfileRun: () =>
      ({
        id: "run",
        state: "completed",
        sourceProvider: "github",
        sourceApiUrl: "https://api.github.com",
      }) as never,
    findMissingProfileProjectPaths: () => [],
    findRepositoriesAwaitingAnalysis: () => ["acme/risky"],
  });
  const response = await POST({
    request: new Request("http://localhost/api/migrate/batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileRunId: "run",
        targetProfileId: "ghec",
        items: [{ sourceRepo: "acme/risky", targetRepo: "risky" }],
        targetOrg: "target",
      }),
    }),
  } as never);

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Repository 'acme/risky' requires successful Git analysis",
  });
});
