import { json } from "@sveltejs/kit";
import { parseJsonBody } from "$lib/server/application/request-body";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { validateProfileCredentialScope } from "$lib/server/core/credential-scope";
import {
  countProfileRuns,
  listProfileRunsWithInventoryCounts,
  ProfileRunCapacityError,
} from "$lib/server/profile/database/runs";
import {
  runBitbucketInventoryProfile,
  runGitLabInventoryProfile,
} from "$lib/server/profile/inventory-runner";
import { validateStartProfileRequest } from "$lib/server/profile/request";
import {
  BitbucketProfileCapacityError,
  GitLabProfileCapacityError,
  startBitbucketServerProfile,
  startGitLabProfile,
  startOrgProfile,
} from "$lib/server/profile/service";
import { BitbucketServerApiError } from "$lib/server/source/bitbucket/client";
import {
  BitbucketServerSourceConfigurationError,
  getBitbucketServerSourceClient,
} from "$lib/server/source/bitbucket/config";
import { discoverBitbucketInventory } from "$lib/server/source/bitbucket/inventory";
import { collectBitbucketProfileEnrichment } from "$lib/server/source/bitbucket/profile";
import { GitLabApiError } from "$lib/server/source/gitlab/client";
import {
  GitLabSourceConfigurationError,
  getGitLabSourceClient,
} from "$lib/server/source/gitlab/config";
import { discoverGitLabInventory } from "$lib/server/source/gitlab/inventory";
import { collectGitLabProfileEnrichment } from "$lib/server/source/gitlab/profile";
import type { RequestHandler } from "./$types";

const defaults = {
  countProfileRuns,
  listProfileRuns: listProfileRunsWithInventoryCounts,
  startOrgProfile,
  startGitLabProfile: (namespace: string) =>
    startGitLabProfile(namespace, {
      buildSourceClient: getGitLabSourceClient,
      run: (client, input, onProgress) =>
        runGitLabInventoryProfile(client, input, onProgress, {
          discover: discoverGitLabInventory,
          enrich: collectGitLabProfileEnrichment,
          isApiError: (error) => error instanceof GitLabApiError,
        }),
      newId: () => Bun.randomUUIDv7(),
    }),
  startBitbucketServerProfile: (namespace: string) =>
    startBitbucketServerProfile(namespace, {
      buildSourceClient: getBitbucketServerSourceClient,
      run: (client, input, onProgress) =>
        runBitbucketInventoryProfile(client, input, onProgress, {
          discover: discoverBitbucketInventory,
          enrich: collectBitbucketProfileEnrichment,
          isApiError: (error) => error instanceof BitbucketServerApiError,
        }),
      newId: () => Bun.randomUUIDv7(),
    }),
};
let dependencies = { ...defaults };
export function __setProfileRouteDependenciesForTests(
  overrides: Partial<typeof defaults>,
): () => void {
  dependencies = { ...defaults, ...overrides };
  return () => {
    dependencies = { ...defaults };
  };
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await parseJsonBody(request);
  if ("error" in body) return json({ error: body.error }, { status: body.status });
  const parsed = validateStartProfileRequest(body.data);
  if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });
  const scopeError = validateProfileCredentialScope(parsed.value.sourceProvider, parsed.value.org);
  if (scopeError) return json({ error: scopeError }, { status: 403 });
  try {
    const run =
      parsed.value.sourceProvider === "github"
        ? dependencies.startOrgProfile(parsed.value.org)
        : parsed.value.sourceProvider === "gitlab"
          ? dependencies.startGitLabProfile(parsed.value.org)
          : dependencies.startBitbucketServerProfile(parsed.value.org);
    recordOperatorAuditEvent(locals, {
      action: "profile.started",
      resourceType: "profile",
      resourceId: run.id,
      metadata: { sourceProvider: parsed.value.sourceProvider },
    });
    return json(run, { status: 201 });
  } catch (error) {
    if (
      error instanceof ProfileRunCapacityError ||
      error instanceof GitLabProfileCapacityError ||
      error instanceof BitbucketProfileCapacityError
    ) {
      return json({ error: error.message }, { status: 429, headers: { "retry-after": "30" } });
    }
    if (
      error instanceof GitLabSourceConfigurationError ||
      error instanceof BitbucketServerSourceConfigurationError ||
      (error instanceof Error && /token|credential|app configured|configured/i.test(error.message))
    ) {
      return json({ error: "No source credentials configured on the server" }, { status: 400 });
    }
    console.error("[api] POST /api/profile failed", error);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};

export const GET: RequestHandler = ({ url }) => {
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
  );
  const requested = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const total = dependencies.countProfileRuns();
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requested, totalPages);
  return json({
    runs: dependencies.listProfileRuns(limit, (page - 1) * limit),
    pagination: { page, totalPages, total, limit },
  });
};
