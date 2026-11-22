import { getDb } from "$lib/server/core/db";
import type { IdentityInput, IdentitySourceKind } from "../identity-input";

export interface IdentityMapping {
  targetApiUrl: string;
  targetOrg: string;
  sourceKind: string;
  sourceIdentity: string;
  targetLogin: string | null;
  status: "unmapped" | "approved" | "invitation_pending" | "invitation_sent";
}

interface IdentityMappingRow {
  target_api_url: string;
  target_org: string;
  source_kind: string;
  source_identity: string;
  target_login: string | null;
  status: IdentityMapping["status"];
}

function mapRow(row: IdentityMappingRow): IdentityMapping {
  return {
    targetApiUrl: row.target_api_url,
    targetOrg: row.target_org,
    sourceKind: row.source_kind,
    sourceIdentity: row.source_identity,
    targetLogin: row.target_login,
    status: row.status,
  };
}

export function listIdentityMappings(targetApiUrl: string, targetOrg: string): IdentityMapping[] {
  const rows = getDb()
    .prepare(
      `SELECT target_api_url, target_org, source_kind, source_identity, target_login, status
       FROM migration_identity_mappings WHERE target_api_url = ? AND target_org = ?
       ORDER BY source_kind, source_identity`,
    )
    .all(targetApiUrl, targetOrg) as IdentityMappingRow[];
  return rows.map(mapRow);
}

export function discoverIdentityMapping(
  targetApiUrl: string,
  targetOrg: string,
  sourceKind: string,
  sourceIdentity: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO migration_identity_mappings
       (target_api_url, target_org, source_kind, source_identity, target_login, status, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'unmapped', ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(targetApiUrl, targetOrg, sourceKind, sourceIdentity, new Date().toISOString());
}

export function approveIdentityMapping(mapping: {
  targetApiUrl: string;
  targetOrg: string;
  sourceKind: string;
  sourceIdentity: string;
  targetLogin: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO migration_identity_mappings
       (target_api_url, target_org, source_kind, source_identity, target_login, status, updated_at)
       VALUES (?, ?, ?, ?, ?, 'approved', ?)
       ON CONFLICT (target_api_url, target_org, source_kind, source_identity)
       DO UPDATE SET target_login = excluded.target_login, status = 'approved',
         updated_at = excluded.updated_at`,
    )
    .run(
      mapping.targetApiUrl,
      mapping.targetOrg,
      mapping.sourceKind,
      mapping.sourceIdentity,
      mapping.targetLogin,
      new Date().toISOString(),
    );
}

export function saveIdentityMappings(
  targetApiUrl: string,
  targetOrg: string,
  sourceKind: IdentitySourceKind,
  mappings: IdentityInput[],
): void {
  const db = getDb();
  const find = db.prepare(
    `SELECT target_login, status FROM migration_identity_mappings
     WHERE target_api_url = ? AND target_org = ? AND source_kind = ? AND source_identity = ?`,
  );
  const save = db.prepare(
    `INSERT INTO migration_identity_mappings
     (target_api_url, target_org, source_kind, source_identity, target_login, status, updated_at)
     VALUES (?, ?, ?, ?, ?, 'approved', ?)
     ON CONFLICT (target_api_url, target_org, source_kind, source_identity)
     DO UPDATE SET target_login = excluded.target_login, status = 'approved', updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const mapping of mappings) {
      const current = find.get(targetApiUrl, targetOrg, sourceKind, mapping.sourceIdentity) as {
        target_login: string | null;
        status: IdentityMapping["status"];
      } | null;
      if (
        current?.target_login &&
        current.target_login.toLowerCase() !== mapping.targetLogin.toLowerCase()
      ) {
        throw new Error(`A different target is already saved for ${mapping.sourceIdentity}.`);
      }
      if (current && !["unmapped", "approved"].includes(current.status)) {
        throw new Error(
          `An invitation for ${mapping.sourceIdentity} is already in progress or sent.`,
        );
      }
      save.run(
        targetApiUrl,
        targetOrg,
        sourceKind,
        mapping.sourceIdentity,
        mapping.targetLogin,
        new Date().toISOString(),
      );
    }
  })();
}

export function removeIdentityMapping(
  targetApiUrl: string,
  targetOrg: string,
  sourceKind: IdentitySourceKind,
  sourceIdentity: string,
): boolean {
  const result = getDb()
    .prepare(
      `DELETE FROM migration_identity_mappings
       WHERE target_api_url = ? AND target_org = ? AND source_kind = ? AND source_identity = ?
       AND status IN ('unmapped', 'approved')`,
    )
    .run(targetApiUrl, targetOrg, sourceKind, sourceIdentity);
  return result.changes === 1;
}

export function markIdentityInvitationSent(mapping: {
  targetApiUrl: string;
  targetOrg: string;
  sourceIdentity: string;
  targetLogin: string;
}): void {
  const result = getDb()
    .prepare(
      `UPDATE migration_identity_mappings SET status = 'invitation_sent', updated_at = ?
       WHERE target_api_url = ? AND target_org = ? AND source_kind = 'mannequin'
       AND source_identity = ? AND target_login = ? AND status = 'invitation_pending'`,
    )
    .run(
      new Date().toISOString(),
      mapping.targetApiUrl,
      mapping.targetOrg,
      mapping.sourceIdentity,
      mapping.targetLogin,
    );
  if (result.changes !== 1)
    throw new Error("Identity mapping changed during invitation submission");
}

export function beginIdentityInvitation(mapping: {
  targetApiUrl: string;
  targetOrg: string;
  sourceIdentity: string;
  targetLogin: string;
}): boolean {
  const result = getDb()
    .prepare(
      `INSERT INTO migration_identity_mappings
       (target_api_url, target_org, source_kind, source_identity, target_login, status, updated_at)
       VALUES (?, ?, 'mannequin', ?, ?, 'invitation_pending', ?)
       ON CONFLICT (target_api_url, target_org, source_kind, source_identity)
       DO UPDATE SET target_login = excluded.target_login, status = 'invitation_pending',
         updated_at = excluded.updated_at
       WHERE migration_identity_mappings.status IN ('unmapped', 'approved')`,
    )
    .run(
      mapping.targetApiUrl,
      mapping.targetOrg,
      mapping.sourceIdentity,
      mapping.targetLogin,
      new Date().toISOString(),
    );
  return result.changes === 1;
}

export function rejectIdentityInvitation(mapping: {
  targetApiUrl: string;
  targetOrg: string;
  sourceIdentity: string;
  targetLogin: string;
}): void {
  const result = getDb()
    .prepare(
      `UPDATE migration_identity_mappings SET status = 'approved', updated_at = ?
       WHERE target_api_url = ? AND target_org = ? AND source_kind = 'mannequin'
       AND source_identity = ? AND target_login = ? AND status = 'invitation_pending'`,
    )
    .run(
      new Date().toISOString(),
      mapping.targetApiUrl,
      mapping.targetOrg,
      mapping.sourceIdentity,
      mapping.targetLogin,
    );
  if (result.changes !== 1)
    throw new Error("Identity mapping changed during invitation submission");
}
