/** POST /api/migrations/[id]/restart — restart a failed or cancelled migration. */
import { json } from "@sveltejs/kit";
import { isSourceAuthAvailable, isTargetAuthAvailable } from "$lib/server/auth";
import { restart } from "$lib/server/manager";
import { narrowBody, parseJsonBody, validateCommonFields } from "$lib/server/validate";
import type { RestartMigrationRequest } from "$lib/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return json({ error: parsed.error }, { status: 400 });
  }
  const body = narrowBody<RestartMigrationRequest>(parsed.data);

  // Validate boolean and app-auth fields.
  const validationError = validateCommonFields(parsed.data);
  if (validationError) {
    return json({ error: validationError }, { status: 400 });
  }

  // Auth check: need at least one auth method per side.
  if (!body.sourceToken && !body.sourceApp && !isSourceAuthAvailable()) {
    return json(
      {
        error:
          "Missing source auth — provide a PAT, app credentials, or configure auth via env vars",
      },
      { status: 400 },
    );
  }
  if (!body.targetToken && !body.targetApp && !isTargetAuthAvailable()) {
    return json(
      {
        error:
          "Missing target auth — provide a PAT, app credentials, or configure auth via env vars",
      },
      { status: 400 },
    );
  }

  try {
    const migration = restart(params.id, body);
    return json(migration);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("not found")
      ? 404
      : message.includes("Cannot restart")
        ? 409
        : 500;
    return json({ error: message }, { status });
  }
};
