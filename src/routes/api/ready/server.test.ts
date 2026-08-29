import { describe, expect, mock, test } from "bun:test";
import { checkStoreReady, closeStore, getDb, initStore } from "$lib/server/core/db";
import { _createReadyHandler } from "./+server";

type ReadyBody = { status: string; timestamp: string };

describe("GET /api/ready", () => {
  test("checks main-database writes without persisting probe data", () => {
    initStore(":memory:", []);
    try {
      checkStoreReady();
      expect(
        getDb()
          .query("SELECT name FROM sqlite_master WHERE name = ?")
          .get("__gh_migrate_readiness_probe"),
      ).toBeNull();
    } finally {
      closeStore();
    }
  });

  test("returns 200 when SQLite is readable and writable", async () => {
    const checkReady = mock(() => {});
    const response = await _createReadyHandler(checkReady)({} as never);

    expect(response.status).toBe(200);
    expect(checkReady).toHaveBeenCalledTimes(1);
    const body = (await response.json()) as ReadyBody;
    expect(body.status).toBe("ready");
    expect(typeof body.timestamp).toBe("string");
  });

  test("returns a sanitized 503 when SQLite is unavailable", async () => {
    const checkReady = mock(() => {
      throw new Error("disk I/O error at /secret/data");
    });
    const originalError = console.error;
    console.error = mock(() => {});
    try {
      const response = await _createReadyHandler(checkReady)({} as never);

      expect(response.status).toBe(503);
      const responseText = await response.text();
      expect(JSON.parse(responseText)).toEqual({
        status: "unavailable",
        timestamp: expect.any(String),
      });
      expect(responseText).not.toContain("/secret/data");
    } finally {
      console.error = originalError;
    }
  });
});
