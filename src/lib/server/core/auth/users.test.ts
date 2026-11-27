import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { verifyPassword } from "./passwords";
import { authStore } from "./schema";
import { createSession, hashSessionToken, resolveSession } from "./sessions";
import {
  changeOwnPassword,
  createUser,
  findStoredUserById,
  findUserById,
  resetUserPassword,
  setUserActive,
  setUserRole,
  signInWithPassword,
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
    const session = await signInWithPassword(
      "operator",
      "correct horse battery staple",
      "192.0.2.1",
      database,
    );
    expect(resolveSession(session?.token ?? "", new Date(), database)?.user.username).toBe(
      "Operator",
    );
    expect(
      await signInWithPassword("operator", "wrong password", "192.0.2.1", database),
    ).toBeNull();
  });

  test("changes a password, clears the temporary flag, and revokes sessions", async () => {
    const { user, temporaryPassword } = await createUser(
      { username: "operator", role: "operator" },
      database,
    );
    const token = createSession(user.id, new Date(), database);
    const tokenHash = hashSessionToken(token);
    expect(
      await changeOwnPassword(
        user.id,
        tokenHash,
        "wrong password",
        "a different secure password",
        database,
      ),
    ).toBeNull();
    expect(
      await changeOwnPassword(
        user.id,
        tokenHash,
        temporaryPassword ?? "",
        "a different secure password",
        database,
      ),
    ).toEqual(expect.any(String));
    expect(findUserById(user.id, database)?.mustChangePassword).toBe(false);
    expect(resolveSession(token, new Date(), database)).toBeNull();
  });

  test("keeps the current password state when a verified change is superseded", async () => {
    const { user } = await add("operator");
    const token = createSession(user.id, new Date(), database);
    const hash = spyOn(Bun.password, "hash").mockImplementation(async () => {
      database.run("UPDATE app_users SET password_hash = ? WHERE id = ?", [
        "replacement-hash-fixture",
        user.id,
      ]);
      return "proposed-hash-fixture";
    });
    try {
      const result = await changeOwnPassword(
        user.id,
        hashSessionToken(token),
        "correct horse battery staple",
        "a different secure password",
        database,
      );
      expect(findStoredUserById(user.id, database)?.passwordHash).toBe("replacement-hash-fixture");
      expect(result).toBeNull();
      expect(database.query("SELECT COUNT(*) AS count FROM app_sessions").get()).toEqual({
        count: 1,
      });
    } finally {
      hash.mockRestore();
    }
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

  test.each([
    ["replaced", "$argon2id$v=19$m=65536,t=3,p=1$fixture", 1, false],
    ["replaced during upgrade", "legacy-hash-fixture", 1, true],
    ["disabled", "$argon2id$v=19$m=65536,t=3,p=1$fixture", 0, false],
  ] as const)(
    "declines sign-in when the verified fixture is %s",
    async (state, original, active, upgrade) => {
      const { user } = await add("operator");
      database.run("UPDATE app_users SET password_hash = ? WHERE id = ?", [original, user.id]);
      const current = state === "disabled" ? original : "replacement-hash-fixture";
      const replaceState = () => {
        database.run("UPDATE app_users SET password_hash = ?, is_active = ? WHERE id = ?", [
          current,
          active,
          user.id,
        ]);
      };
      const verify = spyOn(Bun.password, "verify").mockImplementation(async () => {
        if (!upgrade) replaceState();
        return true;
      });
      const hash = spyOn(Bun.password, "hash").mockImplementation(async () => {
        replaceState();
        return "upgraded-hash-fixture";
      });
      try {
        const result = await signInWithPassword("operator", "fixture", "192.0.2.1", database);
        expect(findStoredUserById(user.id, database)?.passwordHash).toBe(current);
        expect(result).toBeNull();
        expect(database.query("SELECT last_login_at FROM app_users").get()).toEqual({
          last_login_at: null,
        });
        expect(database.query("SELECT COUNT(*) AS count FROM app_sessions").get()).toEqual({
          count: 0,
        });
        expect(database.query("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({
          count: 0,
        });
      } finally {
        verify.mockRestore();
        hash.mockRestore();
      }
    },
  );

  test("upgrades stale hashes after a successful login", async () => {
    const { user } = await add("operator");
    const staleHash = await Bun.password.hash("correct horse battery staple", {
      algorithm: "argon2id",
      memoryCost: 32_768,
      timeCost: 2,
    });
    database.prepare("UPDATE app_users SET password_hash = ? WHERE id = ?").run(staleHash, user.id);

    await signInWithPassword("operator", "correct horse battery staple", "192.0.2.1", database);
    expect(findStoredUserById(user.id, database)?.passwordHash).not.toBe(staleHash);
  });
});
