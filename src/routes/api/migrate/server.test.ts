import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { GET, POST } from "./+server";

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

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
});
