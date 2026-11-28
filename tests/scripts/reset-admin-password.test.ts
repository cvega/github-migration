import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPassword } from "../../src/lib/server/core/auth/passwords";
import { createSession, resolveSession } from "../../src/lib/server/core/auth/sessions";
import { createUser, findStoredUserById } from "../../src/lib/server/core/auth/users";
import { initializeSchema } from "../../src/lib/server/core/db";
import { DOMAIN_STORES } from "../../src/lib/server/schemas";

test("the password reset CLI records only the target and CLI source", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "admin-reset-"));
  try {
    using database = new Database(join(dataDirectory, "gh-migrate.db"));
    initializeSchema(database, DOMAIN_STORES);
    const { user } = await createUser({ username: "fixture-admin", role: "admin" }, database);
    const token = createSession(user.id, new Date(), database);
    const script = new URL("../../scripts/auth/reset-admin-password.ts", import.meta.url);
    const result = Bun.spawnSync([process.execPath, script.pathname, "--username", user.username], {
      env: { ...process.env, DATA_DIR: dataDirectory },
    });

    expect(result.exitCode).toBe(0);
    const temporaryPassword = result.stdout
      .toString()
      .match(/^Temporary password for fixture-admin: (.+)$/m)?.[1];
    expect(Boolean(temporaryPassword)).toBe(true);
    const current = findStoredUserById(user.id, database);
    expect(current?.mustChangePassword).toBe(true);
    expect(await verifyPassword(temporaryPassword ?? "", current?.passwordHash ?? "")).toBe(true);
    expect(resolveSession(token, new Date(), database)).toBeNull();
    expect(
      database
        .query("SELECT actor_user_id, action, target_user_id, metadata FROM audit_events")
        .all(),
    ).toEqual([
      {
        actor_user_id: null,
        action: "auth.password.reset",
        target_user_id: user.id,
        metadata: '{"source":"cli"}',
      },
    ]);
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("resetting an administrator requires an existing dashboard database", () => {
  const directory = mkdtempSync(join(tmpdir(), "admin-reset-empty-"));
  try {
    const script = new URL("../../scripts/auth/reset-admin-password.ts", import.meta.url);
    const result = Bun.spawnSync(
      [process.execPath, script.pathname, "--username", "fixture-admin"],
      {
        env: { ...process.env, DATA_DIR: directory },
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(directory, "gh-migrate.db"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
