import { assertPersistableSourceApiUrl, parseSourceApiUrl } from "$lib/source/url";
import type { SourceProvider } from "$lib/source-provider";

export { parseSourceApiUrl } from "$lib/source/url";

export function parseConfiguredSourceInventory(value: unknown) {
  return parseInventory(value, assertMigrationSourceApiUrl);
}

export function normalizeGitLabApiUrl(
  value: string,
  options: { allowInsecureHttp?: boolean } = {},
): string {
  const url = parseSourceApiUrl(value, {
    label: "GitLab URL",
    requireHttps: options.allowInsecureHttp !== true,
    insecureHttpMessage: "GitLab URL must use HTTPS unless insecure HTTP is explicitly enabled",
  });
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/api/v4") ? path : `${path}/api/v4`;
  return url.toString().replace(/\/$/, "");
}

export function normalizeBitbucketServerApiUrl(
  value: string,
  options: { allowInsecureHttp?: boolean } = {},
): string {
  const url = parseSourceApiUrl(value, {
    label: "Bitbucket Server URL",
    requireHttps: options.allowInsecureHttp !== true,
    insecureHttpMessage:
      "Bitbucket Server URL must use HTTPS unless insecure HTTP is explicitly enabled",
  });
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/rest/api/1.0") ? path : `${path}/rest/api/1.0`;
  return url.toString().replace(/\/$/, "");
}

export function assertMigrationSourceApiUrl(value: string, provider?: SourceProvider): void {
  const url = parseSourceApiUrl(value);
  if (
    url.protocol === "http:" &&
    provider === "bitbucket-server" &&
    process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP === "true"
  ) {
    const configuredUrl = normalizeBitbucketServerApiUrl(process.env.BITBUCKET_SERVER_URL ?? "", {
      allowInsecureHttp: true,
    });
    if (value !== configuredUrl) {
      throw new TypeError("Source API URL must match the configured Bitbucket Server URL");
    }
    return;
  }
  assertPersistableSourceApiUrl(value);
}

import { parseSourceNamespaceInventory as parseInventory } from "$lib/source/inventory";
