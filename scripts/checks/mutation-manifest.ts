export type MutationRisk = "critical" | "high" | "standard";

export interface MutationLaneDefinition {
  id: string;
  configPath: string;
  sourcePaths: readonly string[];
  testPaths: readonly string[];
  reportDirectory: string;
  risk: MutationRisk;
  expectedTimeouts: number;
  timeoutRationale?: string;
}

export const mutationLanes = [
  {
    id: "capabilities",
    configPath: "tests/mutation/stryker.capabilities.conf.json",
    sourcePaths: [
      "src/lib/server/application/capabilities.ts",
      "src/lib/server/application/setup.ts",
      "src/lib/server/core/targets.ts",
    ],
    testPaths: [
      "src/lib/server/application/capabilities.test.ts",
      "src/lib/server/application/setup.test.ts",
      "src/lib/server/core/targets.test.ts",
    ],
    reportDirectory: "reports/mutation/capabilities",
    risk: "high",
    expectedTimeouts: 0,
  },
  {
    id: "domain",
    configPath: "tests/mutation/stryker.domain.conf.json",
    sourcePaths: [
      "src/lib/migration-state.ts",
      "src/lib/migration-target.ts",
      "src/lib/source-provider.ts",
    ],
    testPaths: [
      "src/lib/migration-state.test.ts",
      "src/lib/migration-target.test.ts",
      "src/lib/source-provider.test.ts",
    ],
    reportDirectory: "reports/mutation/domain",
    risk: "high",
    expectedTimeouts: 0,
  },
  {
    id: "profile-decisions",
    configPath: "tests/mutation/stryker.profile-decisions.conf.json",
    sourcePaths: [
      "src/lib/server/profile/analysis/duration.ts",
      "src/lib/server/profile/analysis/insights.ts",
      "src/lib/server/profile/analysis/overview.ts",
      "src/lib/server/profile/analysis/plan.ts",
      "src/lib/server/profile/analysis/repos.ts",
    ],
    testPaths: [
      "src/lib/server/profile/analysis/duration.test.ts",
      "src/lib/server/profile/analysis/insights.test.ts",
      "src/lib/server/profile/analysis/overview.test.ts",
      "src/lib/server/profile/analysis/plan.test.ts",
      "src/lib/server/profile/analysis/repos.test.ts",
    ],
    reportDirectory: "reports/mutation/profile-decisions",
    risk: "standard",
    expectedTimeouts: 0,
  },
  {
    id: "provider-config",
    configPath: "tests/mutation/stryker.provider-config.conf.json",
    sourcePaths: [
      "src/lib/server/core/source-url.ts",
      "src/lib/server/source/gitlab/config.ts",
      "src/lib/server/source/bitbucket/config.ts",
    ],
    testPaths: [
      "src/lib/server/source/url.test.ts",
      "src/lib/server/source/gitlab/config.test.ts",
      "src/lib/server/source/bitbucket/config.test.ts",
    ],
    reportDirectory: "reports/mutation/provider-config",
    risk: "high",
    expectedTimeouts: 0,
  },
] as const satisfies readonly MutationLaneDefinition[];

export type MutationLaneId = (typeof mutationLanes)[number]["id"];
