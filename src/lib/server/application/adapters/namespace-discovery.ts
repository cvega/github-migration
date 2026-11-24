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

export async function enterpriseNamespaces(
  provider: SourceProvider,
  signal: AbortSignal,
  enterprise: string,
  read = discoverNamespacePage,
) {
  const keys = new Set<string>();
  function add(key: string) {
    if (!getSourceProviderAdapter(provider).isValidNamespace(key))
      throw new Error("Invalid namespace in discovery");
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
  return provider === "gitlab"
    ? [...keys].filter((path) => {
        let parent = path;
        while (parent.includes("/")) {
          parent = parent.slice(0, parent.lastIndexOf("/"));
          if (keys.has(parent)) return false;
        }
        return true;
      })
    : [...keys];
}
