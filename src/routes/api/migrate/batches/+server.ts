import { json } from "@sveltejs/kit";
import { parsePaginationParams } from "$lib/migrate/types";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { listBatchesPaginated, startBatch } from "$lib/server/migrate/manager";
import { batchMigrationSchema, validateBody } from "$lib/server/migrate/schemas";
import { findMissingProfileProjectPaths } from "$lib/server/profile/database/repos";
import { getProfileRun } from "$lib/server/profile/database/runs";
import { parseJsonBody, validateAuthAvailable } from "$lib/server/validate";
import type { RequestHandler } from "./$types";

const defaults = { findMissingProfileProjectPaths, getProfileRun };
let dependencies = { ...defaults };
export function __setBatchRouteDependenciesForTests(
  overrides: Partial<typeof defaults>,
): () => void {
  dependencies = { ...defaults, ...overrides };
  return () => {
    dependencies = { ...defaults };
  };
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) return json({ error: parsed.error }, { status: parsed.status });
  const validated = validateBody(batchMigrationSchema, parsed.data);
  if (!validated.ok) return json({ error: validated.error }, { status: 400 });
  let body = validated.value;
  if (body.profileRunId) {
    const run = dependencies.getProfileRun(body.profileRunId);
    if (run?.state !== "completed")
      return json({ error: "Profile run is not completed" }, { status: 400 });
    if (body.sourceProvider && body.sourceProvider !== run.sourceProvider)
      return json({ error: "Batch provider does not match the profile run" }, { status: 400 });
    if (body.sourceApiUrl && body.sourceApiUrl !== run.sourceApiUrl)
      return json(
        { error: "Batch source API URL does not match the profile run" },
        { status: 400 },
      );
    const sourceRepos = body.items?.map((item) => item.sourceRepo) ?? body.repos ?? [];
    const missing = dependencies.findMissingProfileProjectPaths(run.id, sourceRepos);
    if (missing.length > 0)
      return json(
        { error: `Repository '${missing[0]}' is not part of the profile run` },
        { status: 400 },
      );
    body = { ...body, sourceProvider: run.sourceProvider, sourceApiUrl: run.sourceApiUrl };
  }
  const authError = validateAuthAvailable(body);
  if (authError) return json({ error: authError }, { status: 400 });
  try {
    const batch = startBatch(body);
    recordOperatorAuditEvent(locals, {
      action: "batch.started",
      resourceType: "batch",
      resourceId: batch.id,
    });
    return json(batch, { status: 201 });
  } catch (error) {
    console.error("[api] POST /api/migrate/batches failed:", error);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};

export const GET: RequestHandler = ({ url }) =>
  json(listBatchesPaginated(parsePaginationParams(url.searchParams)));
