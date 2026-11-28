import { json } from "@sveltejs/kit";
import {
  describeDiscoveryFailure,
  discoverNamespacePage,
} from "$lib/server/application/adapters/namespace-discovery";
import { requireAdminIfAuthEnabled } from "$lib/server/core/auth/authorization";
import { isSourceProvider } from "$lib/source-provider";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, request, locals }) => {
  requireAdminIfAuthEnabled(locals);
  const provider = url.searchParams.get("provider");
  const raw = url.searchParams.get("cursor") ?? "0";
  if (!isSourceProvider(provider) || !/^\d{1,9}$/.test(raw))
    return json({ error: "Invalid source or cursor" }, { status: 400 });
  try {
    return json(await discoverNamespacePage(provider, Number(raw), request.signal), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const failure = describeDiscoveryFailure(provider, error);
    console.warn(`[profile] ${provider} discovery failed (${failure.log})`);
    return json(
      {
        error:
          failure.reason === "unknown"
            ? "Could not list namespaces from this source. Check the connection and its read permissions."
            : failure.detail,
        reason: failure.reason,
      },
      { status: 502 },
    );
  }
};
