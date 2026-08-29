import { parseSourceApiUrl } from "$lib/source/url";

export { parseSourceApiUrl } from "$lib/source/url";

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
