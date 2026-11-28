import { describe, expect, test } from "bun:test";
import type { SourceProvider } from "$lib/source/types";
import {
  buildProfileMigrationPlan,
  defaultProfilePlanSelection,
  MAX_PROFILE_PLAN_REPOS,
} from "./migration-plan";

const repos = [
  { nameWithOwner: "acme/clean", blockers: 0, warnings: 0 },
  { nameWithOwner: "acme/warn", blockers: 0, warnings: 2 },
  { nameWithOwner: "acme/blocked", blockers: 1, warnings: 0 },
];

function targetNamesFor(
  sourceProvider: SourceProvider,
  sourceOrg: string,
  paths: string[],
  selectedRepos = paths,
) {
  return Object.fromEntries(
    buildProfileMigrationPlan({
      profileRunId: "inventory",
      targetProfileId: "ghec",
      sourceProvider,
      sourceApiUrl: "",
      sourceOrg,
      targetOrg: "acme-cloud",
      repos: paths.map((nameWithOwner) => ({ nameWithOwner, blockers: 0, warnings: 0 })),
      selectedRepos,
    }).items.map(({ sourceRepo, targetRepo }) => [sourceRepo, targetRepo]),
  );
}

describe("profile migration plans", () => {
  test("excludes blockers from the default selection", () => {
    expect(defaultProfilePlanSelection(repos)).toEqual(["acme/clean", "acme/warn"]);
  });

  test("builds an exact, deduplicated selection with risk counts", () => {
    expect(
      buildProfileMigrationPlan({
        profileRunId: "run-1",
        targetProfileId: "ghec",
        sourceApiUrl: "https://api.github.com",
        sourceOrg: "acme",
        targetOrg: "acme-cloud",
        repos,
        selectedRepos: ["acme/blocked", "acme/warn", "acme/blocked"],
        acceptBlockers: true,
        nowMs: Date.parse("2026-08-07T12:00:00Z"),
      }),
    ).toEqual({
      version: 3,
      profileRunId: "run-1",
      targetProfileId: "ghec",
      sourceProvider: "github",
      sourceApiUrl: "https://api.github.com",
      sourceOrg: "acme",
      targetOrg: "acme-cloud",
      items: [
        { sourceRepo: "acme/blocked", targetRepo: "blocked" },
        { sourceRepo: "acme/warn", targetRepo: "warn" },
      ],
      reposWithBlockers: 1,
      reposWithWarnings: 1,
      blockersAcceptedAt: "2026-08-07T12:00:00.000Z",
      createdAt: "2026-08-07T12:00:00.000Z",
    });
  });

  test("rejects empty, foreign, and oversized selections", () => {
    expect(() =>
      buildProfileMigrationPlan({
        profileRunId: "run-1",
        targetProfileId: "ghec",
        sourceApiUrl: "",
        sourceOrg: "acme",
        targetOrg: "acme-cloud",
        repos,
        selectedRepos: [],
      }),
    ).toThrow("Select at least one");
    expect(() =>
      buildProfileMigrationPlan({
        profileRunId: "run-1",
        targetProfileId: "ghec",
        sourceApiUrl: "",
        sourceOrg: "acme",
        targetOrg: "acme-cloud",
        repos,
        selectedRepos: ["other/repo"],
      }),
    ).toThrow("not part of this profile run");
    const many = Array.from({ length: MAX_PROFILE_PLAN_REPOS + 1 }, (_, index) => ({
      nameWithOwner: `acme/repo-${index}`,
      blockers: 0,
      warnings: 0,
    }));
    expect(() =>
      buildProfileMigrationPlan({
        profileRunId: "run-1",
        targetProfileId: "ghec",
        sourceApiUrl: "",
        sourceOrg: "acme",
        targetOrg: "acme-cloud",
        repos: many,
        selectedRepos: many.map((repo) => repo.nameWithOwner),
      }),
    ).toThrow("at most 500");
  });

  test("preserves nested GitLab project paths", () => {
    const gitlabRepos = [{ nameWithOwner: "platform/services/widget", blockers: 0, warnings: 0 }];
    const plan = buildProfileMigrationPlan({
      profileRunId: "gitlab-run",
      targetProfileId: "ghec",
      sourceProvider: "gitlab",
      sourceApiUrl: "https://code.example.com/api/v4",
      sourceOrg: "platform/services",
      targetOrg: "platform-cloud",
      repos: gitlabRepos,
      selectedRepos: ["platform/services/widget"],
    });

    expect(plan.items).toEqual([{ sourceRepo: "platform/services/widget", targetRepo: "widget" }]);
  });

  test("qualifies colliding GitLab leaves relative to the profiled namespace", () => {
    expect(
      targetNamesFor("gitlab", "acme/migrate", [
        "acme/migrate/prof01/service-01",
        "acme/migrate/prof02/tools/SERVICE-01",
        "acme/migrate/unrelated",
      ]),
    ).toEqual({
      "acme/migrate/prof01/service-01": "prof01-service-01",
      "acme/migrate/prof02/tools/SERVICE-01": "prof02-tools-SERVICE-01",
      "acme/migrate/unrelated": "unrelated",
    });
  });

  test("reserves plain names and resolves sanitization and truncation collisions deterministically", () => {
    const prefix = "x".repeat(100);
    const paths = [
      "migrate/a+b/service",
      "migrate/a-b/service",
      "migrate/a-b-service",
      `migrate/${prefix}a/worker`,
      `migrate/${prefix}b/worker`,
      "migrate/only+one",
    ];
    const names = targetNamesFor("gitlab", "migrate", paths);
    expect(names).toEqual({
      [paths[0]!]: "a-b-service-2",
      [paths[1]!]: "a-b-service-3",
      [paths[2]!]: "a-b-service",
      [paths[3]!]: prefix,
      [paths[4]!]: `${prefix.slice(0, 98)}-2`,
      [paths[5]!]: "only-one",
    });
    expect(targetNamesFor("gitlab", "migrate", [...paths].reverse())).toEqual(names);
    for (const [path, name] of Object.entries(names)) {
      expect(targetNamesFor("gitlab", "migrate", paths, [path])).toEqual({ [path]: name });
    }
  });

  test("avoids a trailing .git even after truncation and namespace qualification", () => {
    const long = "x".repeat(96);
    const paths = [
      "migrate/.git",
      "migrate/sub/service.GIT",
      "migrate/other/service.git",
      `migrate/${long}.gIt-extra`,
      "migrate/keep.git-tools",
    ];
    const names = targetNamesFor("gitlab", "migrate", paths);
    expect(names[paths[4]!]).toBe("keep.git-tools");
    for (const name of Object.values(names)) {
      expect(name).toMatch(/^[a-zA-Z0-9._-]{1,100}$/);
      expect(name).not.toMatch(/\.git$/i);
    }
    expect(new Set(Object.values(names).map((name) => name.toLowerCase())).size).toBe(paths.length);
  });

  test("keeps a unique valid leaf when another leaf sanitizes to the same name", () => {
    const paths = ["migrate/a/only+one", "migrate/b/Only-One"];
    expect(targetNamesFor("gitlab", "migrate", paths)).toEqual({
      [paths[0]!]: "a-only-one",
      [paths[1]!]: "Only-One",
    });
  });

  test("disambiguates Bitbucket slugs from different project keys", () => {
    const paths = ["PROF01/service", "PROF02/service"];
    expect(targetNamesFor("bitbucket-server", "PROF01", paths)).toEqual({
      "PROF01/service": "service",
      "PROF02/service": "PROF02-service",
    });
    expect(targetNamesFor("bitbucket-server", "PROF01", paths, paths.slice(1))).toEqual({
      "PROF02/service": "PROF02-service",
    });
  });

  test("applies custom target names and rejects collisions", () => {
    const plan = buildProfileMigrationPlan({
      profileRunId: "run-1",
      targetProfileId: "ghec",
      sourceApiUrl: "",
      sourceOrg: "acme",
      targetOrg: "acme-cloud",
      repos,
      selectedRepos: ["acme/clean", "acme/warn"],
      targetNames: { "acme/clean": "renamed", "acme/warn": "warning-repo" },
    });
    expect(plan.items).toEqual([
      { sourceRepo: "acme/clean", targetRepo: "renamed" },
      { sourceRepo: "acme/warn", targetRepo: "warning-repo" },
    ]);
    expect(() =>
      buildProfileMigrationPlan({
        profileRunId: "run-1",
        targetProfileId: "ghec",
        sourceApiUrl: "",
        sourceOrg: "acme",
        targetOrg: "acme-cloud",
        repos,
        selectedRepos: ["acme/clean", "acme/warn"],
        targetNames: { "acme/clean": "same", "acme/warn": "SAME" },
      }),
    ).toThrow("used more than once");
  });

  test("requires explicit acceptance when blocked repositories are selected", () => {
    expect(() =>
      buildProfileMigrationPlan({
        profileRunId: "run-1",
        targetProfileId: "ghec",
        sourceApiUrl: "",
        sourceOrg: "acme",
        targetOrg: "acme-cloud",
        repos,
        selectedRepos: ["acme/blocked"],
      }),
    ).toThrow("Accept the unresolved blockers");
  });
});
