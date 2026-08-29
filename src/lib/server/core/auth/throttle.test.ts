import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { authStore } from "./schema";
import { isLoginThrottled, recordFailedLogin } from "./throttle";

let database: Database;

beforeEach(() => {
  database = new Database(":memory:");
  authStore.applySchema(database);
});

afterEach(() => database.close());

describe("login throttling", () => {
  const now = new Date("2026-08-29T12:00:00.000Z");

  test("limits a username and IP pair after five failures", () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      recordFailedLogin("Admin", "192.0.2.1", now, database);
    }
    expect(isLoginThrottled("admin", "192.0.2.1", now, database)).toBe(true);
    expect(isLoginThrottled("admin", "192.0.2.2", now, database)).toBe(false);
  });

  test("limits an IP after twenty failures across usernames", () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      recordFailedLogin(`user-${attempt}`, "192.0.2.1", now, database);
    }
    expect(isLoginThrottled("another-user", "192.0.2.1", now, database)).toBe(true);
  });

  test("ignores attempts outside the rolling window", () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      recordFailedLogin("admin", "192.0.2.1", new Date("2026-08-29T11:44:59.000Z"), database);
    }
    expect(isLoginThrottled("admin", "192.0.2.1", now, database)).toBe(false);
  });
});
