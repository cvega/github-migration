import { json } from "@sveltejs/kit";
import { parseAuthenticatedBody } from "$lib/server/application/migration-policy";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { getBatch, restartBatch } from "$lib/server/migrate/manager";
import { restartMigrationSchema, validateBody } from "$lib/server/migrate/schemas";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!getBatch(params.id)) return json({ error: "Batch not found" }, { status: 404 });
  const parsed = await parseAuthenticatedBody(request, (data) =>
    validateBody(restartMigrationSchema, data),
  );
  if ("errorResponse" in parsed) return parsed.errorResponse;
  const result = restartBatch(params.id, parsed.body);
  recordOperatorAuditEvent(locals, {
    action: "batch.restarted",
    resourceType: "batch",
    resourceId: params.id,
    metadata: { restartedCount: result.restarted },
  });
  return json(result);
};
