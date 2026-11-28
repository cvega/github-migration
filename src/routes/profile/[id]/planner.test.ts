import { describe, expect, mock, spyOn, test } from "bun:test";
import { MAX_PROFILE_PLAN_REPOS } from "$lib/profile/migration-plan";

mock.module("$app/navigation", () => ({ goto: async () => {} }));
(globalThis as unknown as { $state: <Value>(value: Value) => Value }).$state = (value) => value;
const { ProfileMigrationPlannerController } = await import("./planner.svelte");

const repos = [
  { nameWithOwner: "acme/clean", blockers: 0, warnings: 0 },
  { nameWithOwner: "acme/warn", blockers: 0, warnings: 2 },
  { nameWithOwner: "acme/blocked", blockers: 1, warnings: 0 },
];

function plannerFixture(eligible = repos.map((repo) => repo.nameWithOwner)) {
  let run = {
    id: "run-1",
    org: "acme",
    sourceProvider: "github",
    sourceApiUrl: "https://api.github.com",
  };
  const planner = new ProfileMigrationPlannerController({
    getRun: () => run as never,
    getRepos: () => repos as never,
    getPlanningRepos: () => repos as never,
    getTargetNameExceptions: () => ({}),
    getDefaultTargetOrg: () => "acme-cloud",
    getTargets: () => [
      {
        id: "ghec",
        platform: "ghec",
        organizations: [],
        apiUrl: "https://api.github.com",
        webUrl: "https://github.com",
        displayName: "Cloud",
      },
    ],
    isRepoEligible: (name) => eligible.includes(name),
  });
  return {
    planner,
    setRunId(id: string) {
      run = { ...run, id };
    },
  };
}

