import type { Database } from "bun:sqlite";
import { getDb } from "$lib/server/core/db";
import type { AuthUser, StoredUser, UserRole } from "./model";
import {
  generateTemporaryPassword,
  hashPassword,
  passwordHashNeedsUpgrade,
  passwordPolicyError,
  verifyPasswordOrDummy,
} from "./passwords";
import { revokeUserSessions } from "./sessions";

const USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30}[A-Za-z0-9])?$/;

interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  role: UserRole;
  is_active: number;
  must_change_password: number;
}

function mapUser(row: UserRow): StoredUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: row.role,
    isActive: row.is_active === 1,
    mustChangePassword: row.must_change_password === 1,
  };
}

function usernamePolicyError(username: string): string | null {
  if (!USERNAME_PATTERN.test(username)) {
    return "Username must be 3-32 characters using letters, numbers, periods, underscores, or hyphens.";
  }
  return null;
}

export function findUserByUsername(
  username: string,
  database: Database = getDb(),
): StoredUser | null {
  const row = database
    .prepare(
      `SELECT id, username, display_name, password_hash, role, is_active, must_change_password
       FROM app_users WHERE username = ?`,
    )
    .get(username.trim()) as UserRow | null;
  return row ? mapUser(row) : null;
}

export function findUserById(id: string, database: Database = getDb()): AuthUser | null {
  const user = findStoredUserById(id, database);
  if (!user) return null;
  const { passwordHash: _, ...authUser } = user;
  return authUser;
}

export function findStoredUserById(id: string, database: Database = getDb()): StoredUser | null {
  const row = database
    .prepare(
      `SELECT id, username, display_name, password_hash, role, is_active, must_change_password
       FROM app_users WHERE id = ?`,
    )
    .get(id) as UserRow | null;
  return row ? mapUser(row) : null;
}

export function listUsers(database: Database = getDb()): AuthUser[] {
  return (
    database
      .prepare(
        `SELECT id, username, display_name, password_hash, role, is_active, must_change_password
         FROM app_users ORDER BY username COLLATE NOCASE`,
      )
      .all() as UserRow[]
  ).map(mapUser);
}

export async function verifyCredentials(
  username: string,
  password: string,
  database: Database = getDb(),
): Promise<StoredUser | null> {
  const user = findUserByUsername(username, database);
  const valid = await verifyPasswordOrDummy(password, user?.passwordHash ?? null);
  if (!valid || !user?.isActive) return null;

  const now = new Date().toISOString();
  if (passwordHashNeedsUpgrade(user.passwordHash)) {
    user.passwordHash = await hashPassword(password);
    database
      .prepare(
        "UPDATE app_users SET password_hash = ?, updated_at = ?, last_login_at = ? WHERE id = ?",
      )
      .run(user.passwordHash, now, now, user.id);
  } else {
    database.prepare("UPDATE app_users SET last_login_at = ? WHERE id = ?").run(now, user.id);
  }
  return user;
}

export interface CreateUserInput {
  username: string;
  displayName?: string | null;
  role: UserRole;
  password?: string;
  mustChangePassword?: boolean;
}

export async function createUser(
  input: CreateUserInput,
  database: Database = getDb(),
): Promise<{ user: AuthUser; temporaryPassword: string | null }> {
  const username = input.username.trim();
  const usernameError = usernamePolicyError(username);
  if (usernameError) throw new Error(usernameError);
  const displayName = input.displayName?.trim() || null;
  if (displayName && displayName.length > 80) {
    throw new Error("Display name must be no more than 80 characters.");
  }
  const temporaryPassword = input.password ? null : generateTemporaryPassword();
  const password = input.password ?? temporaryPassword ?? "";
  const passwordError = passwordPolicyError(password);
  if (passwordError) throw new Error(passwordError);
  const passwordHash = await hashPassword(password);
  const id = Bun.randomUUIDv7();
  const now = new Date().toISOString();
  const mustChangePassword = input.mustChangePassword ?? temporaryPassword !== null;

  database
    .prepare(
      `INSERT INTO app_users
       (id, username, display_name, password_hash, role, is_active,
        must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(id, username, displayName, passwordHash, input.role, mustChangePassword ? 1 : 0, now, now);
  const user = findUserById(id, database);
  if (!user) throw new Error("Created user could not be loaded");
  return { user, temporaryPassword };
}

export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  database: Database = getDb(),
): Promise<boolean> {
  const user = findStoredUserById(userId, database);
  if (!user || !(await verifyPasswordOrDummy(currentPassword, user?.passwordHash ?? null))) {
    return false;
  }
  const passwordError = passwordPolicyError(newPassword);
  if (passwordError) throw new Error(passwordError);
  const passwordHash = await hashPassword(newPassword);
  const now = new Date();
  database.transaction(() => {
    database
      .prepare(
        `UPDATE app_users
         SET password_hash = ?, must_change_password = 0, updated_at = ?
         WHERE id = ?`,
      )
      .run(passwordHash, now.toISOString(), userId);
    revokeUserSessions(userId, now, database);
  })();
  return true;
}

export async function resetUserPassword(
  userId: string,
  database: Database = getDb(),
): Promise<string> {
  if (!findUserById(userId, database)) throw new Error("User not found.");
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const now = new Date();
  database.transaction(() => {
    database
      .prepare(
        `UPDATE app_users
         SET password_hash = ?, must_change_password = 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(passwordHash, now.toISOString(), userId);
    revokeUserSessions(userId, now, database);
  })();
  return temporaryPassword;
}

function activeAdminCount(database: Database): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM app_users WHERE role = 'admin' AND is_active = 1")
    .get() as { count: number };
  return row.count;
}

export function setUserRole(
  actorUserId: string,
  userId: string,
  role: UserRole,
  database: Database = getDb(),
): void {
  const user = findUserById(userId, database);
  if (!user) throw new Error("User not found.");
  if (actorUserId === userId && role !== "admin") {
    throw new Error("You cannot change your own administrator role.");
  }
  database.transaction(() => {
    if (
      user.role === "admin" &&
      user.isActive &&
      role !== "admin" &&
      activeAdminCount(database) <= 1
    ) {
      throw new Error("At least one active administrator is required.");
    }
    const now = new Date();
    database
      .prepare("UPDATE app_users SET role = ?, updated_at = ? WHERE id = ?")
      .run(role, now.toISOString(), userId);
    revokeUserSessions(userId, now, database);
  })();
}

export function setUserActive(
  actorUserId: string,
  userId: string,
  isActive: boolean,
  database: Database = getDb(),
): void {
  const user = findUserById(userId, database);
  if (!user) throw new Error("User not found.");
  if (actorUserId === userId && !isActive) throw new Error("You cannot disable your own user.");
  database.transaction(() => {
    if (user.role === "admin" && user.isActive && !isActive && activeAdminCount(database) <= 1) {
      throw new Error("At least one active administrator is required.");
    }
    const now = new Date();
    database
      .prepare("UPDATE app_users SET is_active = ?, updated_at = ? WHERE id = ?")
      .run(isActive ? 1 : 0, now.toISOString(), userId);
    if (!isActive) revokeUserSessions(userId, now, database);
  })();
}
