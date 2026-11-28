import type { GitLabProjectMetrics } from "$lib/source/types";

export default {
  provider: "gitlab",
  endpointFamily: "project-mirrors",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: {
    kind: "exact",
    value: 0,
    basis: "enumerated",
    scope: "fixture project enabled push mirrors",
  },
  hasDisabledPushMirrors: false,
  pullMirror: { kind: "not-mirrored" },
} satisfies GitLabProjectMetrics["mirrors"];
