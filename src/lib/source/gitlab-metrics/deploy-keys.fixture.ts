import type { GitLabProjectMetrics } from "$lib/source/types";

export default {
  provider: "gitlab",
  endpointFamily: "project-deploy-keys",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: {
    kind: "exact",
    value: 0,
    basis: "enumerated",
    scope: "fixture project deploy keys",
  },
  readOnlyCount: 0,
  pushCapableCount: 0,
} satisfies GitLabProjectMetrics["deployKeys"];
