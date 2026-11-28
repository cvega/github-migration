import type { ProfileNumericMetric, SourceProjectInventory } from "$lib/source/types";
import type { GitLabClient } from "../client";
import type { GitLabGroupHookCache } from "../webhooks";

/**
 * Shared by every collector in one profile run. `apiCallCeiling` is an absolute
 * limit on the client's call counter, so retries and pagination of concurrent
 * collectors all spend the same budget.
 */
export interface GitLabMetricOptions {
  signal?: AbortSignal;
  nowMs?: number;
  apiCallCeiling?: number;
  /** Authorized profile namespace, for collectors that read group-level settings. */
  namespace?: string;
  /** Per-run memo shared by collectors that read the same list. */
  shared?: Map<string, Promise<unknown>>;
  groupHookCache?: GitLabGroupHookCache;
}

type GitLabMetricProject = Pick<
  SourceProjectInventory,
  "sourceId" | "path" | "defaultBranch" | "providerDetails"
>;

export type GitLabMetricCollector = (
  client: GitLabClient,
  project: GitLabMetricProject,
  options?: GitLabMetricOptions,
) => Promise<ProfileNumericMetric>;

/** A collector bound to the metric key it produces. */
export interface GitLabMetricCollectorModule<Key extends string = string> {
  key: Key;
  collect: GitLabMetricCollector;
}

export function defineGitLabCollector<const Key extends string>(
  descriptor: { key: Key },
  collect: GitLabMetricCollector,
): GitLabMetricCollectorModule<Key> {
  return { key: descriptor.key, collect };
}
