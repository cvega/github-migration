import type { Database } from "bun:sqlite";
import { getDb } from "$lib/server/core/db";
import { recordAuditEvent } from "./audit";
import type { AuthUser, StoredUser, UserRole } from "./model";
import {
  generateTemporaryPassword,
  hashPassword,
  passwordHashNeedsUpgrade,
  passwordPolicyError,
  verifyPasswordOrDummy,
} from "./passwords";
import { createSession, revokeUserSessions } from "./sessions";

const USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30}[A-Za-z0-9])?$/;
export const USERNAME_MAX_LENGTH = 32;

export function matchesUsernamePolicy(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

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
  if (!matchesUsernamePolicy(username)) {
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

export async function signInWithPassword(
  username: string,
  password: string,
  ipAddress: string,
  database: Database = getDb(),
): Promise<{ token: string; mustChangePassword: boolean } | null> {
  const user = findUserByUsername(username, database);
  const valid = await verifyPasswordOrDummy(password, user?.passwordHash ?? null);
  if (!valid || !user?.isActive) return null;

  const upgradedHash = passwordHashNeedsUpgrade(user.passwordHash)
    ? await hashPassword(password)
    : null;
  return database.transaction(() => {
    const now = new Date();
    const timestamp = now.toISOString();
    const current = database
      .query<{ must_change_password: number }, [string | null, string, string, string]>(
        `UPDATE app_users
         SET updated_at = CASE WHEN ?1 IS NULL THEN updated_at ELSE ?2 END,
             password_hash = COALESCE(?1, password_hash), last_login_at = ?2
         WHERE id = ?3 AND password_hash = ?4 AND is_active = 1
         RETURNING must_change_password`,
      )
      .get(upgradedHash, timestamp, user.id, user.passwordHash);
    if (!current) return null;

    const token = createSession(user.id, now, database);
    recordAuditEvent(
      { actorUserId: user.id, action: "auth.login.succeeded", ipAddress, createdAt: now },
      database,
    );
    return { token, mustChangePassword: current.must_change_password === 1 };
  })();
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
  sessionTokenHash: string,
  currentPassword: string,
  newPassword: string,
  database: Database = getDb(),
): Promise<string | null> {
  const user = findStoredUserById(userId, database);
  if (!user?.isActive || !(await verifyPasswordOrDummy(currentPassword, user.passwordHash))) {
    return null;
  }
  const passwordError = passwordPolicyError(newPassword);
  if (passwordError) throw new Error(passwordError);
  const passwordHash = await hashPassword(newPassword);
  return database
    .transaction(() => {
      const now = new Date();
      const result = database
        .prepare(
          `UPDATE app_users
         SET password_hash = ?1, must_change_password = 0, updated_at = ?2
         WHERE id = ?3 AND password_hash = ?4 AND is_active = 1
           AND EXISTS (
             SELECT 1 FROM app_sessions
             WHERE token_hash = ?5 AND user_id = ?3
               AND revoked_at IS NULL AND expires_at >= ?2
           )`,
        )
        .run(passwordHash, now.toISOString(), userId, user.passwordHash, sessionTokenHash);
      if (!result.changes) return null;

      revokeUserSessions(userId, now, database);
      return createSession(userId, now, database);
    })
    .immediate();
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
