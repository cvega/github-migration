import { json } from "@sveltejs/kit";
import { checkStoreReady } from "$lib/server/core/db";
import type { RequestHandler } from "./$types";

export function _createReadyHandler(checkReady: () => void): RequestHandler {
  return () => {
    try {
      checkReady();
      return json({ status: "ready", timestamp: new Date().toISOString() });
    } catch (error) {
      console.error("[ready] SQLite readiness check failed", error);
      return json({ status: "unavailable", timestamp: new Date().toISOString() }, { status: 503 });
    }
  };
}

export const GET = _createReadyHandler(checkStoreReady);
