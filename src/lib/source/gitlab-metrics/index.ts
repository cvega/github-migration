import type { z } from "zod";
import type { GitLabMetricDescriptor } from "./define";
import { GITLAB_METRIC_DESCRIPTORS } from "./modules.generated";

/**
 * Registry of every GitLab per-project profile metric. The key list is the
 * single source for the stored enrichment shape, the summary schema and the
 * "Repository contents" cards. Descriptors come from the generated module list,
 * so adding a metric never edits this file. Collectors need server credentials
 * and are discovered separately in `server/source/gitlab/metrics`.
 */
type Descriptor = (typeof GITLAB_METRIC_DESCRIPTORS)[number];

export type GitLabMetricKey = Descriptor["key"];

/** Stored fields a metric adds to the common numeric metric. */
export type GitLabMetricFields<Key extends GitLabMetricKey> =
  Extract<Descriptor, { key: Key }> extends { fields: infer Fields extends z.ZodRawShape }
    ? z.infer<z.ZodObject<Fields>>
    : unknown;

/** Validates that every key, `order` and card `position` is unique, then sorts by `order`. */
export function orderGitLabMetrics<Metric extends GitLabMetricDescriptor>(
  descriptors: readonly Metric[],
): Metric[] {
  for (const field of ["key", "order", "card.position"] as const) {
    const values = descriptors.map((descriptor) =>
      field === "card.position" ? descriptor.card.position : descriptor[field],
    );
    if (new Set(values).size !== values.length) {
      throw new Error(`GitLab profile metrics must have a unique ${field}`);
    }
  }
  return [...descriptors].sort((left, right) => left.order - right.order);
}

/** Descriptors in collection order. */
export const GITLAB_PROFILE_METRICS: readonly Descriptor[] =
  orderGitLabMetrics(GITLAB_METRIC_DESCRIPTORS);

export const GITLAB_PROFILE_METRIC_KEYS: readonly GitLabMetricKey[] = GITLAB_PROFILE_METRICS.map(
  ({ key }) => key,
);

/** Protection rules GitHub Enterprise Importer does not migrate; each must be recreated. */
export const GITLAB_PROTECTION_RULE_METRIC_KEYS: readonly GitLabMetricKey[] =
  GITLAB_PROFILE_METRICS.filter((descriptor) => "protectionRule" in descriptor).map(
    ({ key }) => key,
  );

/** Cards in display order. */
export const GITLAB_PROFILE_METRIC_CARDS = GITLAB_PROFILE_METRICS.map(({ key, card }) => ({
  key,
  ...card,
})).sort((left, right) => left.position - right.position);
