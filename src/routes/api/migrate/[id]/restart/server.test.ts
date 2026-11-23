import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { authStore } from "$lib/server/core/auth/schema";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { cancel, MAX_CONCURRENT_MIGRATIONS } from "$lib/server/migrate/manager";
import { POST } from "./+server";

beforeEach(() => initStore(":memory:", [migrateStore, authStore]));
afterEach(closeStore);

describe("restart migration endpoint", () => {
  test("queues a saved Bitbucket to GHES route with only server credentials", async () => {
    const config = {
      GHES_TARGET_ID: "ghes",
      GHES_TARGET_ORG: "target",
      BITBUCKET_SERVER_PROJECT_KEYS: "PROJECT",
      GHES_TARGET_API_URL: "https://ghes.example.com",
      GHES_TARGET_ADMIN_USERNAME: "admin",
      GHES_TARGET_ADMIN_PAT: "test",
      GHES_TARGET_SSH_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
      GHES_TARGET_SSH_HOST_KEY_SHA256: "fixture",
      BITBUCKET_SERVER_URL: "https://bitbucket.example.com",
      BITBUCKET_SERVER_USERNAME: "test",
      BITBUCKET_SERVER_PASSWORD: "test",
      ARCHIVE_DIR: "/archives",
      EXPORTER_ARCHIVE_VOLUME: "fixture",
      BBS_EXPORTER_IMAGE: "fixture:latest",
      GH_SOURCE_PAT: "",
      GH_TARGET_PAT: "",
    };
    const saved = Object.fromEntries(Object.keys(config).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, config);
      const insert =
        getDb().prepare(`INSERT INTO migrations(id,source_provider,source_api_url,source_org,source_repo,target_org,target_repo,target_profile_id,target_platform,target_api_url,state,started_at)
        VALUES (?,'bitbucket-server','https://bitbucket.example.com/rest/api/1.0','PROJECT','repo','target','repo','ghes','ghes','https://ghes.example.com/api/v3',?,CURRENT_TIMESTAMP)`);
      for (let i = 0; i < MAX_CONCURRENT_MIGRATIONS; i++) insert.run(`active-${i}`, "running");
      insert.run("retry-native", "failed");
      const response = await POST({
        params: { id: "retry-native" },
        locals: {},
        request: new Request("http://localhost/api/migrate/retry-native/restart", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceProvider: "github", targetProfileId: "ghec" }),
        }),
      } as never);
      expect(await response.json()).toMatchObject({
        state: "queued",
        sourceProvider: "bitbucket-server",
        targetProfileId: "ghes",
      });
      expect(cancel("retry-native")).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });
  test("rejects an invalid restart payload", async () => {
    const response = await POST({
      params: { id: "missing" },
      request: new Request("http://localhost/api/migrate/missing/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetRepoVisibility: "secret" }),
      }),
    } as never);

    expect(response.status).toBe(400);
  });

  test("maps a missing migration to 404 after payload validation", async () => {
    const response = await POST({
      params: { id: "missing" },
      request: new Request("http://localhost/api/migrate/missing/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceToken: "source", targetToken: "target" }),
      }),
    } as never);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/not found/i);
  });
});
