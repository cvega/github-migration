import { fail } from "@sveltejs/kit";
import {
  changeCatalogTarget,
  requireTargetConnection,
  TargetCatalogError,
  targetConnections,
} from "$lib/server/application/self-service/target-catalog";
import { isTargetAppConfigured } from "$lib/server/core/auth";
import { requireAdmin } from "$lib/server/core/auth/authorization";
import { organizationPage } from "$lib/server/core/github-organizations";
import { getMigrationTargetClient, requireMigrationTargetProfile } from "$lib/server/core/targets";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  requireAdmin(locals);
  return { connections: targetConnections() };
};

async function edit({ request, locals }: RequestEvent, add: boolean) {
  const actor = requireAdmin(locals);
  const fields = await request.formData();
  const org = fields.get("org");
  const connection = fields.get("connection");
  if (typeof org !== "string" || typeof connection !== "string")
    return fail(400, { error: "Choose a connection and organization." });
  try {
    changeCatalogTarget(actor.id, connection, org, add);
    return {
      success: add ? "Target listed. No user access was granted." : "Target removed from the list.",
    };
  } catch (cause) {
    if (cause instanceof TargetCatalogError) return fail(400, { error: cause.message });
    throw cause;
  }
}

export const actions = {
  add: (event) => edit(event, true),
  remove: (event) => edit(event, false),
  discover: async ({ request, locals }) => {
    requireAdmin(locals);
    const fields = await request.formData();
    const cursor = Number(fields.get("cursor") ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 10000)
      return fail(400, { error: "Invalid organization page." });
    let target: ReturnType<typeof requireMigrationTargetProfile>;
    try {
      const connection = requireTargetConnection(String(fields.get("connection") ?? ""));
      target = requireMigrationTargetProfile(connection.id);
    } catch (cause) {
      if (cause instanceof TargetCatalogError) return fail(400, { error: cause.message });
      throw cause;
    }
    try {
      const result = await organizationPage(
        getMigrationTargetClient(target),
        target.platform === "ghec" && isTargetAppConfigured(),
        cursor,
        AbortSignal.timeout(12000),
      );
      return {
        discovery: {
          key: JSON.stringify([target.id, target.apiUrl]),
          organizations: result.entries.map((e) => e.key),
          next: result.next,
        },
      };
    } catch {
      // Provider errors can include credential-bearing request details.
      return fail(502, {
        error: `Could not list organizations on ${target.displayName}. Check target credentials and connectivity, or enter a known login below.`,
      });
    }
  },
} satisfies Actions;
