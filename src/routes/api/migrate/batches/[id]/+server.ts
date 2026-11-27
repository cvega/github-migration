import { json } from "@sveltejs/kit";
import { parsePaginationParams } from "$lib/migrate/types";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { requireAdminIfAuthEnabled } from "$lib/server/core/auth/authorization";
import { cancelBatch, getBatch, getBatchPaginated } from "$lib/server/migrate/manager";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params, url, locals }) => {
  requireAdminIfAuthEnabled(locals);
  const batch = getBatchPaginated(params.id, parsePaginationParams(url.searchParams));
  return batch ? json(batch) : json({ error: "Batch not found" }, { status: 404 });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
  requireAdminIfAuthEnabled(locals);
  if (!getBatch(params.id)) return json({ error: "Batch not found" }, { status: 404 });
  const cancelledCount = cancelBatch(params.id);
  recordOperatorAuditEvent(locals, {
    action: "batch.cancelled",
    resourceType: "batch",
    resourceId: params.id,
    metadata: { cancelledCount },
  });
  return json({ cancelledCount });
};
