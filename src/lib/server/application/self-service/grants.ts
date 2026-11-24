import { supportsMigrationTarget } from "$lib/migration-target";
import { getGitHubSourceConfig } from "$lib/server/core/auth";
import { recordAuditEvent } from "$lib/server/core/auth/audit";
import { findUserById } from "$lib/server/core/auth/users";
import {
  validateCredentialScope,
  validateProfileCredentialScope,
} from "$lib/server/core/credential-scope";
import { getDb } from "$lib/server/core/db";
import { latestSourceReports } from "$lib/server/profile/database/runs";
import { getBitbucketServerSourceConfig } from "$lib/server/source/bitbucket/config";
import { getGitLabSourceConfig } from "$lib/server/source/gitlab/config";
import {
  getSourceProviderAdapter,
  isSourceProvider,
  type SourceProvider,
} from "$lib/source-provider";
import { targetConnections } from "./target-catalog";

export interface Grant {
  sourceProvider: SourceProvider;
  sourceApiUrl: string;
  namespace: string;
  targetProfileId: string;
  targetOrg: string;
  canMigrate: boolean;
}

export class GrantPolicyError extends Error {}

export function configuredGrantSource(provider: SourceProvider): string {
  switch (provider) {
    case "github":
      return getGitHubSourceConfig().apiUrl;
    case "gitlab":
      return getGitLabSourceConfig().apiUrl;
    case "bitbucket-server":
      return getBitbucketServerSourceConfig().apiUrl;
  }
}

type Source = Pick<Grant, "sourceProvider" | "sourceApiUrl" | "namespace">;
type Connections = ReturnType<typeof targetConnections>;

function sourceRestriction(source: Source) {
  if (
    !isSourceProvider(source.sourceProvider) ||
    !source.sourceApiUrl ||
    source.sourceApiUrl !== configuredGrantSource(source.sourceProvider)
  )
    return "This report belongs to a source connection that is no longer configured.";
  if (
    !getSourceProviderAdapter(source.sourceProvider).isValidNamespace(source.namespace) ||
    !/^[A-Za-z0-9._/-]+$/.test(source.namespace)
  )
    return "This source name cannot be used for an exact mapping.";
  return validateProfileCredentialScope(source.sourceProvider, source.namespace);
}

function migrationRestriction(grant: Omit<Grant, "canMigrate">) {
  return validateCredentialScope({
    sourceProvider: grant.sourceProvider,
    targetProfileId: grant.targetProfileId,
    targetOrg: grant.targetOrg,
    sourceRepo: `${grant.namespace}/repo`,
  });
}

function allowedTarget(grant: Grant, targets: Connections) {
  if (sourceRestriction(grant)) return null;
  const target = targets.find(
    (t) =>
      t.id === grant.targetProfileId &&
      supportsMigrationTarget(grant.sourceProvider, t.platform) &&
      t.entries.some((e) => e.org === grant.targetOrg),
  );
  return target && (!grant.canMigrate || !migrationRestriction(grant)) ? target : null;
}

export function mappingSources() {
  return latestSourceReports(null).map((source) => ({
    ...source,
    key: JSON.stringify([source.sourceProvider, source.sourceApiUrl, source.namespace]),
    label: `${source.namespace} (${getSourceProviderAdapter(source.sourceProvider).displayName})`,
  }));
}

export function mappingChoices(source: Source | undefined) {
  if (!source) return { restriction: null, destinations: [] };
  const restriction = sourceRestriction(source);
  const destinations = restriction
    ? []
    : targetConnections().flatMap((target) =>
        supportsMigrationTarget(source.sourceProvider, target.platform)
          ? target.entries.map(({ org: targetOrg }) => ({
              key: JSON.stringify([
                source.sourceProvider,
                source.sourceApiUrl,
                source.namespace,
                target.id,
                target.apiUrl,
                targetOrg,
              ]),
              platform: target.platform,
              targetProfileId: target.id,
              targetApiUrl: target.apiUrl,
              targetOrg,
              migrationRestriction: migrationRestriction({
                ...source,
                targetProfileId: target.id,
                targetOrg,
              }),
            }))
          : [],
      );
  return { restriction, destinations };
}

type JoinedRow = Omit<Grant, "canMigrate"> & {
  canMigrate: number;
  id: string;
  userId: string;
  username: string;
  routeId: number;
  targetApiUrl: string;
};

const JOINED = `SELECT g.id, g.user_id AS userId, g.route_id AS routeId, u.username,
    r.source_provider AS sourceProvider, r.source_api_url AS sourceApiUrl, r.namespace,
    r.target_profile_id AS targetProfileId, r.target_api_url AS targetApiUrl,
    r.target_org AS targetOrg, g.can_migrate AS canMigrate
  FROM self_service_grants g JOIN app_users u ON u.id = g.user_id
  JOIN self_service_routes r ON r.id = g.route_id`;

function publicGrant(row: JoinedRow): Grant {
  return {
    sourceProvider: row.sourceProvider,
    sourceApiUrl: row.sourceApiUrl,
    namespace: row.namespace,
    targetProfileId: row.targetProfileId,
    targetOrg: row.targetOrg,
    canMigrate: row.canMigrate === 1,
  };
}

export function listAdminGrants(userId?: string) {
  return getDb()
    .query<JoinedRow, string[]>(
      `${JOINED} ${userId === undefined ? "" : "WHERE g.user_id = ?"}
       ORDER BY u.username, r.source_provider, r.namespace, r.target_profile_id, r.target_org`,
    )
    .all(...(userId === undefined ? [] : [userId]))
    .map((row) => ({
      ...publicGrant(row),
      id: row.id,
      userId: row.userId,
      username: row.username,
      targetApiUrl: row.targetApiUrl,
    }));
}

