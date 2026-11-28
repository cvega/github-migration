import { afterEach, expect, test } from "bun:test";
import { ConfigIssueError } from "$lib/server/core/config-issue";
import { __setProfileRouteDependenciesForTests, GET, POST } from "./+server";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

test("starts the selected provider profile", async () => {
  restore = __setProfileRouteDependenciesForTests({
    startGitLabProfile: (org) => ({ id: "run", org, sourceProvider: "gitlab" }) as never,
  });
  const response = await POST({
    request: new Request("http://local/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceProvider: "gitlab", org: "platform/services" }),
    }),
  } as never);
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ id: "run", org: "platform/services" });
});

test("reports an invalid server setting by variable name without a stack or value", async () => {
  restore = __setProfileRouteDependenciesForTests({
    startGitLabProfile: () => {
      throw new ConfigIssueError("GITLAB_SOURCE_PROFILE_REQUEST_BUDGET", "positive-integer");
    },
  });
  const response = await POST({
    request: new Request("http://local/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceProvider: "gitlab", org: "platform/services" }),
    }),
  } as never);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "GITLAB_SOURCE_PROFILE_REQUEST_BUDGET must be a positive integer",
  });
});

test("rejects invalid request bodies", async () => {
  const response = await POST({
    request: new Request("http://local/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceProvider: "unknown", org: "acme" }),
    }),
  } as never);
  expect(response.status).toBe(400);
});

test("lists bounded pages", async () => {
  restore = __setProfileRouteDependenciesForTests({
    countProfileRuns: () => 12,
    listProfileRuns: (limit, offset) => [{ limit, offset }] as never,
  });
  const response = await GET({ url: new URL("http://local/api/profile?page=3&limit=5") } as never);
  expect(await response.json()).toEqual({
    runs: [{ limit: 5, offset: 10 }],
    pagination: { page: 3, totalPages: 3, total: 12, limit: 5 },
  });
});
