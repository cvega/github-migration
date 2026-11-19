import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "node:process";
import { getMigrationMetrics } from "$lib/server/migrate/database/metrics";
import type { RequestHandler } from "./$types";

const noStore = { "Cache-Control": "no-store" };

export const GET: RequestHandler = ({ request }) => {
  const token = env.GH_MIGRATE_METRICS_TOKEN;
  if (!token) return new Response("Not found\n", { status: 404, headers: noStore });
  if (/\s/u.test(token)) {
    console.error("[metrics] GH_MIGRATE_METRICS_TOKEN must not contain whitespace");
    return new Response("Metrics configuration error\n", { status: 503, headers: noStore });
  }

  const supplied = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (!supplied || !timingSafeEqual(hash(supplied), hash(token))) {
    return new Response("Unauthorized\n", {
      status: 401,
      headers: { ...noStore, "WWW-Authenticate": "Bearer" },
    });
  }

  return new Response(getMigrationMetrics(), {
    headers: {
      ...noStore,
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    },
  });
};
