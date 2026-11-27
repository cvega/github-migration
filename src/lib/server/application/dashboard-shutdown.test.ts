import { expect, mock, test } from "bun:test";
import { settleDashboardShutdown } from "./dashboard-shutdown";

test("attempts migration recovery after a rejected profile drain", async () => {
  const recoverMigrations = mock(() => {});
  const status = await settleDashboardShutdown(async () => {
    throw new Error("profile accounting failed");
  }, recoverMigrations);

  expect(recoverMigrations).toHaveBeenCalledTimes(1);
  expect(status).toBe(1);
});

test("reports unsuccessful shutdown when migration recovery throws", async () => {
  const drainProfiles = mock(async () => true);
  const status = await settleDashboardShutdown(drainProfiles, () => {
    throw new Error("migration recovery failed");
  });

  expect(drainProfiles).toHaveBeenCalledTimes(1);
  expect(status).toBe(1);
});

test("recovers migrations after a profile drain timeout and reports success", async () => {
  const recoverMigrations = mock(() => {});
  const status = await settleDashboardShutdown(async () => false, recoverMigrations);

  expect(recoverMigrations).toHaveBeenCalledTimes(1);
  expect(status).toBe(0);
});
