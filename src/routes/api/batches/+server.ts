/** POST /api/batches — start a batch migration.
 *  GET  /api/batches — list batches (paginated via ?page=&limit=).
 */
import { json } from "@sveltejs/kit";
import { listBatchesPaginated, startBatch } from "$lib/server/manager";
import {
  MAX_FIELD_LEN,
  narrowBody,
  parseJsonBody,
  validateAuthAvailable,
  validateCommonFields,
  validateFieldLengths,
} from "$lib/server/validate";
import type { BatchMigrationRequest } from "$lib/types";
import { parsePaginationParams } from "$lib/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return json({ error: parsed.error }, { status: 400 });
  }
  const body = narrowBody<BatchMigrationRequest>(parsed.data);

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
    return json({ error: "Missing required field: targetOrg" }, { status: 400 });
  }

  // Batch size limit.
  const maxRepos = 500;
  if (body.repos.length > maxRepos) {
    return json(
      {
        error: `Too many repos: ${body.repos.length} exceeds maximum of ${maxRepos}`,
      },
      { status: 400 },
    );
  }

  const lengthError = validateFieldLengths([
    ["targetOrg", body.targetOrg],
    ["sourceApiUrl", body.sourceApiUrl],
    ["sourceToken", body.sourceToken],
    ["targetToken", body.targetToken],
    ["targetRepoVisibility", body.targetRepoVisibility],
  ]);
  if (lengthError) {
    return json({ error: lengthError }, { status: 400 });
  }
  const oversizedRepo = body.repos.find((r) => r.length > MAX_FIELD_LEN);
  if (oversizedRepo) {
    return json(
      {
        error: `Repo entry exceeds maximum length of ${MAX_FIELD_LEN} characters: "${oversizedRepo.slice(0, 50)}..."`,
      },
      { status: 400 },
    );
  }

  const authError = validateAuthAvailable(body);
  if (authError) {
    return json({ error: authError }, { status: 400 });
  }

  // Validate repo format.
  const invalidRepos = body.repos.filter((r) => r.trim() && !r.trim().includes("/"));
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
  return json(listBatchesPaginated(parsePaginationParams(url.searchParams)));
};
