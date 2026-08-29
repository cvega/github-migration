import { describe, expect, test } from "bun:test";
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

describe("profile migration plans", () => {
  test("excludes blockers from the default selection", () => {
    expect(defaultProfilePlanSelection(repos)).toEqual(["acme/clean", "acme/warn"]);
  });

  test("builds an exact, deduplicated selection with risk counts", () => {
    expect(
      buildProfileMigrationPlan({
        profileRunId: "run-1",
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
      sourceProvider: "gitlab",
      sourceApiUrl: "https://code.example.com/api/v4",
      sourceOrg: "platform/services",
      targetOrg: "platform-cloud",
      repos: gitlabRepos,
      selectedRepos: ["platform/services/widget"],
    });

    expect(plan.items).toEqual([{ sourceRepo: "platform/services/widget", targetRepo: "widget" }]);
  });

  test("applies custom target names and rejects collisions", () => {
    const plan = buildProfileMigrationPlan({
      profileRunId: "run-1",
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
        sourceApiUrl: "",
        sourceOrg: "acme",
        targetOrg: "acme-cloud",
        repos,
        selectedRepos: ["acme/blocked"],
      }),
    ).toThrow("Accept the unresolved blockers");
  });
});
