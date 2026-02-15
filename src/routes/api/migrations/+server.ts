/** POST /api/migrations — start a new migration.
 *  GET  /api/migrations — list migrations (paginated via ?page=&limit=).
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { start, listPaginated } from "$lib/server/manager";
import { isSourceAppConfigured, isTargetAppConfigured } from "$lib/server/auth";
import type { CreateMigrationRequest } from "$lib/types";
import { DEFAULT_PAGE_SIZE } from "$lib/types";
import { parseJsonBody, validateCommonFields } from "$lib/server/validate";

export const POST: RequestHandler = async ({ request }) => {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return json({ error: parsed.error }, { status: 400 });
  }
  const body = parsed.data as CreateMigrationRequest;

  const validationError = validateCommonFields(parsed.data);
  if (validationError) {
    return json({ error: validationError }, { status: 400 });
  }

  if (!body.sourceRepo || !body.targetOrg) {
    return json(
      { error: "Missing required fields: sourceRepo, targetOrg" },
      { status: 400 },
    );
  }

  // Validate sourceRepo format.
  if (!body.sourceRepo.includes("/")) {
    return json(
      { error: 'Invalid sourceRepo format — expected "org/repo"' },
      { status: 400 },
    );
  }

  // Input length limits.
  const maxLen = 255;
  const stringFields: [string, unknown][] = [
    ["sourceRepo", body.sourceRepo],
    ["targetOrg", body.targetOrg],
    ["targetRepo", body.targetRepo],
    ["sourceApiUrl", body.sourceApiUrl],
    ["sourceToken", body.sourceToken],
    ["targetToken", body.targetToken],
    ["targetRepoVisibility", body.targetRepoVisibility],
    ["gitArchivePath", body.gitArchivePath],
    ["metadataArchivePath", body.metadataArchivePath],
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

  try {
    const migration = start(body);
    return json(migration, { status: 201 });
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
  return json(listPaginated({ page, limit }));
};
