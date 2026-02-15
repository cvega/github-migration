/** GET /api/health — health check endpoint. */
import { json } from "@sveltejs/kit";
import { getAuthConfig } from "$lib/server/auth";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const auth = getAuthConfig();
  return json({
    status: "ok",
    timestamp: new Date().toISOString(),
    auth: {
      source: {
        mode: auth.source.mode,
        rateLimit: auth.source.rateLimit,
        appId: auth.source.appId ?? null,
      },
      target: {
        mode: auth.target.mode,
        rateLimit: auth.target.rateLimit,
        appId: auth.target.appId ?? null,
      },
    },
  });
};
