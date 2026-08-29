import { json } from "@sveltejs/kit";
import { confirmRestart } from "$lib/server/migrate/manager";
import { confirmRestartSchema, validateBody } from "$lib/server/migrate/schemas";
import { parseJsonBody } from "$lib/server/validate";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) return json({ error: parsed.error }, { status: parsed.status });
  const validated = validateBody(confirmRestartSchema, parsed.data);
  if (!validated.ok) return json({ error: validated.error }, { status: 400 });
  try {
    return json(confirmRestart(params.id, validated.value.confirmation));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) return json({ error: message }, { status: 404 });
    return json({ error: message }, { status: 409 });
  }
};
