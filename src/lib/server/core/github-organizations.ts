import type { GitHubClient } from "./github";

/** User membership for PATs; an installation token is scoped to one account. */
export async function organizationPage(
  rest: GitHubClient,
  installation: boolean,
  cursor: number,
  signal: AbortSignal,
) {
  if (installation) {
    const { data } = await rest.request("GET /installation/repositories", {
      per_page: 1,
      request: { signal },
    });
    const owner = data.repositories[0]?.owner;
    return {
      entries: owner?.type === "Organization" ? [{ key: owner.login, name: owner.login }] : [],
      next: null,
    };
  }
  const { data, headers } = await rest.orgs.listForAuthenticatedUser({
    per_page: 50,
    page: cursor + 1,
    request: { signal },
  });
  return {
    entries: data.map(({ login }) => ({ key: login, name: login })),
    next: headers.link?.includes('rel="next"') ? cursor + 1 : null,
  };
}
