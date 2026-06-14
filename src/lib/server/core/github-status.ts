/**
 * GitHub Status API client — fetches unresolved incidents from
 * https://www.githubstatus.com/api/v2/incidents/unresolved.json
 *
 * Results are cached in-memory for 60 seconds to avoid excessive
 * external calls. Failures gracefully degrade to "all clear."
 */

import type { GitHubStatus, GitHubStatusIncident } from "$lib/types";

const STATUS_URL = "https://www.githubstatus.com/api/v2/incidents/unresolved.json";
const CACHE_TTL_MS = 60_000; // 60 seconds
const FETCH_TIMEOUT_MS = 3_000; // 3 seconds

const ALL_CLEAR: GitHubStatus = { ok: true, incidentCount: 0, incidents: [] };

let cached: GitHubStatus = ALL_CLEAR;
let cachedAt = 0;

interface StatusApiResponse {
  incidents: {
    name: string;
    status: string;
    shortlink: string;
  }[];
}

/**
 * Returns the current GitHub platform status. Results are cached
 * for 60s. On fetch failure, returns the last known good state
 * (or all-clear if no prior data).
 */
export async function fetchGitHubStatus(): Promise<GitHubStatus> {
  const now = Date.now();
  if (now - cachedAt < CACHE_TTL_MS) return cached;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(STATUS_URL, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[github-status] API returned ${res.status}`);
      return cached;
    }

    const body: StatusApiResponse = await res.json();
    const incidents: GitHubStatusIncident[] = body.incidents.map((i) => ({
      name: i.name,
      status: i.status,
      url: i.shortlink,
    }));

    cached = {
      ok: incidents.length === 0,
      incidentCount: incidents.length,
      incidents,
    };
    cachedAt = now;
  } catch (err) {
    // Network error / timeout — keep last known state.
    console.warn("[github-status] Fetch failed, using cached state:", (err as Error).message);
  }

  return cached;
}
