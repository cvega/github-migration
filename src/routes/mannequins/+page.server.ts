import { fail } from "@sveltejs/kit";
import {
  createAttributionInvitation,
  getTargetMannequinClient,
  listOrganizationMannequins,
  listOrganizationMembers,
} from "$lib/server/application/mannequins";
import { isTargetAuthAvailable } from "$lib/server/core/auth";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { getMigrationTargetProfile } from "$lib/server/core/targets";
import type { Actions, PageServerLoad } from "./$types";

const LOGIN_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;
const NODE_ID_PATTERN = /^[a-zA-Z0-9_=-]{1,200}$/;

function statusOf(error: unknown): number | null {
  return error instanceof Error && "status" in error
    ? Number((error as Error & { status: unknown }).status)
    : null;
}

function loadErrorMessage(error: unknown): string {
  const status = statusOf(error);
  if (status === 401) {
    return "A target credential is configured, but GitHub rejected it (401). Replace GH_TARGET_PAT or verify the target GitHub App installation.";
  }
  if (status === 403) return "The target credential cannot view mannequins for this organization.";
  if (status === 404) return "The configured target organization was not found.";
  console.error(
    `[mannequins] discovery failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  return "GitHub could not load mannequins. Check target access and try again.";
}

function selectedOrganization(url: URL, organizations: string[]): string | null {
  const requested = url.searchParams.get("org");
  if (requested && organizations.includes(requested)) return requested;
  return organizations[0] ?? null;
}

function requestedPage(url: URL): number {
  const value = Number(url.searchParams.get("page") ?? "1");
  return Number.isSafeInteger(value) && value > 0 && value <= 100 ? value : 1;
}

export const load: PageServerLoad = async ({ url }) => {
  const targetOrganizations = getMigrationTargetProfile("ghec")?.organizations ?? [];
  const organization = selectedOrganization(url, targetOrganizations);
  const targetAuthReady = isTargetAuthAvailable();

  if (!organization || !targetAuthReady) {
    return {
      targetOrganizations,
      organization,
      targetAuthReady,
      result: null,
      targetMembers: [],
      memberDiscoveryLimited: false,
      error: null,
    };
  }

  try {
    const client = getTargetMannequinClient();
    const [result, members] = await Promise.allSettled([
      listOrganizationMannequins(client, organization, requestedPage(url)),
      listOrganizationMembers(client, organization),
    ]);
    if (result.status === "rejected") throw result.reason;
    if (members.status === "rejected") {
      console.warn(
        `[mannequins] member discovery limited: ${members.reason instanceof Error ? members.reason.message : "unknown error"}`,
      );
    }
    return {
      targetOrganizations,
      organization,
      targetAuthReady,
      result: result.value,
      targetMembers: members.status === "fulfilled" ? members.value : [],
      memberDiscoveryLimited: members.status === "rejected",
      error: null,
    };
  } catch (error) {
    return {
      targetOrganizations,
      organization,
      targetAuthReady,
      result: null,
      targetMembers: [],
      memberDiscoveryLimited: false,
      error: loadErrorMessage(error),
    };
  }
};

export const actions: Actions = {
  invite: async ({ locals, request }) => {
    const formData = await request.formData();
    const organization = String(formData.get("organization") ?? "").trim();
    const mannequinId = String(formData.get("mannequinId") ?? "").trim();
    const targetLogin = String(formData.get("targetLogin") ?? "").trim();
    const targetOrganizations = getMigrationTargetProfile("ghec")?.organizations ?? [];

    if (!targetOrganizations.includes(organization)) {
      return fail(400, { mannequinId, error: "Choose a configured target organization." });
    }
    if (!NODE_ID_PATTERN.test(mannequinId)) {
      return fail(400, { mannequinId, error: "The mannequin identifier is invalid." });
    }
    if (!LOGIN_PATTERN.test(targetLogin)) {
      return fail(400, { mannequinId, error: "Enter a valid GitHub username." });
    }
    if (!isTargetAuthAvailable()) {
      return fail(503, { mannequinId, error: "Target authentication is not configured." });
    }

    try {
      const invitation = await createAttributionInvitation(getTargetMannequinClient(), {
        organization,
        mannequinId,
        targetLogin,
      });
      recordOperatorAuditEvent(locals, {
        action: "mannequin.invitation_created",
        resourceType: "mannequin",
        resourceId: mannequinId,
        metadata: { organization, targetLogin: invitation.targetLogin },
      });
      return {
        mannequinId,
        success: `Invitation sent to @${invitation.targetLogin}.`,
      };
    } catch (error) {
      const status = statusOf(error);
      const message =
        status === 404
          ? `@${targetLogin} is not a visible member of ${organization}.`
          : status === 401 || status === 403
            ? "The target credential cannot create this attribution invitation."
            : "GitHub could not create the invitation. Try again.";
      return fail(status === 404 ? 400 : 502, { mannequinId, error: message });
    }
  },
};
