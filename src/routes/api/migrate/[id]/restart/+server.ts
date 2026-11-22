import { json } from "@sveltejs/kit";
import { GITLAB_GHES_PAUSE_REASON, isPausedPersistedRoute } from "$lib/migration-target";
import {
  parseValidatedBody,
  validateAuthAvailable,
} from "$lib/server/application/migration-policy";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { get, restart } from "$lib/server/migrate/manager";
import { restartMigrationSchema, validateBody } from "$lib/server/migrate/schemas";
import { restartValidationInput } from "$lib/server/migrate/validate";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const existing = get(params.id);
  if (existing && isPausedPersistedRoute(existing)) {
    recordOperatorAuditEvent(locals, {
      action: "migration.restart_blocked",
      resourceType: "migration",
      resourceId: existing.id,
      metadata: { reason: "route-paused" },
    });
    return json({ error: GITLAB_GHES_PAUSE_REASON }, { status: 409 });
  }
  const parsed = await parseValidatedBody(request, (data) =>
    validateBody(restartMigrationSchema, data),
  );
  if ("errorResponse" in parsed) return parsed.errorResponse;
  if (!existing) return json({ error: "Migration not found" }, { status: 404 });
  const authError = validateAuthAvailable(restartValidationInput(existing, parsed.body));
  if (authError) return json({ error: authError }, { status: 400 });
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
    if (message.startsWith("Cannot restart") || message === GITLAB_GHES_PAUSE_REASON) {
      return json({ error: message }, { status: 409 });
    }
    console.error(`[api] Failed to restart migration ${params.id}:`, error);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};
