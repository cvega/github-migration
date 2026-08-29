import type { Database } from "bun:sqlite";
import { getDb } from "$lib/server/core/db";

export interface AuditEventInput {
  actorUserId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  targetUserId?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface AuditEvent {
  id: number;
  actorUsername: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  targetUsername: string | null;
  ipAddress: string | null;
  createdAt: string;
}

interface AuditEventRow {
  id: number;
  actor_username: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  target_username: string | null;
  ip_address: string | null;
  created_at: string;
}

export function recordAuditEvent(input: AuditEventInput, database: Database = getDb()): void {
  database
    .prepare(
      `INSERT INTO audit_events
       (actor_user_id, action, resource_type, resource_id, target_user_id,
        ip_address, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.actorUserId ?? null,
      input.action,
      input.resourceType ?? null,
      input.resourceId ?? null,
      input.targetUserId ?? null,
      input.ipAddress ?? null,
      JSON.stringify(input.metadata ?? {}),
      (input.createdAt ?? new Date()).toISOString(),
    );
}

export function recordOperatorAuditEvent(
  locals: App.Locals | undefined,
  input: AuditEventInput,
  database?: Database,
): void {
  if (!locals) return;
  recordAuditEvent({ ...input, actorUserId: locals.user?.id ?? null }, database);
}

export function listAuditEvents(limit = 100, database: Database = getDb()): AuditEvent[] {
  const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const rows = database
    .prepare(
      `SELECT e.id, actor.username AS actor_username, e.action,
              e.resource_type, e.resource_id, target.username AS target_username,
              e.ip_address, e.created_at
       FROM audit_events e
       LEFT JOIN app_users actor ON actor.id = e.actor_user_id
       LEFT JOIN app_users target ON target.id = e.target_user_id
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ?`,
    )
    .all(boundedLimit) as AuditEventRow[];
  return rows.map((row) => ({
    id: row.id,
    actorUsername: row.actor_username,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    targetUsername: row.target_username,
    ipAddress: row.ip_address,
    createdAt: row.created_at,
  }));
}
