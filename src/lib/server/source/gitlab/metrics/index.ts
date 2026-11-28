import { GITLAB_PROFILE_METRIC_KEYS, type GitLabMetricKey } from "$lib/source/gitlab-metrics";
import { GITLAB_METRIC_COLLECTORS } from "./collectors.generated";
import type { GitLabMetricCollector } from "./types";

type CollectorKey = (typeof GITLAB_METRIC_COLLECTORS)[number]["key"];

/** Collectors in the registry's collection order, rejecting a missing or extra key. */
export function orderGitLabCollectors(
  keys: readonly string[],
  modules: ReadonlyArray<{ key: string; collect: GitLabMetricCollector }>,
): Array<{ key: string; collect: GitLabMetricCollector }> {
  const byKey = new Map(modules.map((module) => [module.key, module]));
  const problems = [
    ...modules.filter((module, index) => modules.findIndex((m) => m.key === module.key) !== index),
    ...keys.filter((key) => !byKey.has(key)).map((key) => ({ key: `${key} (missing)` })),
    ...modules.filter((module) => !keys.includes(module.key)),
  ].map((module) => module.key);
  if (problems.length > 0) {
    throw new Error(`GitLab metric collectors must match the registry: ${problems.join(", ")}`);
  }
  return keys.map((key) => byKey.get(key)!);
}

// Compile-time guarantee that every registered key has a collector.
const COLLECTOR_FOR_EVERY_KEY: [Exclude<GitLabMetricKey, CollectorKey>] extends [never]
  ? true
  : never = true;

export const GITLAB_METRIC_COLLECTORS_IN_ORDER = COLLECTOR_FOR_EVERY_KEY
  ? orderGitLabCollectors(GITLAB_PROFILE_METRIC_KEYS, GITLAB_METRIC_COLLECTORS)
  : [];
