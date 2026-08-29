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
    id: "bitbucket-pagination",
    configPath: "tests/mutation/stryker.bitbucket-pagination.conf.json",
    sourcePaths: ["src/lib/server/source/bitbucket/client.ts"],
    testPaths: ["src/lib/server/source/bitbucket/client.test.ts"],
    reportDirectory: "reports/mutation/bitbucket-pagination",
    risk: "high",
    expectedTimeouts: 0,
  },
  {
    id: "capabilities",
    configPath: "tests/mutation/stryker.capabilities.conf.json",
    sourcePaths: ["src/lib/server/core/targets.ts", "src/lib/server/core/capability-report.ts"],
    testPaths: [
      "src/lib/server/core/targets.test.ts",
      "src/lib/server/core/capability-report.test.ts",
    ],
    reportDirectory: "reports/mutation/capabilities",
    risk: "high",
    expectedTimeouts: 0,
  },
  {
    id: "contracts",
    configPath: "tests/mutation/stryker.contracts.conf.json",
    sourcePaths: ["src/lib/server/migrate/schemas.ts"],
    testPaths: ["src/lib/server/migrate/schemas.test.ts"],
    reportDirectory: "reports/mutation/contracts",
    risk: "critical",
    expectedTimeouts: 0,
  },
  {
    id: "control",
    configPath: "tests/mutation/stryker.control.conf.json",
    sourcePaths: [
      "src/lib/server/migrate/manager-runtime.ts",
      "src/lib/server/migrate/manager-queue.ts",
      "src/lib/server/migrate/polling.ts",
    ],
    testPaths: [
      "src/lib/server/migrate/manager-runtime.test.ts",
      "src/lib/server/migrate/manager-queue.test.ts",
      "src/lib/server/migrate/polling.test.ts",
    ],
    reportDirectory: "reports/mutation/control",
    risk: "critical",
    expectedTimeouts: 3,
    timeoutRationale: "Loop-control mutations can intentionally prevent terminal progress.",
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
    id: "github-ops",
    configPath: "tests/mutation/stryker.github-ops.conf.json",
    sourcePaths: ["src/lib/server/migrate/github-ops.ts"],
    testPaths: ["src/lib/server/migrate/github-ops.test.ts"],
    reportDirectory: "reports/mutation/github-ops",
    risk: "high",
    expectedTimeouts: 2,
    timeoutRationale: "Retry and pagination mutations can intentionally prevent termination.",
  },
  {
    id: "gitlab-pagination",
    configPath: "tests/mutation/stryker.gitlab-pagination.conf.json",
    sourcePaths: ["src/lib/server/source/gitlab/client.ts"],
    testPaths: ["src/lib/server/source/gitlab/client.test.ts"],
    reportDirectory: "reports/mutation/gitlab-pagination",
    risk: "high",
    expectedTimeouts: 0,
  },
  {
    id: "profile-decisions",
    configPath: "tests/mutation/stryker.profile-decisions.conf.json",
    sourcePaths: [
      "src/lib/server/profile/analyze.ts",
      "src/lib/server/profile/estimate.ts",
      "src/lib/server/profile/summary.ts",
      "src/lib/server/profile/insights.ts",
    ],
    testPaths: [
      "src/lib/server/profile/analyze.test.ts",
      "src/lib/server/profile/estimate.test.ts",
      "src/lib/server/profile/summary.test.ts",
      "src/lib/server/profile/insights.test.ts",
    ],
    reportDirectory: "reports/mutation/profile-decisions",
    risk: "standard",
    expectedTimeouts: 0,
  },
  {
    id: "provider-config",
    configPath: "tests/mutation/stryker.provider-config.conf.json",
    sourcePaths: [
      "src/lib/server/source/url.ts",
      "src/lib/server/source/gitlab/auth.ts",
      "src/lib/server/source/bitbucket/auth.ts",
    ],
    testPaths: [
      "src/lib/server/source/url.test.ts",
      "src/lib/server/source/gitlab/auth.test.ts",
      "src/lib/server/source/bitbucket/auth.test.ts",
    ],
    reportDirectory: "reports/mutation/provider-config",
    risk: "high",
    expectedTimeouts: 0,
  },
  {
    id: "recovery",
    configPath: "tests/mutation/stryker.recovery.conf.json",
    sourcePaths: ["src/lib/server/migrate/manager-recovery.ts"],
    testPaths: ["src/lib/server/migrate/manager-recovery.test.ts"],
    reportDirectory: "reports/mutation/recovery",
    risk: "critical",
    expectedTimeouts: 0,
  },
  {
    id: "security",
    configPath: "tests/mutation/stryker.security.conf.json",
    sourcePaths: ["src/lib/server/core/auth.ts", "src/lib/server/core/validate.ts"],
    testPaths: ["src/lib/server/core/auth.test.ts", "src/lib/server/core/validate.test.ts"],
    reportDirectory: "reports/mutation/security",
    risk: "critical",
    expectedTimeouts: 1,
    timeoutRationale: "A request-validation mutation can retain work until the lane timeout.",
  },
  {
    id: "session",
    configPath: "tests/mutation/stryker.conf.json",
    sourcePaths: ["src/lib/server/core/session.ts"],
    testPaths: ["src/lib/server/core/session.test.ts", "src/lib/server/core/session-creds.test.ts"],
    reportDirectory: "reports/mutation/session",
    risk: "critical",
    expectedTimeouts: 0,
  },
  {
    id: "store-events",
    configPath: "tests/mutation/stryker.store-events.conf.json",
    sourcePaths: ["src/lib/server/migrate/store-events.ts"],
    testPaths: ["src/lib/server/migrate/store-events.test.ts"],
    reportDirectory: "reports/mutation/store-events",
    risk: "high",
    expectedTimeouts: 0,
  },
  {
    id: "store-import-jobs",
    configPath: "tests/mutation/stryker.store-import-jobs.conf.json",
    sourcePaths: ["src/lib/server/migrate/store-import-jobs.ts"],
    testPaths: ["src/lib/server/migrate/store-import-jobs.test.ts"],
    reportDirectory: "reports/mutation/store-import-jobs",
    risk: "high",
    expectedTimeouts: 0,
  },
  {
    id: "store-statistics",
    configPath: "tests/mutation/stryker.store-statistics.conf.json",
    sourcePaths: ["src/lib/server/migrate/store-statistics.ts"],
    testPaths: ["src/lib/server/migrate/store-statistics.test.ts"],
    reportDirectory: "reports/mutation/store-statistics",
    risk: "standard",
    expectedTimeouts: 0,
  },
] as const satisfies readonly MutationLaneDefinition[];

export type MutationLaneId = (typeof mutationLanes)[number]["id"];
