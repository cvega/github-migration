import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { authStore } from "./schema";
import { initializeAuthentication } from "./startup";
import { findUserByUsername } from "./users";

let database: Database;

beforeEach(() => {
  database = new Database(":memory:");
  database.run("PRAGMA foreign_keys = ON");
  authStore.applySchema(database);
});

afterEach(() => database.close());

describe("authentication startup", () => {
  test("creates the first administrator from bootstrap credentials", async () => {
    const result = await initializeAuthentication(
      { username: "Admin", password: "a secure bootstrap password" },
      database,
    );

    expect(result).toEqual({ authEnabled: true, bootstrappedUser: true });
    expect(findUserByUsername("admin", database)).toMatchObject({
      username: "Admin",
      role: "admin",
      mustChangePassword: false,
    });
  });

  test("uses stored users after bootstrap without environment credentials", async () => {
    await initializeAuthentication(
      { username: "admin", password: "a secure bootstrap password" },
      database,
    );
    expect(await initializeAuthentication({}, database)).toEqual({
      authEnabled: true,
      bootstrappedUser: false,
    });
  });

  test("requires explicit unauthenticated mode when no users exist", async () => {
    await expect(initializeAuthentication({}, database)).rejects.toThrow(
      /create the first administrator/,
    );
    expect(await initializeAuthentication({ allowUnauthenticated: "true" }, database)).toEqual({
      authEnabled: false,
      bootstrappedUser: false,
    });
  });

  test("rejects unauthenticated mode once users exist", async () => {
    await initializeAuthentication(
      { username: "admin", password: "a secure bootstrap password" },
      database,
    );
    await expect(
      initializeAuthentication({ allowUnauthenticated: "true" }, database),
    ).rejects.toThrow(/contradictory/);
  });
});
