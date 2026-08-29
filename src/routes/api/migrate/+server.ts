import { json } from "@sveltejs/kit";
import { parsePaginationParams } from "$lib/migrate/types";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { listPaginated, searchPaginated, start } from "$lib/server/migrate/manager";
import { createMigrationSchema, validateBody } from "$lib/server/migrate/schemas";
import { parseAuthenticatedBody } from "$lib/server/validate";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, request }) => {
  const parsed = await parseAuthenticatedBody(request, (data) =>
    validateBody(createMigrationSchema, data),
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
    console.error("[api] POST /api/migrate failed:", error);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};

export const GET: RequestHandler = ({ url }) => {
  const pagination = parsePaginationParams(url.searchParams);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  return json(query ? searchPaginated({ ...pagination, q: query }) : listPaginated(pagination));
};
