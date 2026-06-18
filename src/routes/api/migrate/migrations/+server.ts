/** POST /api/migrate/migrations — start a new migration.
 *  GET  /api/migrate/migrations — list migrations (paginated via ?page=&limit=).
 */
import { json } from "@sveltejs/kit";
import { parseAuthenticatedBody } from "$lib/server/core/validate";
import { listPaginated, searchPaginated, start } from "$lib/server/migrate/manager";
import { createMigrationSchema, validateBody } from "$lib/server/migrate/schemas";
import { parsePaginationParams } from "$lib/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const parsed = await parseAuthenticatedBody(request, (d) =>
    validateBody(createMigrationSchema, d),
  );
  if ("errorResponse" in parsed) return parsed.errorResponse;

  try {
    const migration = start(parsed.body);
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
