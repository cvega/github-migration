import { json } from "@sveltejs/kit";
import { restart } from "$lib/server/migrate/manager";
import { restartMigrationSchema, validateBody } from "$lib/server/migrate/schemas";
import { parseAuthenticatedBody } from "$lib/server/validate";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  const parsed = await parseAuthenticatedBody(request, (data) =>
    validateBody(restartMigrationSchema, data),
  );
  if ("errorResponse" in parsed) return parsed.errorResponse;
  try {
    return json(restart(params.id, parsed.body));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) return json({ error: message }, { status: 404 });
    if (message.startsWith("Cannot restart")) return json({ error: message }, { status: 409 });
    console.error(`[api] Failed to restart migration ${params.id}:`, error);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};
