#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { recordAuditEvent } from "../../src/lib/server/core/auth/audit";
import { authStore } from "../../src/lib/server/core/auth/schema";
import { findUserByUsername, resetUserPassword } from "../../src/lib/server/core/auth/users";
import { acquireInstanceLock } from "../../src/lib/server/core/instance-lock";

const usernameIndex = process.argv.indexOf("--username");
const username = usernameIndex >= 0 ? process.argv[usernameIndex + 1]?.trim() : undefined;
if (!username) {
  console.error("Usage: bun run auth:reset --username <administrator>");
  process.exit(1);
}

const dataDirectory = process.env.DATA_DIR || "./data";
const lock = acquireInstanceLock(dataDirectory);
const database = new Database(join(dataDirectory, "gh-migrate.db"));
try {
  database.run("PRAGMA foreign_keys = ON");
  authStore.applySchema(database);
  const user = findUserByUsername(username, database);
  if (user?.role !== "admin" || !user.isActive) {
    throw new Error(`Active administrator '${username}' was not found.`);
  }
  database.run("BEGIN IMMEDIATE");
  const temporaryPassword = await resetUserPassword(user.id, database);
  recordAuditEvent(
    {
      actorUserId: null,
      action: "auth.password.reset",
      targetUserId: user.id,
      metadata: { source: "cli" },
    },
    database,
  );
  database.run("COMMIT");
  console.log(`Temporary password for ${user.username}: ${temporaryPassword}`);
  console.log("The administrator must change this password after signing in.");
} finally {
  database.close();
  lock.release();
}
