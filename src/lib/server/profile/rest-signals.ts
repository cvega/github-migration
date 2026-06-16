/**
 * Per-repo REST signals — the cheap presence/count checks GraphQL can't fold in.
 *
 * Four migration considerations are best read straight from REST:
 *   - webhooks      — migrate but arrive disabled; their secrets aren't carried.
 *   - code scanning — alert history and states aren't migrated.
 *   - collaborators — direct per-repo user/team access isn't migrated.
 *   - tag protection — tag protection rules aren't migrated.
 *
 * (GitHub Pages is read for free from discovery's `has_pages`, so it needs no
 * per-repo request here.) Each call is permission-sensitive and degrades to
 * 0/false rather than failing the repo, so a sparse-scope crawl still completes.
 *
 * The `rest` client is injected so this is unit-testable without a network.
 */
import { countByPagination, type GitHubClient } from "$lib/server/core/github";
import type { DiscoveredRepo } from "./types";

/** The REST-only signals merged onto a repo's profile. */
export interface RepoRestSignals {
  webhooksCount: number;
  hasCodeScanningAlerts: boolean;
  collaboratorsCount: number;
  tagProtectionCount: number;
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

/**
 * Whether the repo has any code-scanning alert (so there's history to lose).
 *
 * The endpoint legitimately answers with a non-200 for most repos, which we map
 * to "no scanning history":
 *   - 404 — code scanning isn't set up (no default setup, no analyses).
 *   - 403 — GitHub Advanced Security isn't enabled, or the token lacks the
 *           `security_events` scope.
 * Both mean “nothing to lose here” for our purposes, so they degrade to false
 * (these are expected responses, not crawl failures).
 */
async function hasCodeScanning(rest: GitHubClient, owner: string, repo: string): Promise<boolean> {
  try {
    const res = await rest.request("GET /repos/{owner}/{repo}/code-scanning/alerts", {
      owner,
      repo,
      per_page: 1,
    });
    return Array.isArray(res.data) && res.data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Count direct collaborators (`affiliation=direct`) — users granted access to
 * this repo specifically, excluding access inherited from org membership. This
 * is the per-repo access that a migration does not carry over. 0 when unreadable
 * (needs the `repo`/`read:org` reach a read-only token may lack).
 */
async function countDirectCollaborators(
  rest: GitHubClient,
  owner: string,
  repo: string,
): Promise<number> {
  try {
    return await countByPagination(rest, "GET /repos/{owner}/{repo}/collaborators", {
      owner,
      repo,
      affiliation: "direct",
    });
  } catch {
    return 0;
  }
}

/**
 * Count tag protection rules. The endpoint returns a bare array of rules, so the
 * length is the count. 404/empty (no rules, or expressed as rulesets instead)
 * and permission errors degrade to 0.
 */
async function countTagProtection(
  rest: GitHubClient,
  owner: string,
  repo: string,
): Promise<number> {
  try {
    const res = await rest.request("GET /repos/{owner}/{repo}/tags/protection", { owner, repo });
    return Array.isArray(res.data) ? res.data.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Gather a repository's REST-only signals. The requests run concurrently; each
 * degrades independently, so one inaccessible endpoint doesn't suppress the
 * other.
 *
 * @param rest Authenticated source REST client.
 * @param r    The discovered repo (provides `nameWithOwner`).
 * @returns    Webhook count plus the code-scanning presence flag.
 */
export async function gatherRepoRestSignals(
  rest: GitHubClient,
  r: DiscoveredRepo,
): Promise<RepoRestSignals> {
  const parts = splitOwnerRepo(r.nameWithOwner);
  if (!parts) {
    return {
      webhooksCount: 0,
      hasCodeScanningAlerts: false,
      collaboratorsCount: 0,
      tagProtectionCount: 0,
    };
  }
  const { owner, repo } = parts;
  const [webhooksCount, hasCodeScanningAlerts, collaboratorsCount, tagProtectionCount] =
    await Promise.all([
      countWebhooks(rest, owner, repo),
      hasCodeScanning(rest, owner, repo),
      countDirectCollaborators(rest, owner, repo),
      countTagProtection(rest, owner, repo),
    ]);
  return { webhooksCount, hasCodeScanningAlerts, collaboratorsCount, tagProtectionCount };
}
