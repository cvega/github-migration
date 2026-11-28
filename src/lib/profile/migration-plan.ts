import type { SourceProvider } from "$lib/source/types";
import { getSourceProviderAdapter } from "$lib/source-provider";
import type { ProfileMigrationPlan, ProfilePlanRepo } from "./types";

export const MAX_PROFILE_PLAN_REPOS = 500;
const MAX_TARGET_REPO_LENGTH = 100;

export type { ProfileMigrationPlan, ProfilePlanRepo } from "./types";

export function defaultProfilePlanSelection(repos: ProfilePlanRepo[]): string[] {
  return repos
    .filter((repo) => repo.blockers === 0)
    .slice(0, MAX_PROFILE_PLAN_REPOS)
    .map((repo) => repo.nameWithOwner);
}

function sanitizeTargetName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, MAX_TARGET_REPO_LENGTH);
  return sanitized === "." || sanitized === ".." ? "repository" : sanitized;
}

export function defaultProfileTargetNames(
  sourceProvider: SourceProvider,
  sourceOrg: string,
  selectedRepos: readonly string[],
): ReadonlyMap<string, string> {
  const adapter = getSourceProviderAdapter(sourceProvider);
  const defaults = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const path of new Set(selectedRepos)) {
    const name = sanitizeTargetName(adapter.projectName(path));
    defaults.set(path, name);
    const key = name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Reserve unique leaves first, then resolve collisions in source-path order.
  const used = new Set([...counts].filter(([, count]) => count === 1).map(([name]) => name));
  const namespacePrefix = `${sourceOrg}/`;
  for (const path of [...defaults.keys()].sort()) {
    const leaf = defaults.get(path)!;
    if (!leaf || counts.get(leaf.toLowerCase()) === 1) continue;

    const relativePath = path.startsWith(namespacePrefix)
      ? path.slice(namespacePrefix.length)
      : path;
    const base = sanitizeTargetName(relativePath);
    let name = base;
    for (let index = 2; used.has(name.toLowerCase()); index++) {
      const suffix = `-${index}`;
      name = `${base.slice(0, MAX_TARGET_REPO_LENGTH - suffix.length)}${suffix}`;
    }
    defaults.set(path, name);
    used.add(name.toLowerCase());
  }
  return defaults;
}

export function buildProfileMigrationPlan(input: {
  profileRunId: string;
  targetProfileId: string;
  sourceProvider?: SourceProvider;
  sourceApiUrl: string;
  sourceOrg: string;
  targetOrg: string;
  repos: ProfilePlanRepo[];
  selectedRepos: Iterable<string>;
  targetNames?: Readonly<Record<string, string>>;
  acceptBlockers?: boolean;
  nowMs?: number;
}): ProfileMigrationPlan {
  const sourceProvider = input.sourceProvider ?? "github";
  const byName = new Map(input.repos.map((repo) => [repo.nameWithOwner, repo]));
  const targetOrg = input.targetOrg.trim();
  if (!targetOrg || targetOrg.includes("/") || /\s/.test(targetOrg)) {
    throw new TypeError("Target organization must be a non-empty organization name");
  }
  const selected = [...new Set(input.selectedRepos)];
  if (selected.length === 0) throw new TypeError("Select at least one repository");
  if (selected.length > MAX_PROFILE_PLAN_REPOS) {
    throw new RangeError(
      `A migration batch can contain at most ${MAX_PROFILE_PLAN_REPOS} repositories`,
    );
  }
  const repos = selected.map((name) => {
    const repo = byName.get(name);
    if (!repo) throw new TypeError(`Repository '${name}' is not part of this profile run`);
    return repo;
  });
  const defaults = defaultProfileTargetNames(sourceProvider, input.sourceOrg, selected);
  const items = repos.map((repo) => ({
    sourceRepo: repo.nameWithOwner,
    targetRepo:
      input.targetNames?.[repo.nameWithOwner]?.trim() || defaults.get(repo.nameWithOwner)!,
  }));
  const targetNames = new Set<string>();
  for (const item of items) {
    if (!item.targetRepo || item.targetRepo.includes("/") || /\s/.test(item.targetRepo)) {
      throw new TypeError(`Target repository '${item.targetRepo}' must be a repository name`);
    }
    const normalized = item.targetRepo.toLowerCase();
    if (targetNames.has(normalized)) {
      throw new TypeError(`Target repository '${item.targetRepo}' is used more than once`);
    }
    targetNames.add(normalized);
  }
  const reposWithBlockers = repos.filter((repo) => repo.blockers > 0).length;
  if (reposWithBlockers > 0 && !input.acceptBlockers) {
    throw new TypeError("Accept the unresolved blockers before creating this migration plan");
  }
  const createdAt = new Date(input.nowMs ?? Date.now()).toISOString();
  return {
    version: 3,
    profileRunId: input.profileRunId,
    targetProfileId: input.targetProfileId,
    sourceProvider,
    sourceApiUrl: input.sourceApiUrl,
    sourceOrg: input.sourceOrg,
    targetOrg,
    items,
    reposWithBlockers,
    reposWithWarnings: repos.filter((repo) => repo.warnings > 0).length,
    blockersAcceptedAt: reposWithBlockers > 0 ? createdAt : null,
    createdAt,
  };
}
