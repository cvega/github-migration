import type { GitLabProjectMetrics } from "$lib/source/types";
import { GITLAB_METRIC_FIXTURES } from "./fixtures.generated";

/**
 * A complete stored metrics map built from every metric's own fixture. Tests
 * and seeds that need complete data override only the metrics their scenario
 * is about, so adding a metric never edits them.
 */
export function gitLabMetricFixtures(
  overrides: Partial<GitLabProjectMetrics> = {},
): GitLabProjectMetrics {
  return {
    ...(structuredClone(GITLAB_METRIC_FIXTURES) as GitLabProjectMetrics),
    ...overrides,
  };
}
