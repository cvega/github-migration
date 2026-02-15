/** POST /api/batches — start a batch migration.
 *  GET  /api/batches — list batches (paginated via ?page=&limit=).
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { startBatch, listBatchesPaginated } from "$lib/server/manager";
import { isSourceAppConfigured, isTargetAppConfigured } from "$lib/server/auth";
import type { BatchMigrationRequest } from "$lib/types";
import { DEFAULT_PAGE_SIZE } from "$lib/types";
import { parseJsonBody, validateCommonFields } from "$lib/server/validate";

export const POST: RequestHandler = async ({ request }) => {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return json({ error: parsed.error }, { status: 400 });
  }
  const body = parsed.data as BatchMigrationRequest;

  const validationError = validateCommonFields(parsed.data);
  if (validationError) {
    return json({ error: validationError }, { status: 400 });
  }

  if (!body.repos || !Array.isArray(body.repos) || body.repos.length === 0) {
    return json(
      { error: "Missing required field: repos (array of org/repo strings)" },
      { status: 400 },
    );
  }
  if (!body.targetOrg) {
    return json(
      { error: "Missing required field: targetOrg" },
      { status: 400 },
    );
  }

  // Input length / size limits.
  const maxLen = 255;
  const maxRepos = 500;
  if (body.repos.length > maxRepos) {
    return json(
      {
        error: `Too many repos: ${body.repos.length} exceeds maximum of ${maxRepos}`,
      },
      { status: 400 },
    );
  }
  const stringFields: [string, unknown][] = [
    ["targetOrg", body.targetOrg],
    ["sourceApiUrl", body.sourceApiUrl],
    ["sourceToken", body.sourceToken],
    ["targetToken", body.targetToken],
    ["targetRepoVisibility", body.targetRepoVisibility],
  ];
  for (const [name, val] of stringFields) {
    if (typeof val === "string" && val.length > maxLen) {
      return json(
        {
          error: `Field "${name}" exceeds maximum length of ${maxLen} characters`,
        },
        { status: 400 },
      );
    }
  }
  const oversizedRepo = body.repos.find((r) => r.length > maxLen);
  if (oversizedRepo) {
    return json(
      {
        error: `Repo entry exceeds maximum length of ${maxLen} characters: "${oversizedRepo.slice(0, 50)}..."`,
      },
      { status: 400 },
    );
  }

  if (!body.sourceToken && !body.sourceApp && !isSourceAppConfigured()) {
    return json(
      {
        error:
          "Missing source auth — provide a PAT, app credentials, or configure a source GitHub App via env vars",
      },
      { status: 400 },
    );
  }
  if (!body.targetToken && !body.targetApp && !isTargetAppConfigured()) {
    return json(
      {
        error:
          "Missing target auth — provide a PAT, app credentials, or configure a target GitHub App via env vars",
      },
      { status: 400 },
    );
  }

  // Validate repo format.
  const invalidRepos = body.repos.filter(
    (r) => r.trim() && !r.trim().includes("/"),
  );
  if (invalidRepos.length > 0) {
    return json(
      {
        error: `Invalid repo format (expected org/repo): ${invalidRepos.join(", ")}`,
      },
      { status: 400 },
    );
  }

  try {
    const batch = startBatch(body);
    return json(batch, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, { status: 429 });
  }
};

export const GET: RequestHandler = async ({ url }) => {
  const page = Math.max(
    1,
    parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
  );
  const limit = Math.min(
    100,
    Math.max(
      1,
      parseInt(
        url.searchParams.get("limit") ?? String(DEFAULT_PAGE_SIZE),
        10,
      ) || DEFAULT_PAGE_SIZE,
    ),
  );
  return json(listBatchesPaginated({ page, limit }));
};
