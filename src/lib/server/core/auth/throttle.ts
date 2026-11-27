import type { Database } from "bun:sqlite";
import { getDb } from "$lib/server/core/db";

export const LOGIN_WINDOW_SECONDS = 15 * 60;
const USER_IP_LIMIT = 5;
const IP_LIMIT = 20;

// Each password verification can allocate 64 MiB. Reject excess work before hashing.
const MAX_ACTIVE_VERIFICATIONS = 5;
let activeVerifications = 0;

export async function verifyLoginAttempt<T>(
  username: string,
  ipAddress: string,
  verify: () => Promise<T | null>,
  database: Database = getDb(),
  now: Date = new Date(),
): Promise<{ throttled: true } | { throttled: false; user: T | null }> {
  if (activeVerifications >= MAX_ACTIVE_VERIFICATIONS) return { throttled: true };

  const cutoff = new Date(now.getTime() - LOGIN_WINDOW_SECONDS * 1000).toISOString();
  const reservation = database
    .prepare(
      `INSERT INTO auth_login_attempts (username, ip_address, attempted_at)
     SELECT ?, ?, ?
     FROM (SELECT COUNT(*) AS address_count, COUNT(*) FILTER (WHERE username = ?) AS pair_count
           FROM auth_login_attempts WHERE ip_address = ? AND attempted_at >= ?)
     WHERE address_count < ? AND pair_count < ?`,
    )
    .run(
      username.trim(),
      ipAddress,
      now.toISOString(),
      username.trim(),
      ipAddress,
      cutoff,
      IP_LIMIT,
      USER_IP_LIMIT,
    );
  if (!reservation.changes) return { throttled: true };

  activeVerifications++;
  try {
    const user = await verify();
    if (user !== null) {
      database
        .prepare("DELETE FROM auth_login_attempts WHERE id = ?")
        .run(reservation.lastInsertRowid);
    }
    return { throttled: false, user };
  } finally {
    activeVerifications--;
  }
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
