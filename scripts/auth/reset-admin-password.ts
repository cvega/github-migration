#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { recordAuditEvent } from "../../src/lib/server/core/auth/audit";
import { findUserByUsername, resetUserPassword } from "../../src/lib/server/core/auth/users";
import { validateSchema } from "../../src/lib/server/core/db";
import { acquireInstanceLock } from "../../src/lib/server/core/instance-lock";
import { DOMAIN_STORES } from "../../src/lib/server/schemas";

const usernameIndex = process.argv.indexOf("--username");
const username = usernameIndex >= 0 ? process.argv[usernameIndex + 1]?.trim() : undefined;
if (!username) {
  console.error("Usage: bun run auth:reset --username <administrator>");
  process.exit(1);
}

const dataDirectory = process.env.DATA_DIR || "./data";
const lock = acquireInstanceLock(dataDirectory);
try {
  using database = new Database(join(dataDirectory, "gh-migrate.db"), {
    readwrite: true,
    create: false,
  });
  database.run("PRAGMA foreign_keys = ON");
  database.run("BEGIN IMMEDIATE");
  validateSchema(database, DOMAIN_STORES);
  const user = findUserByUsername(username, database);
  if (user?.role !== "admin" || !user.isActive) {
    throw new Error(`Active administrator '${username}' was not found.`);
  }
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
  lock.release();
}
