import { describe, expect, test } from "bun:test";
import type { CreateMigrationRequest } from "$lib/migrate/types";
import { ActiveMigrationRuns } from "./active";

function request(sourceRepo: string): CreateMigrationRequest {
  return {
    sourceRepo,
    targetOrg: "acme-cloud",
    sourceToken: "source-token",
    targetToken: "target-token",
  };
}

describe("active migration run ownership", () => {
  test("claims, attaches, and finishes an active run", () => {
    const runs = new ActiveMigrationRuns();
    const registration = runs.claim("migration-1");
    expect(registration).not.toBeNull();
    if (!registration) throw new Error("run was not claimed");

    expect(runs.attach("migration-1", registration.token, Promise.resolve())).toBe(true);
    expect(runs.isActive("migration-1")).toBe(true);
    expect([...runs.activeIds()]).toEqual(["migration-1"]);
    expect(runs.claim("migration-1")).toBeNull();

    expect(runs.finish("migration-1", registration.token)).toBe(true);
    expect(runs.isActive("migration-1")).toBe(false);
    expect(runs.abort("migration-1")).toBe(false);
  });

  test("rejects stale completion tokens without disturbing a newer run", () => {
    const runs = new ActiveMigrationRuns();
    const stale = runs.claim("migration-1");
    if (!stale) throw new Error("initial run was not claimed");
    expect(runs.finish("migration-1", stale.token)).toBe(true);

    const current = runs.claim("migration-1");
    if (!current) throw new Error("replacement run was not claimed");
    expect(runs.attach("migration-1", stale.token, Promise.resolve())).toBe(false);
    expect(runs.finish("migration-1", stale.token)).toBe(false);
    expect(runs.owns("migration-1", current.token)).toBe(true);
  });

  test("aborts an owned run at most once", () => {
    const runs = new ActiveMigrationRuns();
    const registration = runs.claim("migration-1");
    if (!registration) throw new Error("run was not claimed");

    expect(runs.abort("migration-1")).toBe(true);
    expect(registration.signal.aborted).toBe(true);
    expect(runs.abort("migration-1")).toBe(false);
    expect(runs.claim("recovery", true)?.signal.aborted).toBe(true);
  });
});

describe("queued migration requests", () => {
  test("takes queued credentials exactly once", () => {
    const runs = new ActiveMigrationRuns();
    const queued = request("acme/widget");
    runs.enqueue("migration-1", queued);

    expect(runs.takeQueued("migration-1")).toBe(queued);
    expect(runs.takeQueued("migration-1")).toBeUndefined();
  });

  test("replaces and drops queued requests by migration id", () => {
    const runs = new ActiveMigrationRuns();
    runs.enqueue("migration-1", request("acme/original"));
    runs.enqueue("migration-1", request("acme/replacement"));

    expect(runs.dropQueued("migration-1")).toBe(true);
    expect(runs.dropQueued("migration-1")).toBe(false);
    expect(runs.takeQueued("migration-1")).toBeUndefined();
  });
});
