import type { GitLabWebhookMetric } from "$lib/source/types";

/** A valid stored observation for this metric: exact, with its scope. */
export default {
  provider: "gitlab",
  endpointFamily: "project-hooks",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: { kind: "exact", value: 0, basis: "enumerated", scope: "fixture project hooks" },
  eventCategories: [],
} satisfies GitLabWebhookMetric;
