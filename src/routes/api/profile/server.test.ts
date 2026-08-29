import { afterEach, expect, test } from "bun:test";
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
