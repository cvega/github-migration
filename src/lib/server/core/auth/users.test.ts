import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { verifyPassword } from "./passwords";
import { authStore } from "./schema";
import { createSession, resolveSession } from "./sessions";
import {
  changeOwnPassword,
  createUser,
  findStoredUserById,
  findUserById,
  resetUserPassword,
  setUserActive,
  setUserRole,
  verifyCredentials,
} from "./users";

let database: Database;

beforeEach(() => {
  database = new Database(":memory:");
  database.run("PRAGMA foreign_keys = ON");
  authStore.applySchema(database);
});

afterEach(() => database.close());

async function add(username: string, role: "admin" | "operator" = "operator") {
  return createUser({ username, password: "correct horse battery staple", role }, database);
}

describe("users", () => {
  test("verifies active users case-insensitively", async () => {
    await add("Operator");
    expect(
      await verifyCredentials("operator", "correct horse battery staple", database),
    ).toMatchObject({ username: "Operator" });
    expect(await verifyCredentials("operator", "wrong password", database)).toBeNull();
  });

  test("changes a password, clears the temporary flag, and revokes sessions", async () => {
    const { user } = await createUser({ username: "operator", role: "operator" }, database);
    const token = createSession(user.id, new Date("2026-08-29T00:00:00.000Z"), database);

    expect(
      await changeOwnPassword(user.id, "wrong password", "a different secure password", database),
    ).toBe(false);
    expect(
      await changeOwnPassword(
        user.id,
        await resetUserPassword(user.id, database),
        "a different secure password",
        database,
      ),
    ).toBe(true);
    expect(findUserById(user.id, database)?.mustChangePassword).toBe(false);
    expect(resolveSession(token, new Date("2026-08-29T00:01:00.000Z"), database)).toBeNull();
  });

  test("resets a password and revokes active sessions", async () => {
    const { user } = await add("operator");
    const token = createSession(user.id, new Date("2026-08-29T00:00:00.000Z"), database);
    const temporaryPassword = await resetUserPassword(user.id, database);

    expect(
      await verifyPassword(
        temporaryPassword,
        findStoredUserById(user.id, database)?.passwordHash ?? "",
      ),
    ).toBe(true);
    expect(findUserById(user.id, database)?.mustChangePassword).toBe(true);
    expect(resolveSession(token, new Date("2026-08-29T00:01:00.000Z"), database)).toBeNull();
  });

  test("prevents self-demotion and self-disablement", async () => {
    const { user } = await add("admin", "admin");
    expect(() => setUserRole(user.id, user.id, "operator", database)).toThrow(/own administrator/);
    expect(() => setUserActive(user.id, user.id, false, database)).toThrow(/own user/);
  });

  test("protects the final active administrator", async () => {
    const { user: first } = await add("admin-one", "admin");
    const { user: second } = await add("admin-two", "admin");
    setUserActive(first.id, second.id, false, database);

    expect(() => setUserRole("another-actor", first.id, "operator", database)).toThrow(
      /At least one active administrator/,
    );
  });

  test("upgrades stale hashes after a successful login", async () => {
    const { user } = await add("operator");
    const staleHash = await Bun.password.hash("correct horse battery staple", {
      algorithm: "argon2id",
      memoryCost: 32_768,
      timeCost: 2,
    });
    database.prepare("UPDATE app_users SET password_hash = ? WHERE id = ?").run(staleHash, user.id);

    await verifyCredentials("operator", "correct horse battery staple", database);
    expect(findStoredUserById(user.id, database)?.passwordHash).not.toBe(staleHash);
  });
});