const ELIGIBLE =
  "g.user_id = ? AND u.role = 'operator' AND u.is_active = 1 AND u.must_change_password = 0";

type AssignedGrant = Grant & { id: string };

function currentGrant(row: JoinedRow, targets: Connections): AssignedGrant | null {
  const grant = publicGrant(row);
  return allowedTarget(grant, targets)?.apiUrl === row.targetApiUrl
    ? { ...grant, id: row.id }
    : null;
}

export function listGrants(userId: string): AssignedGrant[] {
  const targets = targetConnections();
  return getDb()
    .query<JoinedRow, [string]>(
      `${JOINED} WHERE ${ELIGIBLE} ORDER BY r.source_provider, r.namespace, r.target_profile_id, r.target_org`,
    )
    .all(userId)
    .map((row) => currentGrant(row, targets))
    .filter((grant) => grant !== null);
}

export function grantsForSource(
  userId: string,
  provider: SourceProvider,
  apiUrl: string,
  namespace: string,
) {
  return listGrants(userId).filter(
    (g) => g.sourceProvider === provider && g.sourceApiUrl === apiUrl && g.namespace === namespace,
  );
}

export function assignProfileDestinations(
  actorId: string,
  userId: string,
  source: string,
  destinations: string[],
  canMigrate: boolean,
) {
  getDb()
    .transaction(() => {
      const profile = mappingSources().find((p) => p.key === source);
      if (!profile || !destinations.length || new Set(destinations).size !== destinations.length)
        throw new GrantPolicyError("Choose a source and one or more distinct destinations.");
      const choices = mappingChoices(profile).destinations;
      for (const key of destinations) {
        const target = choices.find((d) => d.key === key);
        if (!target)
          throw new GrantPolicyError("A selected destination is not available for this source.");
        if (canMigrate && target.migrationRestriction)
          throw new GrantPolicyError(
            `${target.migrationRestriction}. Choose View only or update the deployment scope.`,
          );
        assignGrant(actorId, userId, {
          sourceProvider: profile.sourceProvider,
          sourceApiUrl: profile.sourceApiUrl,
          namespace: profile.namespace,
          targetProfileId: target.targetProfileId,
          targetOrg: target.targetOrg,
          canMigrate,
        });
      }
    })
    .immediate();
}

function requireGrantAdministrator(actorUserId: string) {
  const actor = findUserById(actorUserId);
  if (actor?.role !== "admin" || !actor.isActive || actor.mustChangePassword) {
    throw new GrantPolicyError("An active administrator is required.");
  }
}

export function assignGrant(actorUserId: string, userId: string, grant: Grant): void {
  const db = getDb();
  db.transaction(() => {
    requireGrantAdministrator(actorUserId);
    const user = findUserById(userId);
    if (user?.role !== "operator" || !user.isActive)
      throw new GrantPolicyError("Choose an active operator.");
    const target = allowedTarget(grant, targetConnections());
    if (!target || typeof grant.canMigrate !== "boolean")
      throw new GrantPolicyError(
        "Choose a configured source, exact namespace, and supported destination.",
      );
    const key = [grant.sourceProvider, grant.sourceApiUrl, grant.namespace] as const;
    db.query(`INSERT INTO self_service_routes
      (source_provider, source_api_url, namespace, target_profile_id, target_api_url, target_org)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (source_provider, source_api_url, namespace, target_profile_id, target_api_url, target_org) DO NOTHING`).run(
      ...key,
      target.id,
      target.apiUrl,
      grant.targetOrg,
    );
    const route = db
      .query<{ id: number }, [string, string, string, string, string, string]>(
        `SELECT id FROM self_service_routes WHERE source_provider = ? AND source_api_url = ?
       AND namespace = ? COLLATE BINARY AND target_profile_id = ? AND target_api_url = ? AND target_org = ?`,
      )
      .get(...key, target.id, target.apiUrl, grant.targetOrg);
    if (!route) throw new Error("Assigned route was not persisted");
    const id = crypto.randomUUID();
    const change = db
      .query(`INSERT INTO self_service_grants (id, route_id, user_id, can_migrate)
      VALUES (?, ?, ?, ?) ON CONFLICT (user_id, route_id) DO NOTHING`)
      .run(id, route.id, userId, Number(grant.canMigrate));
    if (!change.changes) throw new GrantPolicyError("This operator already has that assignment.");
    recordAuditEvent({
      action: "grant.assigned",
      actorUserId,
      targetUserId: userId,
      resourceType: "grant",
      resourceId: id,
      metadata: {
        sourceProvider: grant.sourceProvider,
        sourceApiUrl: grant.sourceApiUrl,
        namespace: grant.namespace,
        targetProfileId: target.id,
        targetApiUrl: target.apiUrl,
        targetOrg: grant.targetOrg,
        canMigrate: grant.canMigrate,
      },
    });
  }).immediate();
}

export function revokeGrant(actorUserId: string, id: string, userId?: string): void {
  const db = getDb();
  db.transaction(() => {
    requireGrantAdministrator(actorUserId);
    const row = db.query<JoinedRow, [string]>(`${JOINED} WHERE g.id = ?`).get(id);
    if (!row || (userId !== undefined && row.userId !== userId))
      throw new GrantPolicyError("That assignment no longer exists.");
    db.query("DELETE FROM self_service_grants WHERE id = ?").run(id);
    db.query(`DELETE FROM self_service_routes WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM self_service_grants WHERE route_id = ?)`).run(
      row.routeId,
      row.routeId,
    );
    recordAuditEvent({
      action: "grant.revoked",
      actorUserId,
      targetUserId: row.userId,
      resourceType: "grant",
      resourceId: id,
      metadata: { ...publicGrant(row), targetApiUrl: row.targetApiUrl },
    });
  }).immediate();
}
