import type { ProfileNumericMetric } from "$lib/source/types";

/** A valid stored observation for this metric: exact, with its scope. */
export default {
  provider: "gitlab",
  endpointFamily: "project-issues",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: { kind: "exact", value: 12, basis: "reported", scope: "fixture project issues" },
} satisfies ProfileNumericMetric;
