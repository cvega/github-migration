import type { MigrationState } from "$lib/migrate/types";

export const ALL_MIGRATION_STATES = [
  "queued",
  "pending",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "reconciliation_required",
] as const satisfies readonly MigrationState[];

export const ACTIVE_MIGRATION_STATES = [
  "queued",
  "pending",
  "running",
  "cancelling",
] as const satisfies readonly MigrationState[];

export const TERMINAL_MIGRATION_STATES = [
  "succeeded",
  "failed",
  "cancelled",
  "reconciliation_required",
] as const satisfies readonly MigrationState[];

/** States that consume a GitHub migration slot. Queued work has not started. */
export const CAPACITY_MIGRATION_STATES = [
  "pending",
  "running",
  "cancelling",
] as const satisfies readonly MigrationState[];

/** States whose pipeline can receive a cancellation request. */
export const EXECUTING_MIGRATION_STATES = [
  "pending",
  "running",
] as const satisfies readonly MigrationState[];

export const CANCELLABLE_MIGRATION_STATES = [
  "queued",
  ...EXECUTING_MIGRATION_STATES,
] as const satisfies readonly MigrationState[];

export const RESTARTABLE_MIGRATION_STATES = [
  "failed",
  "cancelled",
] as const satisfies readonly MigrationState[];

/** Resolved terminal outcomes eligible for retention pruning and success-rate totals. */
export const FINISHED_MIGRATION_STATES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly MigrationState[];

/** Outcomes represented in daily success/failure throughput. */
export const REPORTED_OUTCOME_MIGRATION_STATES = [
  "succeeded",
  "failed",
] as const satisfies readonly MigrationState[];

const activeStates = new Set<MigrationState>(ACTIVE_MIGRATION_STATES);
const terminalStates = new Set<MigrationState>(TERMINAL_MIGRATION_STATES);
const capacityStates = new Set<MigrationState>(CAPACITY_MIGRATION_STATES);
const executingStates = new Set<MigrationState>(EXECUTING_MIGRATION_STATES);
const cancellableStates = new Set<MigrationState>(CANCELLABLE_MIGRATION_STATES);
const restartableStates = new Set<MigrationState>(RESTARTABLE_MIGRATION_STATES);
const finishedStates = new Set<MigrationState>(FINISHED_MIGRATION_STATES);

export function isActiveMigrationState(state: MigrationState): boolean {
  return activeStates.has(state);
}

export function isTerminalMigrationState(state: MigrationState): boolean {
  return terminalStates.has(state);
}

export function isCapacityMigrationState(state: MigrationState): boolean {
  return capacityStates.has(state);
}

export function isExecutingMigrationState(state: MigrationState): boolean {
  return executingStates.has(state);
}

export function isCancellableMigrationState(state: MigrationState): boolean {
  return cancellableStates.has(state);
}

export function isRestartableMigrationState(state: MigrationState): boolean {
  return restartableStates.has(state);
}

export function isFinishedMigrationState(state: MigrationState): boolean {
  return finishedStates.has(state);
}

/** Build a SQL literal list from compile-time migration states. */
export function migrationStatesSql(states: readonly MigrationState[]): string {
  return states.map((state) => `'${state}'`).join(", ");
}
