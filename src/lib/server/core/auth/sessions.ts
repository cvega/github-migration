import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "$lib/server/core/db";
import type { AuthPrincipal, UserRole } from "./model";

export const SESSION_COOKIE = "gh_migrate_session";
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const SESSION_MAX_COUNT = 5;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

interface SessionRow {
  token_hash: string;
  user_id: string;
  username: string;
  display_name: string | null;
  role: UserRole;
  is_active: number;
  must_change_password: number;
  last_seen_at: string;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createSession(
  userId: string,
  now: Date = new Date(),
  database: Database = getDb(),
): string {
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE * 1000).toISOString();

  database.transaction(() => {
    database.prepare("DELETE FROM app_sessions WHERE expires_at < ?").run(createdAt);
    const active = database
      .prepare(
        `SELECT token_hash FROM app_sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at >= ?
         ORDER BY created_at, token_hash`,
      )
      .all(userId, createdAt) as Array<{ token_hash: string }>;
    for (const session of active.slice(0, Math.max(0, active.length - SESSION_MAX_COUNT + 1))) {
      database
        .prepare("UPDATE app_sessions SET revoked_at = ? WHERE token_hash = ?")
        .run(createdAt, session.token_hash);
    }
    database
      .prepare(
        `INSERT INTO app_sessions
         (token_hash, user_id, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(tokenHash, userId, createdAt, createdAt, expiresAt);
  })();
  return token;
}

export function resolveSession(
  token: string,
  now: Date = new Date(),
  database: Database = getDb(),
): AuthPrincipal | null {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const nowIso = now.toISOString();
  const row = database
    .prepare(
      `SELECT s.token_hash, s.user_id, s.last_seen_at, u.username, u.display_name,
              u.role, u.is_active, u.must_change_password
       FROM app_sessions s
       JOIN app_users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at >= ? AND u.is_active = 1`,
    )
    .get(tokenHash, nowIso) as SessionRow | null;
  if (!row) return null;

  if (now.getTime() - Date.parse(row.last_seen_at) >= LAST_SEEN_WRITE_INTERVAL_MS) {
    database
      .prepare("UPDATE app_sessions SET last_seen_at = ? WHERE token_hash = ?")
      .run(nowIso, tokenHash);
  }
  return {
    user: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      isActive: row.is_active === 1,
      mustChangePassword: row.must_change_password === 1,
    },
    sessionTokenHash: tokenHash,
  };
}

export function revokeSession(
  token: string,
  now: Date = new Date(),
  database: Database = getDb(),
): void {
  database
    .prepare("UPDATE app_sessions SET revoked_at = ? WHERE token_hash = ?")
    .run(now.toISOString(), hashSessionToken(token));
}

export function revokeUserSessions(
  userId: string,
  now: Date = new Date(),
  database: Database = getDb(),
): void {
  database
    .prepare("UPDATE app_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .run(now.toISOString(), userId);
}
