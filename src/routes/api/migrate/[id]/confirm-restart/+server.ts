import { json } from "@sveltejs/kit";
import { isPausedPersistedRoute } from "$lib/migration-target";
import { parseJsonBody } from "$lib/server/application/request-body";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { requireAdminIfAuthEnabled } from "$lib/server/core/auth/authorization";
import { safeErrorReason } from "$lib/server/core/safe-error";
import { confirmRestart, MigrationRestartConflict } from "$lib/server/migrate/manager";
import { confirmRestartSchema, validateBody } from "$lib/server/migrate/schemas";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  requireAdminIfAuthEnabled(locals);
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) return json({ error: parsed.error }, { status: parsed.status });
  const validated = validateBody(confirmRestartSchema, parsed.data);
  if (!validated.ok) return json({ error: validated.error }, { status: 400 });
  try {
    const migration = confirmRestart(params.id, validated.value.confirmation);
    recordOperatorAuditEvent(locals, {
      action: isPausedPersistedRoute(migration)
        ? "migration.ghes_hold_released"
        : "migration.restart_confirmed",
      resourceType: "migration",
      resourceId: migration.id,
    });
    return json(migration);
  } catch (error) {
    if (error instanceof Error && error.message === "Migration not found") {
      return json({ error: "Migration not found" }, { status: 404 });
    }
    if (error instanceof MigrationRestartConflict)
      return json({ error: error.message }, { status: 409 });
    return json(
      { error: safeErrorReason(error, "Migration restart confirmation failed") },
      { status: 500 },
    );
  }
};
