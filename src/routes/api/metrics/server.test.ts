import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { GET } from "./+server";

const originalToken = process.env.GH_MIGRATE_METRICS_TOKEN;
const scrape = GET as (event: Parameters<typeof GET>[0]) => Response;

function request(authorization?: string): Response {
  return scrape({
    request: new Request("http://localhost/api/metrics", {
      headers: authorization ? { authorization } : {},
    }),
  } as Parameters<typeof GET>[0]);
}

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(() => {
  if (originalToken === undefined) delete process.env.GH_MIGRATE_METRICS_TOKEN;
  else process.env.GH_MIGRATE_METRICS_TOKEN = originalToken;
  closeStore();
});

describe("GET /api/metrics", () => {
  test("is disabled when no token is configured", () => {
    delete process.env.GH_MIGRATE_METRICS_TOKEN;
    expect(request().status).toBe(404);
  });

  test("requires the configured bearer token and responds in Prometheus text format", async () => {
    process.env.GH_MIGRATE_METRICS_TOKEN = "test-metrics-token";
    for (const authorization of [undefined, "Bearer wrong", "Basic dGVzdA=="]) {
      const response = request(authorization);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const response = request("Bearer test-metrics-token");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("# TYPE gh_migrate_migrations gauge\n");
  });

  test("reports an invalid token configuration", () => {
    process.env.GH_MIGRATE_METRICS_TOKEN = "invalid token";
    expect(request("Bearer invalid").status).toBe(503);
  });
});
