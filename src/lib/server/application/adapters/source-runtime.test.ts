import { expect, test } from "bun:test";
import {
  __setBitbucketToGhecDependenciesForTests,
  runBitbucketToGhecMigration,
} from "$lib/server/migrate/executors/bitbucket-to-ghec";
import {
  __setGitLabToGhecDependenciesForTests,
  runGitLabToGhecMigration,
} from "$lib/server/migrate/executors/gitlab-to-ghec";
import { BitbucketServerClient } from "$lib/server/source/bitbucket/client";
import { GitLabClient } from "$lib/server/source/gitlab/client";

test.each([
  ["gitlab", 502, "reconciliation_required"],
  ["gitlab", 403, "failed"],
  ["bitbucket-server", 504, "reconciliation_required"],
  ["bitbucket-server", 200, "reconciliation_required"],
  ["bitbucket-server", 403, "failed"],
] as const)(
  "classifies %s export response %i without resubmission",
  async (sourceProvider, status, state) => {
    let submissions = 0;
    const fetch = async () => {
      submissions++;
      return Response.json({}, { status });
    };
    const shared = {
      resolveTargetAuth: () => ({ token: "fixture" }),
      doesOrgExist: async () => true,
      doesRepoExist: async () => false,
      updateCheckpoint: () => {},
    };
    const gitlab = sourceProvider === "gitlab";
    const restore = gitlab
      ? __setGitLabToGhecDependenciesForTests({
          ...shared,
          getSourceClient: () =>
            new GitLabClient({ baseUrl: "https://gitlab.invalid", token: "fixture", fetch }),
        })
      : __setBitbucketToGhecDependenciesForTests({
          ...shared,
          getSourceClient: () =>
            new BitbucketServerClient({
              baseUrl: "https://bitbucket.invalid",
              username: "fixture",
              password: "fixture",
              fetch,
            }),
        });
    try {
      const run = gitlab ? runGitLabToGhecMigration : runBitbucketToGhecMigration;
      const result = await run({
        sourceProvider,
        sourceRepo: gitlab ? "group/project" : "PROJ/repo",
        targetOrg: "cloud",
        emit: () => {},
      });
      expect(result).toMatchObject({ state, githubMigrationId: null });
      expect(submissions).toBe(1);
    } finally {
      restore();
    }
  },
);
