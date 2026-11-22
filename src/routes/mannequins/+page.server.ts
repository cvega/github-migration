import { error, fail } from "@sveltejs/kit";
import { matchMannequins } from "$lib/server/application/mannequin-matches";
import {
  getTargetMannequinClient,
  getTargetUserReadiness,
  inviteMappedMannequin,
  isMannequinTargetAuthAvailable,
  listAllOrganizationMannequins,
  mannequinTargetCredentialError,
} from "$lib/server/application/mannequins";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { getGhesTargetConnectionConfig } from "$lib/server/core/ghes-target";
import { getMigrationTargetProfile, getMigrationTargetProfiles } from "$lib/server/core/targets";
import {
  approveIdentityMapping,
  discoverIdentityMapping,
  listFailedGhesIdentityJobs,
  listIdentityMappings,
  removeIdentityMapping,
  saveIdentityMappings,
} from "$lib/server/migrate/database/identity-mappings";
import { getGhesImportJobByMigrationId } from "$lib/server/migrate/database/import-jobs";
import { getMigration } from "$lib/server/migrate/database/migrations";
import { getGhesUserConflicts } from "$lib/server/migrate/ghes/mapping";
import { GhesSshClient } from "$lib/server/migrate/ghes/ssh";
import {
  isIdentitySourceKind,
  parseIdentityCsv,
  validateIdentityInput,
} from "$lib/server/migrate/identity-input";
import type { Actions, PageServerLoad } from "./$types";

const LOGIN_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;
const NODE_ID_PATTERN = /^[a-zA-Z0-9_=-]{1,200}$/;

function statusOf(error: unknown): number | null {
  return error instanceof Error && "status" in error
    ? Number((error as Error & { status: unknown }).status)
    : null;
}

function selectedOrganization(url: URL, organizations: string[]): string | null {
  const requested = url.searchParams.get("org");
  if (requested && organizations.includes(requested)) return requested;
  return organizations[0] ?? null;
}

export const load: PageServerLoad = async ({ url }) => {
  const targets = getMigrationTargetProfiles();
  const cloud = getMigrationTargetProfile("ghec");
  const defaultTarget =
    cloud && mannequinTargetCredentialError(cloud)
      ? targets.find((profile) => profile.platform === "ghes")?.id
      : undefined;
  const target = getMigrationTargetProfile(url.searchParams.get("target") ?? defaultTarget);
  if (!target) error(400, "The selected target is not configured.");
  const targetOrganizations = target.organizations;
  const organization = selectedOrganization(url, targetOrganizations);
  const targetAuthReady = isMannequinTargetAuthAvailable(target);
  const credentialError = mannequinTargetCredentialError(target);
  const identityMappings = organization ? listIdentityMappings(target.apiUrl, organization) : [];
  const failedGhesJobs =
    target.platform === "ghes" && organization
      ? listFailedGhesIdentityJobs(target.apiUrl, organization)
      : [];

  return {
    targets,
    target,
    identityMappings,
    failedGhesJobs,
    targetOrganizations,
    organization,
    targetAuthReady,
    error: credentialError,
  };
};

