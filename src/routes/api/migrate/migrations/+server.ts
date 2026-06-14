/** POST /api/migrate/migrations — start a new migration.
 *  GET  /api/migrate/migrations — list migrations (paginated via ?page=&limit=).
 */
import { json } from "@sveltejs/kit";
import { listPaginated, searchPaginated, start } from "$lib/server/manager";
import { createMigrationSchema, validateBody } from "$lib/server/schemas";
import { parseJsonBody, validateAuthAvailable } from "$lib/server/validate";
import { parsePaginationParams } from "$lib/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return json({ error: parsed.error }, { status: 400 });
  }

  const result = validateBody(createMigrationSchema, parsed.data);
  if (!result.ok) {
    return json({ error: result.error }, { status: 400 });
  }
  const body = result.value;

  const authError = validateAuthAvailable(body);
  if (authError) {
    return json({ error: authError }, { status: 400 });
  }

  try {
    const migration = start(body);
    return json(migration, { status: 201 });
  } catch (err) {
    // Capacity is no longer an error — over-cap migrations queue automatically.
    // A throw here is an unexpected internal failure: log the detail server-side
    // and return a generic message so internals (paths, driver errors) don't leak.
    console.error("[api] POST /api/migrate/migrations failed:", err);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};

export const GET: RequestHandler = async ({ url }) => {
  const { page, limit } = parsePaginationParams(url.searchParams);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  if (q) {
    return json(searchPaginated({ q, page, limit }));
  }
  return json(listPaginated({ page, limit }));
};
