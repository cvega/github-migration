import { getSourceClients, isSourceAppConfigured } from "$lib/server/core/auth";
import { validateProfileCredentialScope } from "$lib/server/core/credential-scope";
import { organizationPage } from "$lib/server/core/github-organizations";
import { getBitbucketServerSourceClient } from "$lib/server/source/bitbucket/config";
import { getGitLabSourceClient } from "$lib/server/source/gitlab/config";
import { getSourceProviderAdapter, type SourceProvider } from "$lib/source-provider";

const limit = 50;
async function readPage(provider: SourceProvider, cursor: number, signal: AbortSignal) {
  if (provider === "bitbucket-server") {
    const client = getBitbucketServerSourceClient();
    const data = await client.get<{
      values: { key: string; name: string }[];
      isLastPage: boolean;
      nextPageStart?: number;
    }>("/projects", { start: cursor, limit }, { signal });
    const next = data.isLastPage ? null : data.nextPageStart;
    if (next !== null && (!Number.isSafeInteger(next) || next === undefined || next <= cursor))
      throw new Error("Invalid project cursor");
    return {
      host: new URL(client.apiUrl).host,
      entries: data.values.map(({ key, name }) => ({ key, name })),
      next,
    };
  }
  if (provider === "gitlab") {
    const client = getGitLabSourceClient();
    const page = cursor + 1;
    const { data, headers } = await client.get<{ full_path: string; name: string }[]>(
      "/groups",
      { page, per_page: limit },
      { signal },
    );
    const header = headers.get("x-next-page");
    const next =
      header === null
        ? data.length === limit
          ? page
          : null
        : header === ""
          ? null
          : Number(header) - 1;
    if (next !== null && (!Number.isSafeInteger(next) || next <= cursor))
      throw new Error("Invalid group cursor");
    return {
      host: new URL(client.apiUrl).host,
      entries: data.map((g) => ({ key: g.full_path, name: g.name })),
      next,
    };
  }
  const { rest, sourceApiUrl } = getSourceClients();
  return {
    host: new URL(sourceApiUrl).host,
    ...(await organizationPage(rest, isSourceAppConfigured(), cursor, signal)),
  };
}

export async function discoverNamespacePage(
  provider: SourceProvider,
  cursor: number,
  signal: AbortSignal,
) {
  const page = await readPage(provider, cursor, signal);
  const entries = page.entries.filter(
    (item) => !validateProfileCredentialScope(provider, item.key),
  );
  return { ...page, entries, observedAt: new Date().toISOString() };
}

const scopeVariables: Record<SourceProvider, string> = {
  github: "GH_SOURCE_ORG",
  gitlab: "GITLAB_SOURCE_NAMESPACE",
  "bitbucket-server": "BITBUCKET_SERVER_PROJECT_KEYS",
};
const namespaceNouns: Record<SourceProvider, string> = {
  github: "GitHub organizations",
  gitlab: "GitLab groups",
  "bitbucket-server": "Bitbucket Server projects",
};

export interface EnterpriseDiscovery {
  keys: string[];
  /** Distinct namespaces the source returned before the credential scope was applied. */
  found: number;
  outOfScope: number;
  scopeVariable: string;
}