describe("ProfileMigrationPlannerController", () => {
  test("keeps displayed and submitted names stable across filtered pages beyond the catalog cap", async () => {
    const first = { nameWithOwner: "acme/a/widget", warnings: 0, blockers: 0 };
    const last = { ...first, nameWithOwner: "acme/z/widget" };
    const catalog = [
      first,
      ...Array.from({ length: MAX_PROFILE_PLAN_REPOS - 1 }, (_, i) => ({
        ...first,
        nameWithOwner: `acme/b/repo-${i}`,
      })),
    ];
    let page = [first];
    const planner = new ProfileMigrationPlannerController({
      getRun: () => ({ id: "run", org: "acme", sourceProvider: "gitlab" }) as never,
      getRepos: () => page as never,
      getPlanningRepos: () => catalog,
      getTargetNameExceptions: () => ({
        [first.nameWithOwner]: "a-widget",
        [last.nameWithOwner]: "z-widget",
      }),
      getDefaultTargetOrg: () => "target",
      getTargets: () => [
        {
          id: "cloud",
          platform: "ghec",
          organizations: [],
          apiUrl: "",
          webUrl: "",
          displayName: "Cloud",
        },
      ],
    });
    planner.setTargetProfileId("cloud");
    planner.setTargetOrg("target");
    planner.selectFiltered(true);
    expect(planner.targetNameFor(first.nameWithOwner)).toBe("a-widget");
    page = [last];
    planner.toggleSelection(last.nameWithOwner);
    expect(planner.targetNameFor(first.nameWithOwner)).toBe("a-widget");
    expect(planner.targetNameFor(last.nameWithOwner)).toBe("z-widget");
    planner.setTargetName(last.nameWithOwner, "A-widget");
    expect(planner.targetNameError).toContain("used more than once");
    planner.setTargetName(last.nameWithOwner, "custom");
    page = [first];
    planner.selectFiltered(true);
    const post = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "batch" }));
    try {
      await planner.launchBatch();
      expect(JSON.parse(String(post.mock.lastCall?.[1]?.body)).items).toEqual([
        { sourceRepo: first.nameWithOwner, targetRepo: "a-widget" },
      ]);
      page = [last];
      planner.selectFiltered(true);
      expect(planner.targetNameFor(last.nameWithOwner)).toBe("custom");
    } finally {
      post.mockRestore();
    }
  });
  test("operator launches selected subgroup leaves without destination or source overrides", async () => {
    const planner = new ProfileMigrationPlannerController({
      getRun: () =>
        ({
          id: "profile",
          org: "group/sub",
          sourceProvider: "gitlab",
          sourceApiUrl: "https://gitlab.example/api/v4",
        }) as never,
      getRepos: () => [],
      getTargetNameExceptions: () => undefined,
      getPlanningRepos: () =>
        ["one", "two"].map((name) => ({
          nameWithOwner: `group/sub/${name}`,
          blockers: 0,
          warnings: 0,
        })),
      getDefaultTargetOrg: () => "",
      getTargets: () => [],
      getAssignments: () => [
        { id: "grant-a", targetOrg: "assigned", targetProfileId: "ghec", canMigrate: true },
      ],
    });
    const post = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "batch" }));
    try {
      planner.toggleSelection("group/sub/two");
      await planner.launchBatch();
      expect(post.mock.lastCall?.[0]).toBe("/api/profile/profile");
      expect(JSON.parse(String(post.mock.lastCall?.[1]?.body))).toEqual({
        grantId: "grant-a",
        repos: ["two"],
      });
    } finally {
      post.mockRestore();
    }
  });
  test("submits the chosen Bitbucket destination without falling back to cloud", async () => {
    const planner = new ProfileMigrationPlannerController({
      getRun: () =>
        ({
          id: "bb",
          org: "PROF01",
          sourceProvider: "bitbucket-server",
          sourceApiUrl: "https://bb.example/rest/api/1.0",
        }) as never,
      getRepos: () => [],
      getPlanningRepos: () => [{ nameWithOwner: "PROF01/service-01", blockers: 0, warnings: 0 }],
      getTargetNameExceptions: () => ({}),
      getDefaultTargetOrg: () => "",
      getTargets: () =>
        ["ghec", "ghes"].map((platform) => ({
          id: platform === "ghes" ? "enterprise" : "ghec",
          platform: platform as "ghec" | "ghes",
          organizations: [],
          apiUrl: "",
          webUrl: "",
          displayName: platform,
        })),
    });
    const post = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "batch" }));
    try {
      await planner.launchBatch();
      expect(post).not.toHaveBeenCalled();
      for (const id of ["enterprise", "ghec"]) {
        planner.setTargetProfileId(id);
        planner.setTargetOrg("target");
        await planner.launchBatch();
        expect(JSON.parse(String(post.mock.lastCall?.[1]?.body))).toMatchObject({
          sourceProvider: "bitbucket-server",
          targetProfileId: id,
        });
      }
    } finally {
      post.mockRestore();
    }
  });
  test("defaults to migratable repositories and gates blockers", () => {
    const { planner } = plannerFixture();

    expect(planner.selectedNames).toEqual(["acme/clean", "acme/warn"]);
    expect(planner.selectedWarnings).toBe(1);
    expect(planner.submitDisabled).toBe(true);
    planner.setTargetProfileId("ghec");
    planner.setTargetOrg("acme-cloud");
    expect(planner.submitDisabled).toBe(false);

    planner.toggleSelection("acme/blocked");
    expect(planner.selectedBlockers).toBe(1);
    expect(planner.submitDisabled).toBe(true);

    planner.setBlockersAccepted(true);
    expect(planner.submitDisabled).toBe(false);
  });

  test("validates target names and resets overrides for a new run", () => {
    const { planner, setRunId } = plannerFixture();

    planner.setTargetName("acme/clean", "shared");
    planner.setTargetName("acme/warn", "SHARED");
    planner.setTargetOrg("custom-target");
    expect(planner.targetNameError).toBe("Target repository SHARED is used more than once.");
    expect(planner.targetOrg).toBe("custom-target");

    setRunId("run-2");
    expect(planner.targetNameError).toBe("");
    expect(planner.targetNameFor("acme/clean")).toBe("clean");
    expect(planner.targetOrg).toBe("acme-cloud");
  });

  test("keeps ineligible repositories out of selection", () => {
    const { planner } = plannerFixture(["acme/clean"]);

    expect(planner.selectedNames).toEqual(["acme/clean"]);
    planner.toggleSelection("acme/warn");
    expect(planner.selectedNames).toEqual(["acme/clean"]);
    expect(planner.planError).toContain("Complete Git analysis");

    planner.selectFiltered(true);
    expect(planner.selectedNames).toEqual(["acme/clean"]);
  });
});
