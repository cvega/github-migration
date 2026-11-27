import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPassword } from "../../src/lib/server/core/auth/passwords";
import { authStore } from "../../src/lib/server/core/auth/schema";
import { createSession, resolveSession } from "../../src/lib/server/core/auth/sessions";
import { createUser, findStoredUserById } from "../../src/lib/server/core/auth/users";

test("the password reset CLI records only the target and CLI source", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "admin-reset-"));
  try {
    using database = new Database(join(dataDirectory, "gh-migrate.db"));
    authStore.applySchema(database);
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
