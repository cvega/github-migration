/** POST /api/migrations — start a new migration.
 *  GET  /api/migrations — list migrations (paginated via ?page=&limit=).
 */
import { json } from "@sveltejs/kit";
import { listPaginated, searchPaginated, start } from "$lib/server/manager";
import {
  narrowBody,
  parseJsonBody,
  validateAuthAvailable,
  validateCommonFields,
  validateFieldLengths,
} from "$lib/server/validate";
import type { CreateMigrationRequest } from "$lib/types";
import { parsePaginationParams } from "$lib/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return json({ error: parsed.error }, { status: 400 });
  }
  const body = narrowBody<CreateMigrationRequest>(parsed.data);

  const validationError = validateCommonFields(parsed.data);
  if (validationError) {
    return json({ error: validationError }, { status: 400 });
  }

  if (!body.sourceRepo || !body.targetOrg) {
    return json({ error: "Missing required fields: sourceRepo, targetOrg" }, { status: 400 });
  }

  // Validate sourceRepo format.
  if (!body.sourceRepo.includes("/")) {
    return json({ error: 'Invalid sourceRepo format — expected "org/repo"' }, { status: 400 });
  }

  const lengthError = validateFieldLengths([
    ["sourceRepo", body.sourceRepo],
    ["targetOrg", body.targetOrg],
    ["targetRepo", body.targetRepo],
    ["sourceApiUrl", body.sourceApiUrl],
    ["sourceToken", body.sourceToken],
    ["targetToken", body.targetToken],
    ["targetRepoVisibility", body.targetRepoVisibility],
    ["gitArchivePath", body.gitArchivePath],
    ["metadataArchivePath", body.metadataArchivePath],
  ]);
  if (lengthError) {
    return json({ error: lengthError }, { status: 400 });
  }

  const authError = validateAuthAvailable(body);
  if (authError) {
    return json({ error: authError }, { status: 400 });
  }

  try {
    const migration = start(body);
    return json(migration, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, { status: 429 });
  }
};

export const GET: RequestHandler = async ({ url }) => {
  const { page, limit } = parsePaginationParams(url.searchParams);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  if (q) {
    return json(searchPaginated({ q, page, limit }));
  }
  return json(listPaginated({ page, limit }));
};
