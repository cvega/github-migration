import { describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import { resumeBitbucketToGhecMigration, runBitbucketToGhecMigration } from "./bitbucket-to-ghec";
import { resumeBitbucketToGhesMigration, runBitbucketToGhesMigration } from "./bitbucket-to-ghes";
import { resumeGitHubToGhecMigration, runGitHubToGhecMigration } from "./github-to-ghec";
import { resumeGitLabToGhecMigration, runGitLabToGhecMigration } from "./gitlab-to-ghec";
import { getExecutorForMigration, getRegisteredMigrationExecutor } from "./registry";

describe("migration executor registry", () => {
  test.each([
    ["github", "ghec", runGitHubToGhecMigration, resumeGitHubToGhecMigration],
    ["gitlab", "ghec", runGitLabToGhecMigration, resumeGitLabToGhecMigration],
    ["bitbucket-server", "ghec", runBitbucketToGhecMigration, resumeBitbucketToGhecMigration],
    ["bitbucket-server", "ghes", runBitbucketToGhesMigration, resumeBitbucketToGhesMigration],
  ] as const)(
    "dispatches %s -> %s without crossing providers",
    (sourceProvider, targetPlatform, run, resume) => {
      const route = {
        sourceProvider,
        targetPlatform,
        targetProfileId: targetPlatform,
        targetApiUrl: "https://api.github.com",
      };
      for (const executor of [
        getRegisteredMigrationExecutor(route),
        getExecutorForMigration(route as Migration),
      ]) {
        expect(executor.run).toBe(run);
        expect(executor.resume).toBe(resume);
      }
    },
  );

  test("defaults an omitted route to GitHub cloud", () => {
    expect(getRegisteredMigrationExecutor({}).run).toBe(runGitHubToGhecMigration);
    expect(getRegisteredMigrationExecutor({}).resume).toBe(resumeGitHubToGhecMigration);
  });

  test.each(["github", "gitlab"] as const)("rejects %s to GHES", (sourceProvider) => {
    expect(() =>
      getRegisteredMigrationExecutor({ sourceProvider, targetPlatform: "ghes" }),
    ).toThrow();
  });
});
