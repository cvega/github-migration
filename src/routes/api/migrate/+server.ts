import { json } from "@sveltejs/kit";
import { parsePaginationParams } from "$lib/migrate/types";
import { listPaginated, searchPaginated, start } from "$lib/server/migrate/manager";
import { createMigrationSchema, validateBody } from "$lib/server/migrate/schemas";
import { parseAuthenticatedBody } from "$lib/server/validate";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const parsed = await parseAuthenticatedBody(request, (data) =>
    validateBody(createMigrationSchema, data),
  );
  if ("errorResponse" in parsed) return parsed.errorResponse;
  try {
    return json(start(parsed.body), { status: 201 });
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
