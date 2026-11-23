import { describe, expect, test } from "bun:test";
import type { AuthUser } from "$lib/auth-user";
import { GET } from "./+server";

type HealthHandler = (event: {
  locals: { authEnabled: boolean; user?: AuthUser };
}) => Promise<Response>;
const health = GET as unknown as HealthHandler;

function event(user?: AuthUser) {
  return { locals: { authEnabled: true, user } };
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

  test.each(["operator", "admin"] as const)("limits auth details by role: %s", async (role) => {
    const body = await bodyOf(
      await health(
        event({
          id: "user-1",
          username: "operator",
          displayName: null,
          role,
          isActive: true,
          mustChangePassword: false,
        }),
      ),
    );
    expect(body.auth !== undefined).toBe(role === "admin");
  });
});
