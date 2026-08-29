import { describe, expect, test } from "bun:test";
import { createSessionToken, SESSION_COOKIE } from "$lib/server/core/session";
import { GET } from "./+server";

type HealthHandler = (event: {
  cookies: { get(name: string): string | undefined };
}) => Promise<Response>;
const health = GET as unknown as HealthHandler;

function event(sessionCookie?: string) {
  return {
    cookies: { get: (name: string) => (name === SESSION_COOKIE ? sessionCookie : undefined) },
  };
}

async function bodyOf(response: Response) {
  return (await response.json()) as { status: string; timestamp: string; auth?: unknown };
}

describe("GET /api/health", () => {
  test("always reports liveness", async () => {
    const response = await health(event());
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("string");
  });

  test("omits auth details for an unauthenticated caller", async () => {
    const body = await bodyOf(await health(event()));
    expect(body.auth).toBeUndefined();
  });

  test("ignores an invalid session cookie", async () => {
    const body = await bodyOf(await health(event("not.a.valid.token")));
    expect(body.auth).toBeUndefined();
  });

  test("includes auth details for an authenticated operator", async () => {
    const body = await bodyOf(await health(event(createSessionToken())));
    expect(body.auth).toBeDefined();
  });
});
