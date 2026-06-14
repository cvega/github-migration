/**
 * The health endpoint is a public liveness probe (reachable without a session),
 * but it must not disclose the auth configuration to unauthenticated callers.
 * The test-setup preload sets GH_MIGRATE_USER/PASS, so `authEnabled` is true
 * here — letting us exercise both the authenticated and anonymous branches.
 */
import { describe, expect, test } from "bun:test";
import { createSessionToken, SESSION_COOKIE } from "$lib/server/session";
import { GET } from "./+server";

// The handler reads only `cookies.get` off its event; this minimal shape drives
// it without fabricating SvelteKit's full RequestEvent (test-only cast).
type HealthHandler = (event: {
  cookies: { get(name: string): string | undefined };
}) => Promise<Response>;
const health = GET as unknown as HealthHandler;

function event(sessionCookie?: string) {
  return {
    cookies: { get: (name: string) => (name === SESSION_COOKIE ? sessionCookie : undefined) },
  };
}

async function bodyOf(res: Response) {
  return (await res.json()) as { status: string; timestamp: string; auth?: unknown };
}

describe("GET /api/health", () => {
  test("always reports liveness (200, status ok, timestamp)", async () => {
    const res = await health(event());
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("string");
  });

  test("omits the auth block for an unauthenticated caller", async () => {
    const body = await bodyOf(await health(event()));
    expect(body.auth).toBeUndefined();
  });

  test("ignores an invalid session cookie (still no auth block)", async () => {
    const body = await bodyOf(await health(event("not.a.valid.token")));
    expect(body.auth).toBeUndefined();
  });

  test("includes the auth block for an authenticated operator", async () => {
    const body = await bodyOf(await health(event(createSessionToken())));
    expect(body.auth).toBeDefined();
  });
});
