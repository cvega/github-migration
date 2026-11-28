import type { GitLabProjectMetrics } from "$lib/source/types";

export default {
  provider: "gitlab",
  endpointFamily: "project-packages",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: {
    kind: "exact",
    value: 0,
    basis: "enumerated",
    scope: "fixture project packages with status=default",
  },
  ecosystemCounts: {},
} satisfies GitLabProjectMetrics["packageVersions"];
