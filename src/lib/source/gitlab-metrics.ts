import type { UsedIconName } from "$lib/icons.generated";

/**
 * Client-safe declaration of every GitLab per-project profile metric. The key
 * list is the single source for the stored enrichment shape, the summary schema
 * and the "Repository contents" cards. Collectors need server credentials, so
 * they are registered by the same key in `server/source/gitlab/profile.ts`,
 * where the compiler rejects a key without a collector. Array order is the
 * collection order; `card.position` is the display order.
 */
export const GITLAB_PROFILE_METRICS = [
  { key: "issues", card: { label: "Visible issues", icon: "issue-opened", position: 5 } },
  {
    key: "mergeRequests",
    card: { label: "Merge requests", icon: "git-pull-request", position: 1 },
  },
  { key: "commits", card: { label: "Commits", icon: "git-commit", position: 0 } },
  { key: "branches", card: { label: "Branches", icon: "git-branch", position: 2 } },
  { key: "tags", card: { label: "Tags", icon: "tag", position: 3 } },
  { key: "releases", card: { label: "Releases", icon: "package", position: 4 } },
] as const satisfies ReadonlyArray<{
  key: string;
  card: { label: string; icon: UsedIconName; position: number };
}>;

export type GitLabMetricKey = (typeof GITLAB_PROFILE_METRICS)[number]["key"];

export const GITLAB_PROFILE_METRIC_KEYS: readonly GitLabMetricKey[] = GITLAB_PROFILE_METRICS.map(
  ({ key }) => key,
);

/** Cards in display order. */
export const GITLAB_PROFILE_METRIC_CARDS = GITLAB_PROFILE_METRICS.map(({ key, card }) => ({
  key,
  ...card,
})).sort((left, right) => left.position - right.position);
