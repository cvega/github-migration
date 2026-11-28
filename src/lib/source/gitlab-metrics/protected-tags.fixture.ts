import type { ProfileNumericMetric } from "$lib/source/types";

/** A valid stored observation for this metric: exact, with its scope. */
export default {
  provider: "gitlab",
  endpointFamily: "project-protected-tags",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: { kind: "exact", value: 1, basis: "enumerated", scope: "fixture protected tags" },
} satisfies ProfileNumericMetric;
