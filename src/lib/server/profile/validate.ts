import {
  getSourceProviderAdapter,
  isSourceProvider,
  SOURCE_PROVIDERS,
  type SourceProvider,
} from "$lib/source-provider";

export interface StartProfileRequest {
  sourceProvider: SourceProvider;
  org: string;
}

export function validateStartProfileRequest(
  data: Record<string, unknown>,
): { ok: true; value: StartProfileRequest } | { ok: false; error: string } {
  const sourceProvider = data.sourceProvider === undefined ? "github" : data.sourceProvider;
  if (!isSourceProvider(sourceProvider)) {
    return { ok: false, error: `sourceProvider must be one of: ${SOURCE_PROVIDERS.join(", ")}` };
  }
  const org = typeof data.org === "string" ? data.org.trim() : "";
  const adapter = getSourceProviderAdapter(sourceProvider);
  if (!adapter.isValidNamespace(org)) {
    return { ok: false, error: `A valid ${adapter.namespaceLabel} ('org') is required` };
  }
  return { ok: true, value: { sourceProvider, org } };
}