export const actions: Actions = {
  removeMapping: async ({ request, locals }) => {
    const data = await request.formData();
    const targetId = String(data.get("target") ?? "").trim();
    const target = targetId ? getMigrationTargetProfile(targetId) : null;
    const organization = String(data.get("organization") ?? "").trim();
    const sourceKind = String(data.get("sourceKind") ?? "");
    const sourceIdentity = String(data.get("sourceIdentity") ?? "");
    if (!target?.organizations.includes(organization) || !isIdentitySourceKind(sourceKind)) {
      return fail(400, { error: "Choose a configured target and saved mapping." });
    }
    if (!removeIdentityMapping(target.apiUrl, organization, sourceKind, sourceIdentity)) {
      return fail(409, { error: "The mapping no longer exists or cannot be removed." });
    }
    recordOperatorAuditEvent(locals, {
      action: "migration.identity_mapping_removed",
      resourceType: "migration_identity",
      resourceId: sourceIdentity,
      metadata: { targetProfileId: target.id, organization, sourceKind },
    });
    return { success: "Mapping removed. Existing GitHub invitations are unchanged." };
  },
  saveMappings: async ({ request, locals }) => {
    const data = await request.formData();
    const targetId = String(data.get("target") ?? "").trim();
    const target = targetId ? getMigrationTargetProfile(targetId) : null;
    const organization = String(data.get("organization") ?? "").trim();
    const sourceKind = String(data.get("sourceKind") ?? "");
    if (
      !target?.organizations.includes(organization) ||
      !isIdentitySourceKind(sourceKind) ||
      (sourceKind.startsWith("ghe-migrator:") && target.platform !== "ghes")
    ) {
      return fail(400, { error: "Choose a configured target, organization, and identity type." });
    }
    try {
      const file = data.get("csv");
      const isCsv = file instanceof File && file.size > 0;
      if (isCsv && file.size > 256 * 1024)
        return fail(400, { error: "CSV files must be 256 KiB or smaller." });
      const mappings = isCsv
        ? parseIdentityCsv(sourceKind, await file.text())
        : [
            validateIdentityInput(sourceKind, {
              sourceIdentity: String(data.get("sourceIdentity") ?? ""),
              targetLogin: String(data.get("targetLogin") ?? ""),
            }),
          ];
      saveIdentityMappings(target.apiUrl, organization, sourceKind, mappings);
      recordOperatorAuditEvent(locals, {
        action: "migration.identity_mappings_saved",
        resourceType: "migration_identity",
        resourceId: organization,
        metadata: { targetProfileId: target.id, organization, sourceKind, count: mappings.length },
      });
      return {
        success: `Saved ${mappings.length} mapping(s). Check target users before applying them.`,
      };
    } catch (error) {
      return fail(400, {
        error: error instanceof Error ? error.message : "Could not save mappings.",
      });
    }
  },
  checkMappings: async ({ request }) => {
    const data = await request.formData();
    const targetId = String(data.get("target") ?? "").trim();
    const target = targetId ? getMigrationTargetProfile(targetId) : null;
    const organization = String(data.get("organization") ?? "").trim();
    if (!target?.organizations.includes(organization)) {
      return fail(400, { error: "Choose a configured target organization." });
    }
    if (!isMannequinTargetAuthAvailable(target) || mannequinTargetCredentialError(target)) {
      return fail(503, {
        error: mannequinTargetCredentialError(target) ?? "Target authentication is not configured.",
      });
    }
    const mappings = listIdentityMappings(target.apiUrl, organization).filter(
      (mapping) => mapping.sourceKind !== "mannequin",
    );
    try {
      const client = getTargetMannequinClient(target);
      const mannequinMappings = mappings.filter((mapping) =>
        mapping.sourceKind.startsWith("mannequin-"),
      );
      const mannequins =
        mannequinMappings.length > 0
          ? await listAllOrganizationMannequins(client, organization)
          : [];
      const matches = matchMannequins(mannequinMappings, mannequins);
      const invitationStates = new Map(
        listIdentityMappings(target.apiUrl, organization)
          .filter((mapping) => mapping.sourceKind === "mannequin")
          .map((mapping) => [mapping.sourceIdentity, mapping]),
      );
      const readiness = new Map<string, Awaited<ReturnType<typeof getTargetUserReadiness>>>();
      const checked = [];
      for (const mapping of mappings) {
        let user = "unmapped";
        if (mapping.targetLogin) {
          const loginKey = mapping.targetLogin.toLowerCase();
          let state = readiness.get(loginKey);
          if (!state) {
            state = await getTargetUserReadiness(client, organization, mapping.targetLogin);
            readiness.set(loginKey, state);
          }
          user = state;
        }
        const match = matches.get(mapping);
        const claimant = match?.kind === "matched" ? match.mannequin.claimant : null;
        const invitation =
          match?.kind === "matched" ? invitationStates.get(match.mannequin.id) : null;
        checked.push({
          sourceKind: mapping.sourceKind,
          sourceIdentity: mapping.sourceIdentity,
          user,
          match: match?.kind ?? null,
          claimant: claimant?.login ?? null,
          invitationStatus: invitation?.status ?? null,
          invitationTarget: invitation?.targetLogin ?? null,
        });
      }
      return { success: "Target users and mannequin matches checked.", checked };
    } catch (error) {
      console.error(
        `[mannequins] mapping check failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return fail(502, {
        error: "Could not check mappings against GitHub. Verify target access and try again.",
      });
    }
  },
  applyMappings: async ({ request, locals }) => {
    const data = await request.formData();
    const targetId = String(data.get("target") ?? "").trim();
    const target = targetId ? getMigrationTargetProfile(targetId) : null;
    const organization = String(data.get("organization") ?? "").trim();
    if (!target?.organizations.includes(organization)) {
      return fail(400, { error: "Choose a configured target organization." });
    }
    if (!isMannequinTargetAuthAvailable(target) || mannequinTargetCredentialError(target)) {
      return fail(503, {
        error: mannequinTargetCredentialError(target) ?? "Target authentication is not configured.",
      });
    }
    const mappings = listIdentityMappings(target.apiUrl, organization).filter(
      (mapping) =>
        mapping.sourceKind.startsWith("mannequin-") &&
        mapping.status === "approved" &&
        mapping.targetLogin,
    );
    if (!mappings.length)
      return fail(400, { error: "No approved mannequin mappings are available." });
    try {
      const client = getTargetMannequinClient(target);
      const mannequins = await listAllOrganizationMannequins(client, organization);
      const matches = matchMannequins(mappings, mannequins);
      const outcomes: Array<{ sourceKind: string; sourceIdentity: string; outcome: string }> = [];
      for (const mapping of mappings) {
        const outcome = (value: string) =>
          outcomes.push({
            sourceKind: mapping.sourceKind,
            sourceIdentity: mapping.sourceIdentity,
            outcome: value,
          });
        const match = matches.get(mapping);
        const targetLogin = mapping.targetLogin;
        if (!targetLogin || !match || match.kind !== "matched") {
          outcome(match?.kind ?? "missing");
          continue;
        }
        const mannequin = match.mannequin;
        if (mannequin.claimant) {
          outcome(
            mannequin.claimant.login.toLowerCase() === targetLogin.toLowerCase()
              ? "accepted"
              : "claimed by another user",
          );
          continue;
        }
        let readiness: Awaited<ReturnType<typeof getTargetUserReadiness>>;
        try {
          readiness = await getTargetUserReadiness(client, organization, targetLogin);
        } catch (error) {
          console.error(
            `[mannequins] target readiness failed: ${error instanceof Error ? error.message : "unknown error"}`,
          );
          outcome("target check failed");
          continue;
        }
        if (readiness !== "ready") {
          outcome(readiness);
          continue;
        }
        outcome(
          (
            await inviteMappedMannequin(
              client,
              target,
              organization,
              mannequin.id,
              targetLogin,
              locals,
            )
          ).outcome,
        );
      }
      return { success: "Finished processing mannequin mappings.", outcomes };
    } catch (error) {
      console.error(
        `[mannequins] mapping application failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return fail(502, { error: "Could not apply mappings. Check GitHub access and try again." });
    }
  },
  discover: async ({ request }) => {
    const formData = await request.formData();
    const targetId = String(formData.get("target") ?? "").trim();
    const organization = String(formData.get("organization") ?? "").trim();
    const migrationId = String(formData.get("migrationId") ?? "").trim();
    const target = targetId ? getMigrationTargetProfile(targetId) : null;
    const migration = getMigration(migrationId);
    const job = migration ? getGhesImportJobByMigrationId(migration.id) : null;
    if (
      target?.platform !== "ghes" ||
      !target.organizations.includes(organization) ||
      !migration ||
      migration.state !== "failed" ||
      migration.targetApiUrl !== target.apiUrl ||
      migration.targetOrg.toLowerCase() !== organization.toLowerCase() ||
      !job?.ghesImportId
    ) {
      return fail(400, { error: "Choose a failed GHES migration for the selected target." });
    }
    let ssh: GhesSshClient | null = null;
    try {
      const config = getGhesTargetConnectionConfig(migration.targetProfileId);
      if (config.profile.apiUrl !== target.apiUrl) {
        return fail(409, { error: "The GHES target changed since this migration was submitted." });
      }
      ssh = new GhesSshClient(config);
      await ssh.connect();
      const identities = getGhesUserConflicts((await ssh.conflicts(job.ghesImportId)).stdout);
      for (const identity of identities) {
        discoverIdentityMapping(
          target.apiUrl,
          organization,
          `ghe-migrator:${migration.sourceProvider}`,
          identity,
        );
      }
      return { success: `Found ${identities.length} GHES user conflict(s).` };
    } catch (error) {
      console.error("[mannequins] GHES conflict discovery failed", error);
      return fail(502, {
        error: `Could not load GHES user conflicts: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    } finally {
      ssh?.disconnect();
    }
  },
  invite: async ({ locals, request }) => {
    const formData = await request.formData();
    const organization = String(formData.get("organization") ?? "").trim();
    const mannequinId = String(formData.get("mannequinId") ?? "").trim();
    const targetLogin = String(formData.get("targetLogin") ?? "").trim();
    const targetId = String(formData.get("target") ?? "").trim();
    const target = targetId ? getMigrationTargetProfile(targetId) : null;

    if (!target?.organizations.includes(organization)) {
      return fail(400, { mannequinId, error: "Choose a configured target organization." });
    }
    if (!NODE_ID_PATTERN.test(mannequinId)) {
      return fail(400, { mannequinId, error: "The mannequin identifier is invalid." });
    }
    if (!LOGIN_PATTERN.test(targetLogin)) {
      return fail(400, { mannequinId, error: "Enter a valid GitHub username." });
    }
    if (!isMannequinTargetAuthAvailable(target)) {
      return fail(503, { mannequinId, error: "Target authentication is not configured." });
    }
    const credentialError = mannequinTargetCredentialError(target);
    if (credentialError) return fail(503, { mannequinId, error: credentialError });

    const invitation = await inviteMappedMannequin(
      getTargetMannequinClient(target),
      target,
      organization,
      mannequinId,
      targetLogin,
      locals,
    );
    if (invitation.outcome === "invitation already sent or uncertain") {
      return fail(409, {
        mannequinId,
        error: "An invitation is already sent or its outcome is uncertain; verify it in GitHub.",
      });
    }
    if (invitation.outcome !== "invitation sent") {
      const status = invitation.status;
      const message =
        status === 404
          ? `@${targetLogin} is not a visible member of ${organization}. The mapping was saved.`
          : status === 401 || status === 403
            ? "The target credential cannot create this invitation. The mapping was saved."
            : "The invitation outcome is uncertain. Verify it in GitHub before retrying.";
      return fail(status === 404 ? 400 : 502, { mannequinId, error: message });
    }
    return { mannequinId, success: `Invitation sent to @${invitation.targetLogin}.` };
  },
  approve: async ({ locals, request }) => {
    const formData = await request.formData();
    const targetId = String(formData.get("target") ?? "").trim();
    const organization = String(formData.get("organization") ?? "").trim();
    const sourceKind = String(formData.get("sourceKind") ?? "").trim();
    const sourceIdentity = String(formData.get("sourceIdentity") ?? "").trim();
    const targetLogin = String(formData.get("targetLogin") ?? "").trim();
    const target = targetId ? getMigrationTargetProfile(targetId) : null;
    if (
      target?.platform !== "ghes" ||
      !target.organizations.includes(organization) ||
      !sourceKind.startsWith("ghe-migrator:")
    ) {
      return fail(400, { sourceIdentity, error: "Choose a configured GHES target and source." });
    }
    if (!LOGIN_PATTERN.test(targetLogin)) {
      return fail(400, { sourceIdentity, error: "Enter a valid GitHub username." });
    }
    if (!isMannequinTargetAuthAvailable(target)) {
      return fail(503, { sourceIdentity, error: "GHES authentication is not configured." });
    }
    const mapping = listIdentityMappings(target.apiUrl, organization).find(
      (item) => item.sourceKind === sourceKind && item.sourceIdentity === sourceIdentity,
    );
    if (!mapping) return fail(400, { sourceIdentity, error: "The source identity was not found." });
    let user: { login: string };
    try {
      ({ data: user } = await getTargetMannequinClient(target).users.getByUsername({
        username: targetLogin,
      }));
    } catch (error) {
      const status = statusOf(error);
      return fail(status === 404 ? 400 : 502, {
        sourceIdentity,
        error:
          status === 404
            ? `@${targetLogin} was not found on the GHES target.`
            : "Could not verify the GHES target user. Try again.",
      });
    }
    approveIdentityMapping({
      targetApiUrl: target.apiUrl,
      targetOrg: organization,
      sourceKind,
      sourceIdentity,
      targetLogin: user.login,
    });
    recordOperatorAuditEvent(locals, {
      action: "migration.identity_mapping_approved",
      resourceType: "migration_identity",
      resourceId: sourceIdentity,
      metadata: { targetProfileId: target.id, organization, sourceKind, targetLogin: user.login },
    });
    return {
      sourceIdentity,
      success: `Mapped to @${user.login}. Restart the migration to apply it.`,
    };
  },
};
