/**
 * Per-repo REST signals — the cheap presence/count checks GraphQL can't fold in.
 *
 * Three migration considerations are best read straight from REST:
 *   - webhooks      — migrate but arrive disabled; their secrets aren't carried.
 *   - GitHub Pages  — settings migrate but usually need reconfiguring.
 *   - code scanning — alert history and states aren't migrated.
 *
 * Each is a single request: a `Link`-header count (`countByPagination`) for
 * webhooks, or a 200/404 presence probe for Pages and code scanning. All three
 * are permission-sensitive and degrade to 0/false for a read-only token rather
 * than failing the repo, so a sparse-scope crawl still completes.
 *
 * The `rest` client is injected so this is unit-testable without a network.
 */
import { countByPagination, type GitHubClient } from "$lib/server/core/github";
import type { DiscoveredRepo } from "./types";

/** The REST-only signals merged onto a repo's profile. */
export interface RepoRestSignals {
  webhooksCount: number;
  hasPages: boolean;
  hasCodeScanningAlerts: boolean;
}

/** Split `owner/name`; returns null when it isn't a well-formed pair. */
function splitOwnerRepo(nameWithOwner: string): { owner: string; repo: string } | null {
  const slash = nameWithOwner.indexOf("/");
  if (slash <= 0) return null;
  return { owner: nameWithOwner.slice(0, slash), repo: nameWithOwner.slice(slash + 1) };
}

/** Webhook count via the `Link` header (0 when unreadable). */
async function countWebhooks(rest: GitHubClient, owner: string, repo: string): Promise<number> {
  try {
    return await countByPagination(rest, "GET /repos/{owner}/{repo}/hooks", { owner, repo });
  } catch {
    return 0;
  }
}

/** Whether Pages is enabled — `GET …/pages` is 200 when configured, 404 when not. */
async function hasPagesEnabled(rest: GitHubClient, owner: string, repo: string): Promise<boolean> {
  try {
    const res = await rest.request("GET /repos/{owner}/{repo}/pages", { owner, repo });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Whether the repo has any code-scanning alert (so there's history to lose). */
async function hasCodeScanning(rest: GitHubClient, owner: string, repo: string): Promise<boolean> {
  try {
    const res = await rest.request("GET /repos/{owner}/{repo}/code-scanning/alerts", {
      owner,
      repo,
      per_page: 1,
    });
    return Array.isArray(res.data) && res.data.length > 0;
  } catch {
    // 404 (code scanning not enabled) / 403 (no access) → treat as none.
    return false;
  }
}

/**
 * Gather a repository's REST-only signals. The three requests run concurrently;
 * each degrades independently, so one inaccessible endpoint doesn't suppress the
 * others.
 *
 * @param rest Authenticated source REST client.
 * @param r    The discovered repo (provides `nameWithOwner`).
 * @returns    Webhook count plus Pages / code-scanning presence flags.
 */
export async function gatherRepoRestSignals(
  rest: GitHubClient,
  r: DiscoveredRepo,
): Promise<RepoRestSignals> {
  const parts = splitOwnerRepo(r.nameWithOwner);
  if (!parts) return { webhooksCount: 0, hasPages: false, hasCodeScanningAlerts: false };
  const { owner, repo } = parts;
  const [webhooksCount, hasPages, hasCodeScanningAlerts] = await Promise.all([
    countWebhooks(rest, owner, repo),
    hasPagesEnabled(rest, owner, repo),
    hasCodeScanning(rest, owner, repo),
  ]);
  return { webhooksCount, hasPages, hasCodeScanningAlerts };
}
