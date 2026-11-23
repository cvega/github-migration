import type { CreateMigrationRequest, Migration } from "$lib/migrate/types";
import { isCancellableMigrationState } from "$lib/migration-state";
import { validateAuthAvailable } from "$lib/server/application/migration-policy";
import { recordAuditEvent } from "$lib/server/core/auth/audit";
import { getMigrationTargetProfile } from "$lib/server/core/targets";
import { getOwnedMigration } from "$lib/server/migrate/database/migrations";
import {
  cancel,
  enqueueOwnedBatch,
  restart,
  setOwnedDispatchPolicy,
} from "$lib/server/migrate/manager";
import { isSourceProvider, type SourceProvider } from "$lib/source-provider";
import { type Grant, listGrants, resolveGrant } from "./grants";
import { lookupCurrentRepository } from "./inventory";

const denied = () => new Error("Operator migration is not available");

function ownedExecutionGrant(userId: string, job: Migration): Grant | null {
  if (job.ownerUserId !== userId) return null;
  const grant = resolveGrant(userId, job.sourceProvider, job.sourceApiUrl, job.sourceOrg);
  const target = getMigrationTargetProfile(job.targetProfileId);
  if (
    !grant ||
    grant.targetProfileId !== job.targetProfileId ||
    grant.targetOrg !== job.targetOrg ||
    !target ||
    target.apiUrl !== job.targetApiUrl ||
    target.platform !== job.targetPlatform ||
    job.sourceRepo !== job.targetRepo ||
    job.routeExecutionPaused
  )
    return null;
  return lookupCurrentRepository(grant, job.sourceRepo)?.path ===
    `${job.sourceOrg}/${job.sourceRepo}`
    ? grant
    : null;
}

function requestFor(grant: Grant, repo: string): CreateMigrationRequest {
  return {
    sourceProvider: grant.sourceProvider,
    sourceApiUrl: grant.sourceApiUrl,
    sourceRepo: `${grant.namespace}/${repo}`,
    targetProfileId: grant.targetProfileId,
    targetOrg: grant.targetOrg,
    targetRepo: repo,
  };
}

export function configureOperatorJobPolicy(): void {
  setOwnedDispatchPolicy((job) => {
    const grant = job.ownerUserId ? ownedExecutionGrant(job.ownerUserId, job) : null;
    if (!grant?.canMigrate) throw denied();
    const request = requestFor(grant, job.sourceRepo);
    if (validateAuthAvailable(request)) throw denied();
    return request;
  });
}

export function ownJobActions(userId: string, id: string) {
  const job = getOwnedMigration(userId, id);
  const grant = job && ownedExecutionGrant(userId, job);
  if (!job || !grant) return { canRestart: false, canCancel: false };
  return {
    canRestart:
      grant.canMigrate &&
      (job.state === "failed" || job.state === "cancelled") &&
      !validateAuthAvailable(requestFor(grant, job.sourceRepo)),
    canCancel: grant.canMigrate && isCancellableMigrationState(job.state),
  };
}

export function submitOwnBatch(
  userId: string,
  selection: {
    sourceProvider: SourceProvider;
    namespace: string;
    repos: string[];
  },
) {
  if (
    !selection ||
    Object.keys(selection).some((k) => !["sourceProvider", "namespace", "repos"].includes(k)) ||
    !isSourceProvider(selection.sourceProvider) ||
    typeof selection.namespace !== "string" ||
    !Array.isArray(selection.repos) ||
    selection.repos.length < 1 ||
    selection.repos.length > 500
  )
    throw denied();
  const matches = listGrants(userId).filter(
    (grant) =>
      grant.sourceProvider === selection.sourceProvider && grant.namespace === selection.namespace,
  );
  const grant = matches[0];
  if (matches.length !== 1 || !grant?.canMigrate) throw denied();
  const targets = new Set<string>();
  const requests = selection.repos.map((repo) => {
    // Match exactly; do not normalize user input into an authorized name.
    if (
      typeof repo !== "string" ||
      !/^[a-zA-Z0-9._-]{1,100}$/.test(repo) ||
      repo === "." ||
      repo === ".." ||
      targets.has(repo.toLowerCase())
    )
      throw denied();
    targets.add(repo.toLowerCase());
    return requestFor(grant, repo);
  });
  const batch = enqueueOwnedBatch(userId, requests);
  recordAuditEvent({
    actorUserId: userId,
    action: "operator.batch.submitted",
    resourceType: "batch",
    resourceId: batch.batchId,
  });
  return batch;
}

export function cancelOwnJob(userId: string, id: string): boolean {
  if (!ownJobActions(userId, id).canCancel || !cancel(id)) return false;
  recordAuditEvent({
    actorUserId: userId,
    action: "operator.migration.cancelled",
    resourceType: "migration",
    resourceId: id,
  });
  return true;
}

export function restartOwnJob(userId: string, id: string) {
  if (!ownJobActions(userId, id).canRestart) throw denied();
  restart(id, {});
  recordAuditEvent({
    actorUserId: userId,
    action: "operator.migration.restarted",
    resourceType: "migration",
    resourceId: id,
  });
}
