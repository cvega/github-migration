import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { POST } from "./+server";

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

describe("restart migration endpoint", () => {
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
