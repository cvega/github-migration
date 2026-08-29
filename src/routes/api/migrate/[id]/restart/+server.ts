import { json } from "@sveltejs/kit";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { restart } from "$lib/server/migrate/manager";
import { restartMigrationSchema, validateBody } from "$lib/server/migrate/schemas";
import { parseAuthenticatedBody } from "$lib/server/validate";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const parsed = await parseAuthenticatedBody(request, (data) =>
    validateBody(restartMigrationSchema, data),
  );
  if ("errorResponse" in parsed) return parsed.errorResponse;
  try {
    const migration = restart(params.id, parsed.body);
    recordOperatorAuditEvent(locals, {
      action: "migration.restarted",
      resourceType: "migration",
      resourceId: migration.id,
    });
    return json(migration);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) return json({ error: message }, { status: 404 });
    if (message.startsWith("Cannot restart")) return json({ error: message }, { status: 409 });
    console.error(`[api] Failed to restart migration ${params.id}:`, error);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};