export async function enterpriseNamespaces(
  provider: SourceProvider,
  signal: AbortSignal,
  enterprise: string,
  read: typeof readPage = readPage,
): Promise<EnterpriseDiscovery> {
  const keys = new Set<string>();
  const found = new Set<string>();
  function add(key: string) {
    if (!getSourceProviderAdapter(provider).isValidNamespace(key))
      throw new Error("Invalid namespace in discovery");
    found.add(key);
    if (!validateProfileCredentialScope(provider, key)) keys.add(key);
  }
  if (provider === "github") {
    // User memberships and App installation repositories are not an enterprise inventory.
    const { gql } = getSourceClients();
    const seen = new Set<string>();
    let after: string | null = null;
    do {
      const data: {
        enterprise: {
          organizations: {
            nodes: { login: string }[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      } = await gql(
        `query($slug:String!, $after:String){ enterprise(slug:$slug){ organizations(first:100,after:$after){ nodes{login} pageInfo{hasNextPage endCursor} } } }`,
        { slug: enterprise, after, request: { signal } },
      );
      if (!data.enterprise) throw new Error("Enterprise not accessible");
      const { nodes, pageInfo } = data.enterprise.organizations;
      for (const org of nodes) add(org.login);
      if (!pageInfo.hasNextPage) break;
      after = pageInfo.endCursor;
      if (!after || seen.has(after) || seen.size >= 10000)
        throw new Error("Invalid enterprise pagination");
      seen.add(after);
    } while (after);
  } else if (provider === "gitlab" && enterprise) {
    const client = getGitLabSourceClient();
    const group = await client.get<{ full_path: string }>(
      `/groups/${encodeURIComponent(enterprise)}`,
      {},
      { signal },
    );
    add(group.data.full_path);
  } else {
    if (provider === "gitlab" && new URL(getGitLabSourceClient().apiUrl).hostname === "gitlab.com")
      throw new Error("GitLab.com requires an enterprise group");
    let cursor = 0;
    for (let page = 0; ; page++) {
      if (page >= 10000) throw new Error("Enterprise discovery page limit exceeded");
      const result = await read(provider, cursor, signal);
      for (const item of result.entries) add(item.key);
      if (result.next === null) break;
      if (!Number.isSafeInteger(result.next) || result.next <= cursor)
        throw new Error("Invalid namespace cursor");
      cursor = result.next;
    }
  }
  // GitLab's group profile already includes projects in all subgroups.
  const eligible =
    provider === "gitlab"
      ? [...keys].filter((path) => {
          let parent = path;
          while (parent.includes("/")) {
            parent = parent.slice(0, parent.lastIndexOf("/"));
            if (keys.has(parent)) return false;
          }
          return true;
        })
      : [...keys];
  return {
    keys: eligible,
    found: found.size,
    outOfScope: found.size - keys.size,
    scopeVariable: scopeVariables[provider],
  };
}

export function describeEmptyDiscovery(provider: SourceProvider, result: EnterpriseDiscovery) {
  const noun = namespaceNouns[provider];
  return result.found > 0 && result.outOfScope === result.found
    ? `Discovery found ${result.found} ${noun}, but all are outside the configured scope (${result.scopeVariable}). No profiles queued.`
    : `Discovery found no ${noun} visible to the source credentials. No profiles queued.`;
}

export function describeScopeNotice(provider: SourceProvider, result: EnterpriseDiscovery) {
  if (result.outOfScope === 0) return undefined;
  return `${result.outOfScope} of ${result.found} ${namespaceNouns[provider]} found are outside the configured scope (${result.scopeVariable}).`;
}

export type DiscoveryFailureReason =
  | "host_not_resolvable"
  | "tls_untrusted"
  | "connection_refused"
  | "timeout"
  | "http"
  | "unknown";

const tlsCode =
  /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH/;

function networkReason(error: unknown): DiscoveryFailureReason | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    const fields = current as { code?: unknown; name?: unknown; cause?: unknown };
    const code = String(fields.code ?? "");
    const name = String(fields.name ?? "");
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "DNSException")
      return "host_not_resolvable";
    if (tlsCode.test(code)) return "tls_untrusted";
    if (code === "ECONNREFUSED" || code === "ConnectionRefused") return "connection_refused";
    if (name === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT")
      return "timeout";
    current = fields.cause;
  }
  return undefined;
}

/**
 * Classify a discovery failure into a safe reason. Only fixed text and the HTTP
 * status are returned; provider messages, URLs and response bodies are dropped.
 */
export function describeDiscoveryFailure(provider: SourceProvider, error: unknown) {
  // Octokit reports transport failures as HTTP 500, so inspect causes first.
  const network = networkReason(error);
  const raw =
    typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  const status =
    typeof raw === "number" && Number.isInteger(raw) && raw >= 100 && raw <= 599 ? raw : undefined;
  const reason: DiscoveryFailureReason = network ?? (status ? "http" : "unknown");
  const source = getSourceProviderAdapter(provider).displayName;
  const detail = {
    host_not_resolvable: `The ${source} host name could not be resolved from the dashboard. Check the source API URL and DNS.`,
    tls_untrusted: `The ${source} TLS certificate is not trusted by the dashboard. Check the certificate chain or trusted CA bundle.`,
    connection_refused: `The ${source} host refused the connection. Check the source API URL and port.`,
    timeout: `The ${source} source did not respond in time.`,
    http:
      status === 401
        ? "Source credentials were rejected."
        : status === 403
          ? "Access to this enterprise was denied."
          : `The ${source} source returned HTTP ${status}.`,
    unknown:
      "Enterprise discovery did not finish. Check the source, credentials and enterprise scope.",
  }[reason];
  return {
    reason,
    log: reason === "http" ? `http ${status}` : reason,
    detail,
    message: `${detail} No profiles queued.`,
  };
}
