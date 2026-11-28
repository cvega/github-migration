import type { z } from "zod";
import type { UsedIconName } from "$lib/icons.generated";

/**
 * Client-safe declaration of one GitLab per-project profile metric. Each metric
 * lives in `<name>.metric.ts` beside a `<name>.fixture.ts`, and its server
 * collector in `server/source/gitlab/metrics/<name>.collector.ts`. The generated
 * module lists are produced by `scripts/packaging/generate-gitlab-metrics.ts`;
 * adding a metric adds those three files and nothing else.
 */
export interface GitLabMetricDescriptor {
  /** Stored enrichment key and summary key. */
  key: string;
  /** Collection and stored-key order. Unique across metrics. */
  order: number;
  /** "Repository contents" card; `position` is the display order and is unique. */
  card: { label: string; icon: UsedIconName; position: number };
  /** Stored fields beyond the common numeric metric. */
  fields?: z.ZodRawShape;
  /** Counts toward the protection rules GitHub Enterprise Importer does not migrate. */
  protectionRule?: true;
}

export function defineGitLabMetric<const Descriptor extends GitLabMetricDescriptor>(
  descriptor: Descriptor,
): Descriptor {
  return descriptor;
}
