import { json } from "@sveltejs/kit";
import {
  parseValidatedBody,
  validateAuthAvailable,
} from "$lib/server/application/migration-policy";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { requireAdminIfAuthEnabled } from "$lib/server/core/auth/authorization";
import { getBatch, restartBatch } from "$lib/server/migrate/manager";
import { restartMigrationSchema, validateBody } from "$lib/server/migrate/schemas";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  requireAdminIfAuthEnabled(locals);
  if (!getBatch(params.id)) return json({ error: "Batch not found" }, { status: 404 });
  const parsed = await parseValidatedBody(request, (data) =>
    validateBody(restartMigrationSchema, data),
  );
  if ("errorResponse" in parsed) return parsed.errorResponse;
  const result = restartBatch(params.id, parsed.body, validateAuthAvailable, locals?.user?.id);
  recordOperatorAuditEvent(locals, {
    action: "batch.restarted",
    resourceType: "batch",
    resourceId: params.id,
    metadata: { restartedCount: result.restarted },
  });
  return json(result);
};
