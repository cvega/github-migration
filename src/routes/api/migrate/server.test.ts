import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { authStore } from "$lib/server/core/auth/schema";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { GET, POST } from "./+server";
import { POST as postBatch } from "./batches/+server";

let savedCredentialOverride: string | undefined;

beforeEach(() => {
  savedCredentialOverride = process.env.GH_ALLOW_CREDENTIAL_OVERRIDE;
  process.env.GH_ALLOW_CREDENTIAL_OVERRIDE = "true";
  initStore(":memory:", [migrateStore, authStore]);
});
afterEach(() => {
  if (savedCredentialOverride === undefined) delete process.env.GH_ALLOW_CREDENTIAL_OVERRIDE;
  else process.env.GH_ALLOW_CREDENTIAL_OVERRIDE = savedCredentialOverride;
  closeStore();
});

describe("migration collection endpoint", () => {
  test("audits denied GitLab-to-GHES submissions without persisting jobs or credentials", async () => {
    const previous = process.env.GHES_TARGET_API_URL;
    process.env.GHES_TARGET_API_URL = "https://enterprise.example";
    try {
      for (const [handler, fields] of [
        [POST, { sourceRepo: "org/repo" }],
        [postBatch, { repos: ["org/repo"] }],
      ] as const) {
        const response = await handler({
          locals: {},
          request: new Request("http://localhost/api/migrate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...fields,
              sourceProvider: "gitlab",
              targetProfileId: process.env.GHES_TARGET_ID || "ghes",
              targetOrg: "dest",
              targetToken: "not-for-audit",
            }),
          }),
        } as never);
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain("paused");
      }
      const events = getDb()
        .query("SELECT action, metadata FROM audit_events ORDER BY id")
        .all() as { action: string; metadata: string }[];
      expect(events.map(({ action }) => action)).toEqual([
        "migration.start_blocked",
        "batch.start_blocked",
      ]);
      expect(JSON.stringify(events)).not.toContain("not-for-audit");
      expect(getDb().query("SELECT COUNT(*) AS count FROM migrations").get()).toEqual({ count: 0 });
    } finally {
      if (previous === undefined) delete process.env.GHES_TARGET_API_URL;
      else process.env.GHES_TARGET_API_URL = previous;
    }
  });
  test("lists an empty paginated collection", async () => {
    const response = await GET({ url: new URL("http://localhost/api/migrate") } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [], total: 0, page: 1 });
  });

  test("requires JSON for create requests", async () => {
    const response = await POST({
      request: new Request("http://localhost/api/migrate", { method: "POST", body: "{}" }),
    } as never);
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "Content-Type must be application/json" });
  });

  test("rejects an unconfigured target profile", async () => {
    const response = await POST({
      request: new Request("http://localhost/api/migrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceRepo: "acme/widget",
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
});
