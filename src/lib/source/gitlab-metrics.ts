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
  {
    key: "ciConfiguration",
    card: { label: "GitLab CI to convert", icon: "workflow", position: 7 },
  },
  {
    key: "protectedBranches",
    card: { label: "Branch protection rules", icon: "shield-lock", position: 8 },
  },
  {
    key: "inheritedProtectedBranches",
    card: { label: "Inherited branch rules", icon: "shield", position: 9 },
  },
  {
    key: "protectedTags",
    card: { label: "Tag protection rules", icon: "shield-lock", position: 10 },
  },
] as const satisfies ReadonlyArray<{
  key: string;
  card: { label: string; icon: UsedIconName; position: number };
}>;

export type GitLabMetricKey = (typeof GITLAB_PROFILE_METRICS)[number]["key"];

/** Protection rules GitHub Enterprise Importer does not migrate; each must be recreated. */
export const GITLAB_PROTECTION_RULE_METRIC_KEYS = [
  "protectedBranches",
  "inheritedProtectedBranches",
  "protectedTags",
] as const satisfies readonly GitLabMetricKey[];

export const GITLAB_PROFILE_METRIC_KEYS: readonly GitLabMetricKey[] = GITLAB_PROFILE_METRICS.map(
  ({ key }) => key,
);

/** Cards in display order. */
export const GITLAB_PROFILE_METRIC_CARDS = GITLAB_PROFILE_METRICS.map(({ key, card }) => ({
  key,
  ...card,
})).sort((left, right) => left.position - right.position);
