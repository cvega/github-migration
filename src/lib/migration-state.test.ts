import { describe, expect, test } from "bun:test";
import type { MigrationState } from "$lib/migrate/types";
import {
  ACTIVE_MIGRATION_STATES,
  ALL_MIGRATION_STATES,
  CANCELLABLE_MIGRATION_STATES,
  CAPACITY_MIGRATION_STATES,
  EXECUTING_MIGRATION_STATES,
  FINISHED_MIGRATION_STATES,
  isActiveMigrationState,
  isCancellableMigrationState,
  isCapacityMigrationState,
  isExecutingMigrationState,
  isFinishedMigrationState,
  isRestartableMigrationState,
  isTerminalMigrationState,
  migrationStatesSql,
  REPORTED_OUTCOME_MIGRATION_STATES,
  RESTARTABLE_MIGRATION_STATES,
  TERMINAL_MIGRATION_STATES,
} from "./migration-state";

const EXPECTED: Record<
  MigrationState,
  {
    active: boolean;
    terminal: boolean;
    capacity: boolean;
    executing: boolean;
    cancellable: boolean;
    restartable: boolean;
    finished: boolean;
  }
> = {
  queued: {
    active: true,
    terminal: false,
    capacity: false,
    executing: false,
    cancellable: true,
    restartable: false,
    finished: false,
  },
  pending: {
    active: true,
    terminal: false,
    capacity: true,
    executing: true,
    cancellable: true,
    restartable: false,
    finished: false,
  },
  running: {
    active: true,
    terminal: false,
    capacity: true,
    executing: true,
    cancellable: true,
    restartable: false,
    finished: false,
  },
  cancelling: {
    active: true,
    terminal: false,
    capacity: true,
    executing: false,
    cancellable: false,
    restartable: false,
    finished: false,
  },
  succeeded: {
    active: false,
    terminal: true,
    capacity: false,
    executing: false,
    cancellable: false,
    restartable: false,
    finished: true,
  },
  failed: {
    active: false,
    terminal: true,
    capacity: false,
    executing: false,
    cancellable: false,
    restartable: true,
    finished: true,
  },
  cancelled: {
    active: false,
    terminal: true,
    capacity: false,
    executing: false,
    cancellable: false,
    restartable: true,
    finished: true,
  },
  reconciliation_required: {
    active: false,
    terminal: true,
    capacity: false,
    executing: false,
    cancellable: false,
    restartable: false,
    finished: false,
  },
};

describe("migration state classifications", () => {
  test("classifies every MigrationState exhaustively", () => {
    expect(ALL_MIGRATION_STATES).toHaveLength(Object.keys(EXPECTED).length);
    expect(new Set(ALL_MIGRATION_STATES)).toHaveLength(ALL_MIGRATION_STATES.length);
    for (const state of ALL_MIGRATION_STATES) {
      expect({
        active: isActiveMigrationState(state),
        terminal: isTerminalMigrationState(state),
        capacity: isCapacityMigrationState(state),
        executing: isExecutingMigrationState(state),
        cancellable: isCancellableMigrationState(state),
        restartable: isRestartableMigrationState(state),
        finished: isFinishedMigrationState(state),
      }).toEqual(EXPECTED[state]);
    }
  });

  test("exports the canonical state groups", () => {
    expect(ACTIVE_MIGRATION_STATES).toEqual(["queued", "pending", "running", "cancelling"]);
    expect(TERMINAL_MIGRATION_STATES).toEqual([
      "succeeded",
      "failed",
      "cancelled",
      "reconciliation_required",
    ]);
    expect(CAPACITY_MIGRATION_STATES).toEqual(["pending", "running", "cancelling"]);
    expect(EXECUTING_MIGRATION_STATES).toEqual(["pending", "running"]);
    expect(CANCELLABLE_MIGRATION_STATES).toEqual(["queued", "pending", "running"]);
    expect(RESTARTABLE_MIGRATION_STATES).toEqual(["failed", "cancelled"]);
    expect(FINISHED_MIGRATION_STATES).toEqual(["succeeded", "failed", "cancelled"]);
    expect(REPORTED_OUTCOME_MIGRATION_STATES).toEqual(["succeeded", "failed"]);
  });

  test("renders typed state groups as SQL literals", () => {
    expect(migrationStatesSql(RESTARTABLE_MIGRATION_STATES)).toBe("'failed', 'cancelled'");
  });
});
