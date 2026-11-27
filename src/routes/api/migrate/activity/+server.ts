import { json } from "@sveltejs/kit";
import { requireAdminIfAuthEnabled } from "$lib/server/core/auth/authorization";
import { recentActivity } from "$lib/server/migrate/manager";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ url, locals }) => {
  requireAdminIfAuthEnabled(locals);
  const limit = Math.min(
    50,
    Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20),
  );
  return json({ items: recentActivity(limit) });
};
