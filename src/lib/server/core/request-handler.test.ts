import { describe, expect, test } from "bun:test";
import type { Handle } from "@sveltejs/kit";
import { createRequestHandler } from "./request-handler";

type HandleInput = Parameters<Handle>[0];

function inputFor(
  path: string,
  options: {
    cookie?: string;
    acceptEncoding?: string;
    contentType?: string;
    method?: string;
    origin?: string;
  } = {},
): { input: HandleInput; locals: App.Locals; resolved: () => number } {
  let resolveCalls = 0;
  const locals = {} as App.Locals;
  const request = new Request(`http://localhost${path}`, {
    method: options.method,
    headers: {
      ...(options.acceptEncoding ? { "accept-encoding": options.acceptEncoding } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    },
  });
  const event = {
    url: new URL(request.url),
    request,
    locals,
    cookies: {
      get: () => options.cookie,
    },
  } as unknown as HandleInput["event"];
  const resolve = (async () => {
    resolveCalls += 1;
    return new Response("response body", {
      headers: { "content-type": options.contentType ?? "text/html" },
    });
  }) as HandleInput["resolve"];

  return { input: { event, resolve }, locals, resolved: () => resolveCalls };
}

function handler(authEnabled = true): Handle {
  return createRequestHandler({
    authEnabled,
    sessionCookie: "session",
    isValidSession: (token) => token === "valid",
  });
}

describe("request authentication hook", () => {
  test.each(["/login", "/logout", "/api/health", "/api/ready"])(
    "allows public path %s without a session and applies security headers",
    async (path) => {
      const fixture = inputFor(path);
      const response = await handler()(fixture.input);

      expect(response.status).toBe(200);
      expect(fixture.resolved()).toBe(1);
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(fixture.locals.authEnabled).toBe(true);
    },
  );

  test.each(["POST", "PUT", "PATCH", "DELETE"])(
    "rejects authenticated cross-origin %s API mutations",
    async (method) => {
      const fixture = inputFor("/api/migrate/migrations", {
        cookie: "valid",
        method,
        origin: "https://attacker.example",
      });
      const response = await handler()(fixture.input);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Cross-origin API requests are forbidden" });
      expect(fixture.resolved()).toBe(0);
    },
  );

  test("allows an authenticated same-origin API mutation", async () => {
    const fixture = inputFor("/api/migrate/migrations", {
      cookie: "valid",
      method: "POST",
      origin: "http://localhost",
    });
    const response = await handler()(fixture.input);

    expect(response.status).toBe(200);
    expect(fixture.resolved()).toBe(1);
  });

  test("returns a secured JSON 401 for an API request without a valid session", async () => {
    const fixture = inputFor("/api/migrate/migrations", { cookie: "invalid" });
    const response = await handler()(fixture.input);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fixture.resolved()).toBe(0);
  });

  test("redirects a protected page request without a session", async () => {
    const fixture = inputFor("/migrate");
    await expect(handler()(fixture.input)).rejects.toMatchObject({
      status: 302,
      location: "/login",
    });
    expect(fixture.resolved()).toBe(0);
  });

  test("resolves a protected request with a valid session", async () => {
    const fixture = inputFor("/migrate", { cookie: "valid" });
    const response = await handler()(fixture.input);

    expect(response.status).toBe(200);
    expect(fixture.resolved()).toBe(1);
  });

  test("allows API clients that do not send an Origin header", async () => {
    const fixture = inputFor("/api/migrate/migrations", {
      cookie: "valid",
      method: "POST",
    });

    const response = await handler()(fixture.input);

    expect(response.status).toBe(200);
    expect(fixture.resolved()).toBe(1);
  });

  test("bypasses session checks when authentication is disabled", async () => {
    const fixture = inputFor("/migrate", { cookie: "invalid" });
    const response = await handler(false)(fixture.input);

    expect(response.status).toBe(200);
    expect(fixture.locals.authEnabled).toBe(false);
  });

  test("compresses eligible responses when gzip is accepted", async () => {
    const fixture = inputFor("/login", {
      acceptEncoding: "gzip, deflate",
      contentType: "application/json",
    });
    const response = await handler()(fixture.input);

    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    const decoded = await new Response(
      response.body?.pipeThrough(new DecompressionStream("gzip")),
    ).text();
    expect(decoded).toBe("response body");
  });

  test("does not gzip when the client explicitly rejects it", async () => {
    const fixture = inputFor("/login", {
      acceptEncoding: "br, gzip;q=0, *;q=1",
      contentType: "application/json",
    });
    const response = await handler()(fixture.input);

    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(await response.text()).toBe("response body");
  });

  test("accepts gzip case-insensitively through a positive wildcard", async () => {
    const fixture = inputFor("/login", {
      acceptEncoding: "br;q=0.5, *;Q=0.25",
      contentType: "text/html",
    });
    const response = await handler()(fixture.input);

    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
  });
});
