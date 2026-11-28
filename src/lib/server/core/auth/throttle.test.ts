import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { authStore } from "./schema";
import { verifyLoginAttempt } from "./throttle";

let database: Database;
const now = new Date("2026-08-29T12:00:00.000Z");
const ip = "192.0.2.1";
const failed = async () => null;

beforeEach(() => {
  database = new Database(":memory:");
  authStore.applySchema(database);
});

afterEach(() => database.close());

describe("login throttling", () => {
  test("reserves the remaining pair budget before verification and releases only the successful attempt", async () => {
    for (let i = 0; i < 3; i++) await verifyLoginAttempt("Admin", ip, failed, database, now);
    const successful = Promise.withResolvers<string>();
    const admitted = verifyLoginAttempt("admin", ip, () => successful.promise, database, now);
    const pending = Promise.withResolvers<null>();
    const verify = mock(() => pending.promise);
    const requests = Array.from({ length: 6 }, () =>
      verifyLoginAttempt(" ADMIN ", ip, verify, database, now),
    );
    expect(verify).toHaveBeenCalledTimes(1);
    successful.resolve("admin");
    await admitted;
    expect((await verifyLoginAttempt("admin", ip, failed, database, now)).throttled).toBe(false);
    expect((await verifyLoginAttempt("admin", ip, failed, database, now)).throttled).toBe(true);
    pending.resolve(null);
    expect((await Promise.all(requests)).filter((result) => result.throttled)).toHaveLength(5);
  });

  test("limits an address across usernames until the window expires", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await verifyLoginAttempt(String(i), ip, failed, database, now)).throttled).toBe(
        false,
      );
    }
    expect((await verifyLoginAttempt("another", ip, failed, database, now)).throttled).toBe(true);
    const later = new Date(now.getTime() + 901_000);
    expect((await verifyLoginAttempt("another", ip, failed, database, later)).throttled).toBe(
      false,
    );
  });

  test("uses one bounded key for trimmed, case-normalized usernames", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await verifyLoginAttempt("Équipe", ip, failed, database, now)).throttled).toBe(false);
    }
    expect(await verifyLoginAttempt("  équipe  ", ip, failed, database, now)).toEqual({
      throttled: true,
      reason: "window",
    });
    const row = database
      .query<{ username: string }, []>(
        "SELECT username FROM auth_login_attempts ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(row?.username).toMatch(/^![a-f0-9]{31}$/);
  });

  test("bounds active verifications across addresses and releases capacity on errors", async () => {
    const pending = Promise.withResolvers<null>();
    const verify = mock(() => pending.promise);
    const requests = Array.from({ length: 8 }, (_, i) =>
      verifyLoginAttempt("admin", `192.0.2.${i + 1}`, verify, database, now),
    );
    expect(verify).toHaveBeenCalledTimes(5);
    pending.reject(new Error("fixture error"));
    const results = await Promise.allSettled(requests);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(5);
    expect(database.query("SELECT COUNT(*) AS count FROM auth_login_attempts").get()).toEqual({
      count: 5,
    });
    expect((await verifyLoginAttempt("admin", ip, failed, database, now)).throttled).toBe(false);
  });
});
