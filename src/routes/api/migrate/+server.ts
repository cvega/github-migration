import { json } from "@sveltejs/kit";
import { parsePaginationParams } from "$lib/migrate/types";
import { parseAuthenticatedBody } from "$lib/server/application/migration-policy";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { requireAdminIfAuthEnabled } from "$lib/server/core/auth/authorization";
import { safeErrorReason } from "$lib/server/core/safe-error";
import { listPaginated, searchPaginated, start } from "$lib/server/migrate/manager";
import { createMigrationSchema, validateBody } from "$lib/server/migrate/schemas";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, request }) => {
  requireAdminIfAuthEnabled(locals);
  const parsed = await parseAuthenticatedBody(
    request,
    (data) => validateBody(createMigrationSchema, data),
    { locals, resourceType: "migration" },
  );
  if ("errorResponse" in parsed) return parsed.errorResponse;
  try {
    const migration = start(parsed.body);
    recordOperatorAuditEvent(locals, {
      action: "migration.started",
      resourceType: "migration",
      resourceId: migration.id,
    });
    return json(migration, { status: 201 });
  } catch (error) {
    console.error("[api] POST /api/migrate failed:", safeErrorReason(error));
    return json({ error: "Internal server error" }, { status: 500 });
  }
};

export const GET: RequestHandler = ({ url, locals }) => {
  requireAdminIfAuthEnabled(locals);
  const pagination = parsePaginationParams(url.searchParams);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  return json(query ? searchPaginated({ ...pagination, q: query }) : listPaginated(pagination));
};
