import { json } from "@sveltejs/kit";
import { getBatch, restartBatch } from "$lib/server/migrate/manager";
import { restartMigrationSchema, validateBody } from "$lib/server/migrate/schemas";
import { parseAuthenticatedBody } from "$lib/server/validate";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  if (!getBatch(params.id)) return json({ error: "Batch not found" }, { status: 404 });
  const parsed = await parseAuthenticatedBody(request, (data) =>
    validateBody(restartMigrationSchema, data),
  );
  if ("errorResponse" in parsed) return parsed.errorResponse;
  return json(restartBatch(params.id, parsed.body));
};
