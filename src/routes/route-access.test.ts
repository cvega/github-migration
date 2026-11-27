import { expect, spyOn, test } from "bun:test";
import { isActionFailure, isHttpError } from "@sveltejs/kit";
import type { Handle } from "@sveltejs/kit/hooks";
import type { AuthPrincipal } from "$lib/server/core/auth/model";
import * as store from "$lib/server/core/db";
import { createRequestHandler } from "$lib/server/core/request-handler";

type Access = "admin" | "operator" | "public" | "session" | "bearer";

// Classify each entry point independently, including actions on shared pages.
const routes: Record<string, Record<string, Access>> = {
  "+layout.server.ts": { load: "operator" },
  "+page.server.ts": { load: "operator" },
  "account/password/+page.server.ts": { load: "session", actions: "session" },
  "admin/audit/+page.server.ts": { load: "admin" },
  "admin/targets/+page.server.ts": {
    load: "admin",
    "actions.add": "admin",
    "actions.remove": "admin",
    "actions.discover": "admin",
  },
  "admin/users/+page.server.ts": { load: "admin", "actions.create": "admin" },
  "admin/users/[id]/+page.server.ts": {
    load: "admin",
    "actions.assign": "admin",
    "actions.removeAssignment": "admin",
    "actions.role": "admin",
    "actions.status": "admin",
    "actions.reset": "admin",
    "actions.revoke": "admin",
  },
  "api/health/+server.ts": { GET: "public" },
  "api/metrics/+server.ts": { GET: "bearer" },
  "api/migrate/+server.ts": { GET: "admin", POST: "admin" },
  "api/migrate/[id]/+server.ts": { GET: "operator", DELETE: "operator" },
  "api/migrate/[id]/confirm-restart/+server.ts": { POST: "admin" },
  "api/migrate/[id]/events/+server.ts": { GET: "operator" },
  "api/migrate/[id]/restart/+server.ts": { POST: "operator" },
  "api/migrate/activity/+server.ts": { GET: "admin" },
  "api/migrate/batches/+server.ts": { GET: "admin", POST: "admin" },
  "api/migrate/batches/[id]/+server.ts": { GET: "admin", DELETE: "admin" },
  "api/migrate/batches/[id]/restart/+server.ts": { POST: "admin" },
  "api/migrate/events/+server.ts": { GET: "admin" },
  "api/profile/+server.ts": { GET: "admin", POST: "admin" },
  "api/profile/[id]/+server.ts": { GET: "operator", POST: "operator" },
  "api/profile/[id]/events/+server.ts": { GET: "admin" },
  "api/profile/discover/+server.ts": { GET: "admin" },
  "api/profile/queue/+server.ts": { GET: "admin", POST: "admin" },
  "api/rate-limits/+server.ts": { GET: "admin" },
  "api/ready/+server.ts": { GET: "public" },
  "login/+page.server.ts": { load: "public", actions: "public" },
  "logout/+server.ts": { POST: "public" },
  "mannequins/+page.server.ts": {
    load: "admin",
    "actions.editMapping": "admin",
    "actions.removeMapping": "admin",
    "actions.saveMappings": "admin",
    "actions.checkMappings": "admin",
    "actions.applyMappings": "admin",
    "actions.discover": "admin",
    "actions.invite": "admin",
    "actions.approve": "admin",
  },
  "migrate/+page.server.ts": { load: "operator" },
  "migrate/[id]/+page.server.ts": { load: "operator", "actions.refreshCounts": "admin" },
  "migrate/batches/[id]/+page.server.ts": { load: "operator" },
  "migrate/stats/+page.server.ts": { load: "admin" },
  "profile/+page.server.ts": { load: "operator" },
  "profile/[id]/+page.server.ts": {
    load: "operator",
    "actions.startAnalysis": "admin",
    "actions.cancelAnalysis": "admin",
    "actions.retryAnalysisJob": "admin",
  },
  "setup/+page.server.ts": { load: "admin" },
};

type HookInput = Parameters<Handle>[0];
type EntryPoint = (event: HookInput["event"]) => unknown;
const routeExports = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "fallback",
  "load",
  "actions",
]);
const transpiler = new Bun.Transpiler({ loader: "ts" });
const operator: AuthPrincipal = {
  user: {
    id: "fixture-operator",
    username: "operator",
    displayName: null,
    role: "operator",
    isActive: true,
    mustChangePassword: false,
  },
  sessionTokenHash: "fixture-hash",
};
const hook = createRequestHandler({
  authEnabled: true,
  resolveSession: () => operator,
  sessionCookie: "session",
});

function operatorEvent(routeFile: string, entry: string): HookInput["event"] {
  const routeId = `/${routeFile.replace(/\/?\+[^/]+$/, "")}`;
  const url = new URL(routeId.replace("[id]", "fixture-id"), "http://localhost");
  const method = entry.startsWith("actions") ? "POST" : entry === "load" ? "GET" : entry;
  return {
    request: new Request(url, { method }),
    url,
    route: { id: routeId },
    params: { id: "fixture-id" },
    locals: { authEnabled: true, user: operator.user },
    cookies: { get: () => "fixture-session" },
  } as unknown as HookInput["event"];
}

async function expectDirectDenial(run: EntryPoint, event: HookInput["event"]) {
  const database = spyOn(store, "getDb").mockImplementation(() => {
    throw new Error("Denied requests must not access the database");
  });
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Denied requests must not contact providers"),
  );
  try {
    let result: unknown;
    try {
      result = await run(event);
    } catch (error) {
      if (!isHttpError(error)) throw error;
      result = error;
    }
    const status =
      isHttpError(result) || isActionFailure(result) || result instanceof Response
        ? result.status
        : 0;
    if (result instanceof Response) await result.body?.cancel();
    expect([403, 404]).toContain(status);
    expect(database).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    database.mockRestore();
    fetch.mockRestore();
  }
}

test("every server route and layout has an explicit access classification", () => {
  const discovered = [
    ...new Bun.Glob("**/+{server,page.server,layout.server}.ts").scanSync({
      cwd: import.meta.dir,
      dot: true,
    }),
  ];
  expect(discovered.sort()).toEqual(Object.keys(routes).sort());
});

for (const [file, access] of Object.entries(routes)) {
  test(`${file} classifies every exported entry point`, async () => {
    const names = Object.keys(access);
    const { exports } = transpiler.scan(await Bun.file(`${import.meta.dir}/${file}`).text());
    expect(exports.filter((name) => routeExports.has(name)).sort()).toEqual(
      [...new Set(names.map((name) => (name.startsWith("actions.") ? "actions" : name)))].sort(),
    );

    if (Object.values(access).includes("admin")) {
      const route = await import(`./${file}`);
      expect(
        Object.keys(route.actions ?? {})
          .map((name) => `actions.${name}`)
          .sort(),
      ).toEqual(names.filter((name) => name.startsWith("actions.")).sort());
      for (const [entry, policy] of Object.entries(access)) {
        if (policy !== "admin") continue;
        const run: EntryPoint = entry.startsWith("actions.")
          ? route.actions[entry.slice("actions.".length)]
          : route[entry];
        await expectDirectDenial(run, operatorEvent(file, entry));
      }
    }

    // Layout loads inherit the page's route ID and method.
    if (file.endsWith("+layout.server.ts")) return;
    for (const [entry, policy] of Object.entries(access)) {
      const response = await hook({
        event: operatorEvent(file, entry),
        resolve: async () => new Response(null),
      });
      expect(response.status).toBe(policy === "admin" || policy === "bearer" ? 404 : 200);
    }
  });
}
