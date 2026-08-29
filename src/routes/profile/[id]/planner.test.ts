import { describe, expect, mock, test } from "bun:test";

mock.module("$app/navigation", () => ({ goto: async () => {} }));
(globalThis as unknown as { $state: <Value>(value: Value) => Value }).$state = (value) => value;
const { ProfileMigrationPlannerController } = await import("./planner.svelte");

const repos = [
  { nameWithOwner: "acme/clean", blockers: 0, warnings: 0 },
  { nameWithOwner: "acme/warn", blockers: 0, warnings: 2 },
  { nameWithOwner: "acme/blocked", blockers: 1, warnings: 0 },
];

function plannerFixture() {
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
    getDefaultTargetOrg: () => "acme-cloud",
  });
  return {
    planner,
    setRunId(id: string) {
      run = { ...run, id };
    },
  };
}

describe("ProfileMigrationPlannerController", () => {
  test("defaults to migratable repositories and gates blockers", () => {
    const { planner } = plannerFixture();

    expect(planner.selectedNames).toEqual(["acme/clean", "acme/warn"]);
    expect(planner.selectedWarnings).toBe(1);
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
});
