/** GET /api/migrate/activity — recent lifecycle events across all migrations (notification feed). */

import { json } from "@sveltejs/kit";
import { recentActivity } from "$lib/server/migrate/manager";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => {
  const limit = Math.min(
    50,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20),
  );
  return json({ items: recentActivity(limit) });
};
