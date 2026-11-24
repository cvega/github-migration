import { recordAuditEvent } from "$lib/server/core/auth/audit";
import { getDb } from "$lib/server/core/db";
import { getMigrationTargetProfiles } from "$lib/server/core/targets";
import { getSourceProviderAdapter } from "$lib/source-provider";

export class TargetCatalogError extends Error {}

export function targetConnections() {
  const listed = getDb()
    .query<{ id: string; apiUrl: string; organization: string }, []>(
      `SELECT target_profile_id AS id, target_api_url AS apiUrl, organization
       FROM target_organizations ORDER BY organization`,
    )
    .all();
  return getMigrationTargetProfiles().map(
    ({ id, platform, displayName, apiUrl, organizations }) => {
      const entries = new Map<string, { org: string; configured: boolean }>();
      for (const org of organizations) {
        if (
          getSourceProviderAdapter("github").isValidNamespace(org) &&
          !entries.has(org.toLowerCase())
        )
          entries.set(org.toLowerCase(), { org, configured: true });
      }
      for (const row of listed) {
        if (row.id === id && row.apiUrl === apiUrl && !entries.has(row.organization.toLowerCase()))
          entries.set(row.organization.toLowerCase(), { org: row.organization, configured: false });
      }
      return {
        id,
        platform,
        displayName,
        apiUrl,
        scopePinned: organizations.length > 0,
        key: JSON.stringify([id, apiUrl]),
        entries: [...entries.values()],
      };
    },
  );
}

export function requireTargetConnection(key: string) {
  const connection = targetConnections().find((c) => c.key === key);
  if (!connection)
    throw new TargetCatalogError("That target connection has changed. Reload the list.");
  return connection;
}

export function changeCatalogTarget(actorId: string, key: string, input: string, add: boolean) {
  const org = input.trim();
  if (!getSourceProviderAdapter("github").isValidNamespace(org))
    throw new TargetCatalogError(
      "Enter a GitHub organization login, not a URL or repository name.",
    );
  const db = getDb();
  return db
    .transaction(() => {
      const connection = requireTargetConnection(key);
      const existing = connection.entries.find((e) => e.org.toLowerCase() === org.toLowerCase());
      if (add && existing)
        throw new TargetCatalogError("That organization is already listed on this connection.");
      if (!add && (!existing || existing.configured))
        throw new TargetCatalogError("Only organizations added to this list can be removed here.");
      const identity = [connection.id, connection.apiUrl, existing?.org ?? org] as const;
      if (add) {
        db.query(
          "INSERT INTO target_organizations (target_profile_id,target_api_url,organization) VALUES (?,?,?)",
        ).run(...identity);
      } else {
        if (
          db
            .query(`SELECT 1 FROM self_service_routes r JOIN self_service_grants g ON g.route_id=r.id
          WHERE r.target_profile_id=? AND r.target_api_url=? AND r.target_org=? COLLATE NOCASE LIMIT 1`)
            .get(...identity)
        )
          throw new TargetCatalogError(
            "Remove user mappings for this target before removing the organization.",
          );
        db.query(
          "DELETE FROM target_organizations WHERE target_profile_id=? AND target_api_url=? AND organization=?",
        ).run(...identity);
      }
      recordAuditEvent({
        actorUserId: actorId,
        action: add ? "target.listed" : "target.unlisted",
        resourceType: "target",
        metadata: {
          targetProfileId: connection.id,
          targetApiUrl: connection.apiUrl,
          organization: org,
        },
      });
    })
    .immediate();
}
