import { redirect } from "@sveltejs/kit";
import type { Handle } from "@sveltejs/kit/hooks";
import type { AuthPrincipal } from "$lib/server/core/auth/model";

/**
 * Shared SvelteKit request policy: enforce session auth outside the explicit
 * public paths, attach browser security headers to every response, and gzip
 * HTML/JSON when the client accepts it. API auth failures remain JSON while
 * unauthenticated page requests redirect to login; SSE is never compressed by
 * this handler.
 */

interface RequestHandlerConfig {
  authEnabled: boolean;
  resolveSession: (token: string) => AuthPrincipal | null;
  sessionCookie: string;
}

const securityHeaders: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const PUBLIC_PATHS = new Set(["/login", "/logout", "/api/health", "/api/ready"]);
const METRICS_PATH = "/api/metrics";
const PASSWORD_CHANGE_PATH = "/account/password";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function applySecurityHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(securityHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

function acceptedEncodingQuality(header: string, encoding: string): number {
  let explicitQuality: number | undefined;
  let wildcardQuality: number | undefined;
  for (const item of header.split(",")) {
    const [rawCoding = "", ...parameters] = item.split(";");
    const coding = rawCoding.trim().toLowerCase();
    if (coding !== encoding && coding !== "*") continue;

    let quality = 1;
    for (const parameter of parameters) {
      const [rawName = "", rawValue = ""] = parameter.split("=", 2);
      if (rawName.trim().toLowerCase() !== "q") continue;
      const parsed = Number(rawValue.trim());
      quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
      break;
    }

    if (coding === encoding) {
      explicitQuality = Math.max(explicitQuality ?? 0, quality);
    } else {
      wildcardQuality = Math.max(wildcardQuality ?? 0, quality);
    }
  }
  return explicitQuality ?? wildcardQuality ?? 0;
}

function appendVary(response: Response, field: string): void {
  const vary = response.headers.get("vary");
  if (!vary) {
    response.headers.set("vary", field);
    return;
  }
  if (
    vary !== "*" &&
    !vary.split(",").some((value) => value.trim().toLowerCase() === field.toLowerCase())
  ) {
    response.headers.set("vary", `${vary}, ${field}`);
  }
}

export function createRequestHandler(config: RequestHandlerConfig): Handle {
  return async ({ event, resolve }) => {
    event.locals.authEnabled = config.authEnabled;

    if (config.authEnabled) {
      const isMetricsScrape =
        event.url.pathname === METRICS_PATH &&
        (event.request.method === "GET" || event.request.method === "HEAD");
      const sessionCookie = event.cookies.get(config.sessionCookie);
      const principal = sessionCookie ? config.resolveSession(sessionCookie) : null;
      if (principal) {
        event.locals.user = principal.user;
        event.locals.sessionTokenHash = principal.sessionTokenHash;
      }

      if (!principal && !PUBLIC_PATHS.has(event.url.pathname) && !isMetricsScrape) {
        if (event.url.pathname.startsWith("/api/")) {
          return applySecurityHeaders(
            new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        redirect(302, "/login");
      }

      if (
        principal?.user.mustChangePassword &&
        event.url.pathname !== PASSWORD_CHANGE_PATH &&
        !PUBLIC_PATHS.has(event.url.pathname) &&
        !isMetricsScrape
      ) {
        if (event.url.pathname.startsWith("/api/")) {
          return applySecurityHeaders(
            new Response(JSON.stringify({ error: "Password change required" }), {
              status: 403,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        redirect(302, PASSWORD_CHANGE_PATH);
      }
    }

    const requestOrigin = event.request.headers.get("origin");
    if (
      event.url.pathname.startsWith("/api/") &&
      UNSAFE_METHODS.has(event.request.method) &&
      requestOrigin !== null &&
      requestOrigin !== event.url.origin
    ) {
      return applySecurityHeaders(
        new Response(JSON.stringify({ error: "Cross-origin API requests are forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    const response = applySecurityHeaders(await resolve(event));
    const contentType = response.headers.get("content-type") || "";
    const acceptEncoding = event.request.headers.get("accept-encoding") || "";
    const isCompressible =
      contentType.includes("text/html") || contentType.includes("application/json");

    if (isCompressible) appendVary(response, "Accept-Encoding");

    if (
      isCompressible &&
      acceptedEncodingQuality(acceptEncoding, "gzip") > 0 &&
      !response.headers.has("content-encoding") &&
      response.body
    ) {
      const headers = new Headers(response.headers);
      headers.set("content-encoding", "gzip");
      headers.delete("content-length");
      return new Response(response.body.pipeThrough(new CompressionStream("gzip")), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return response;
  };
}
