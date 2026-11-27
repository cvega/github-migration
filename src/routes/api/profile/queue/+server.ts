import { json } from "@sveltejs/kit";
import { enterpriseNamespaces } from "$lib/server/application/adapters/namespace-discovery";
import { parseJsonBody } from "$lib/server/application/request-body";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { requireAdminIfAuthEnabled } from "$lib/server/core/auth/authorization";
import { enqueueProfiles, profileQueueStatus } from "$lib/server/profile/database/queue";
import { getSourceProviderAdapter, isSourceProvider } from "$lib/source-provider";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ url, locals }) => {
  requireAdminIfAuthEnabled(locals);
  const provider = url.searchParams.get("provider");
  if (!isSourceProvider(provider)) return json({ error: "Invalid provider" }, { status: 400 });
  return json(profileQueueStatus(provider), { headers: { "cache-control": "no-store" } });
};
export const POST: RequestHandler = async ({ request, locals }) => {
  requireAdminIfAuthEnabled(locals);
  const body = await parseJsonBody(request);
  if ("error" in body) return json({ error: body.error }, { status: body.status });
  const { sourceProvider, scope, enterprise } = body.data;
  if (!isSourceProvider(sourceProvider) || scope !== "enterprise")
    return json({ error: "Choose an enterprise source." }, { status: 400 });
  if (
    sourceProvider === "github" &&
    (typeof enterprise !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(enterprise))
  )
    return json({ error: "Enter the GitHub enterprise slug." }, { status: 400 });
  let keys: string[];
  if (
    sourceProvider === "gitlab" &&
    enterprise !== undefined &&
    enterprise !== "" &&
    (typeof enterprise !== "string" ||
      !getSourceProviderAdapter("gitlab").isValidNamespace(enterprise))
  ) {
    return json({ error: "Enter a valid GitLab group path." }, { status: 400 });
  }
  try {
    keys = await enterpriseNamespaces(
      sourceProvider,
      request.signal,
      typeof enterprise === "string" ? enterprise : "",
    );
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
    console.warn(`[profile queue] ${sourceProvider} discovery failed (${status ?? "unknown"})`);
    return json(
      {
        error:
          status === 401
            ? "Source credentials were rejected. No profiles queued."
            : status === 403
              ? "Access to this enterprise was denied. No profiles queued."
              : "Enterprise discovery did not finish. Check the source, credentials and enterprise scope. No profiles queued.",
      },
      { status: 502 },
    );
  }
  const added = enqueueProfiles(sourceProvider, keys);
  recordOperatorAuditEvent(locals, {
    action: "profile.queued",
    resourceType: "profile",
    resourceId: sourceProvider,
    metadata: { added },
  });
  return json({ added, discovered: keys.length }, { status: 202 });
};
