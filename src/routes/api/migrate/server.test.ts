import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { GET, POST } from "./+server";

let savedCredentialOverride: string | undefined;

beforeEach(() => {
  savedCredentialOverride = process.env.GH_ALLOW_CREDENTIAL_OVERRIDE;
  process.env.GH_ALLOW_CREDENTIAL_OVERRIDE = "true";
  initStore(":memory:", [migrateStore]);
});
afterEach(() => {
  if (savedCredentialOverride === undefined) delete process.env.GH_ALLOW_CREDENTIAL_OVERRIDE;
  else process.env.GH_ALLOW_CREDENTIAL_OVERRIDE = savedCredentialOverride;
  closeStore();
});

describe("migration collection endpoint", () => {
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
