import type { Database } from "bun:sqlite";
import { getDb } from "$lib/server/core/db";

export const LOGIN_WINDOW_SECONDS = 15 * 60;
const USER_IP_LIMIT = 5;
const IP_LIMIT = 20;

export function isLoginThrottled(
  username: string,
  ipAddress: string,
  now: Date = new Date(),
  database: Database = getDb(),
): boolean {
  const cutoff = new Date(now.getTime() - LOGIN_WINDOW_SECONDS * 1000).toISOString();
  const row = database
    .prepare(
      `SELECT
         SUM(CASE WHEN username = ? COLLATE NOCASE THEN 1 ELSE 0 END) AS user_ip_count,
         COUNT(*) AS ip_count
       FROM auth_login_attempts
       WHERE ip_address = ? AND attempted_at >= ?`,
    )
    .get(username.trim(), ipAddress, cutoff) as { user_ip_count: number; ip_count: number };
  return row.user_ip_count >= USER_IP_LIMIT || row.ip_count >= IP_LIMIT;
}

export function recordFailedLogin(
  username: string,
  ipAddress: string,
  now: Date = new Date(),
  database: Database = getDb(),
): void {
  database
    .prepare(
      "INSERT INTO auth_login_attempts (username, ip_address, attempted_at) VALUES (?, ?, ?)",
    )
    .run(username.trim(), ipAddress, now.toISOString());
}

export function clearFailedLogins(
  username: string,
  ipAddress: string,
  database: Database = getDb(),
): void {
  database
    .prepare("DELETE FROM auth_login_attempts WHERE username = ? COLLATE NOCASE AND ip_address = ?")
    .run(username.trim(), ipAddress);
}

export function pruneAuthRecords(now: Date = new Date(), database: Database = getDb()): void {
  const attemptsBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const sessionsBefore = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  database.transaction(() => {
    database.prepare("DELETE FROM auth_login_attempts WHERE attempted_at < ?").run(attemptsBefore);
    database
      .prepare(
        `DELETE FROM app_sessions
         WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
      )
      .run(sessionsBefore, sessionsBefore);
  })();
}
