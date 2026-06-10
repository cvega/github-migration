/**
 * Guarded target-repo cleanup — configuration and the pure eligibility
 * evaluator.
 *
 * This module decides *whether* a failed/cancelled migration's target repo may
 * be cleaned up (renamed aside or deleted). It performs NO GitHub calls and NO
 * database writes — it is a pure decision function plus config loading, so the
 * full refusal matrix is exhaustively unit-testable. The actual rename/delete
 * (Phase 2b) is a separate module that MUST call `evaluateCleanupEligibility`
 * and refuse on anything other than `{ eligible: true }`.
 *
 * Safety model — cleanup is permitted only when EVERY vector passes:
 *   1. Not globally disabled (TARGET_CLEANUP_DISABLED kill switch).
 *   2. The requested action is permitted by TARGET_CLEANUP mode.
 *   3. An admin credential is configured (GH_TARGET_ADMIN_PAT present).
 *   4. The migration is in a terminal non-success state (failed | cancelled).
 *   5. The target did NOT pre-exist (this tool created it).
 *   6. A node_id was captured for the repo we created.
 *   7. The LIVE repo's node_id still equals the captured one (immutable
 *      identity — survives rename, dies on delete+recreate).
 *   8. The live repo's owner/name still match the migration record.
 *   9. The live repo's created_at falls within the migration's run window
 *      (temporal corroboration of authorship).
 *  10. The caller's typed confirmation matches `owner/repo` exactly.
 *
 * A repo we can't prove we created — on ANY vector — is never touched.
 */
import { env } from "$env/dynamic/private";
import type { Migration } from "$lib/types";

/** What kind of cleanup an operator has enabled. `delete` implies `rename`. */
export type CleanupMode = "off" | "rename" | "delete";

/** A single cleanup action a caller may request. */
export type CleanupAction = "rename" | "delete";

export interface CleanupConfig {
  /**
   * Hard kill switch. When true, cleanup is force-disabled regardless of every
   * other setting — intended for org-level policy that an app operator cannot
   * override. Checked first.
   */
  disabled: boolean;
  /** Operator opt-in level. `off` unless explicitly enabled. */
  mode: CleanupMode;
  /** Whether a dedicated admin credential is configured for the privileged call. */
  hasAdminCredential: boolean;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function parseMode(value: string | undefined): CleanupMode {
  if (value === "rename" || value === "delete") return value;
  return "off";
}

/**
 * Read cleanup configuration from the environment. Safe by default: disabled
 * unless `TARGET_CLEANUP` is explicitly `rename`/`delete`, an admin credential
 * is present, and the kill switch is not set.
 */
export function loadCleanupConfig(): CleanupConfig {
  return {
    disabled: bool(env.TARGET_CLEANUP_DISABLED, false),
    mode: parseMode(env.TARGET_CLEANUP),
    hasAdminCredential: !!env.GH_TARGET_ADMIN_PAT,
  };
}

/** Whether `mode` permits `action`. `delete` mode permits both; `rename` only rename. */
export function modePermits(mode: CleanupMode, action: CleanupAction): boolean {
  if (mode === "delete") return true;
  if (mode === "rename") return action === "rename";
  return false;
}

/** Live facts about the target repo, fetched at cleanup time (not trusted from the DB). */
export interface LiveRepoFacts {
  nodeId: string;
  owner: string;
  name: string;
  /** ISO 8601 creation timestamp from the GitHub API. */
  createdAt: string;
}

export interface CleanupRequest {
  action: CleanupAction;
  /** The caller-typed confirmation string; must equal `owner/repo`. */
  confirmation: string;
}

/** Machine-readable refusal reasons — one per vector, for precise UI + tests. */
export type CleanupRefusalReason =
  | "globally-disabled"
  | "mode-disallows-action"
  | "no-admin-credential"
  | "migration-not-terminal"
  | "target-preexisted"
  | "no-recorded-node-id"
  | "node-id-mismatch"
  | "owner-name-mismatch"
  | "created-outside-window"
  | "confirmation-mismatch";

export type CleanupEligibility =
  | { eligible: true }
  | { eligible: false; reason: CleanupRefusalReason; detail: string };

/** States in which a migration's target may be considered for cleanup. */
const TERMINAL_STATES = new Set<Migration["state"]>(["failed", "cancelled"]);

/**
 * Tolerance applied to the migration run window when checking the repo's
 * createdAt. Clock skew between GitHub and this host, plus the gap between our
 * preflight and GHEC actually creating the repo, mean an exact bound would
 * produce false refusals. 10 minutes is comfortably larger than either.
 */
const WINDOW_TOLERANCE_MS = 10 * 60_000;

/**
 * Decide whether a cleanup request may proceed. Pure: no GitHub calls, no DB
 * writes. The caller supplies the migration record, the LIVE repo facts
 * (re-fetched now), the resolved config, and the request. Returns the first
 * failing vector so the reason is specific and the order is deterministic.
 */
export function evaluateCleanupEligibility(args: {
  migration: Migration;
  live: LiveRepoFacts;
  config: CleanupConfig;
  request: CleanupRequest;
}): CleanupEligibility {
  const { migration, live, config, request } = args;

  // 1. Hard kill switch — checked first, overrides everything.
  if (config.disabled) {
    return {
      eligible: false,
      reason: "globally-disabled",
      detail: "Target cleanup is disabled by policy (TARGET_CLEANUP_DISABLED).",
    };
  }

  // 2. Mode must permit this specific action.
  if (!modePermits(config.mode, request.action)) {
    return {
      eligible: false,
      reason: "mode-disallows-action",
      detail: `Cleanup mode "${config.mode}" does not permit action "${request.action}".`,
    };
  }

  // 3. A dedicated admin credential must be configured for the privileged call.
  if (!config.hasAdminCredential) {
    return {
      eligible: false,
      reason: "no-admin-credential",
      detail: "No admin credential configured (GH_TARGET_ADMIN_PAT).",
    };
  }

  // 4. Only terminal, non-success migrations are eligible (never succeeded).
  if (!TERMINAL_STATES.has(migration.state)) {
    return {
      eligible: false,
      reason: "migration-not-terminal",
      detail: `Migration state "${migration.state}" is not eligible; must be failed or cancelled.`,
    };
  }

  // 5. The target must not have pre-existed — i.e. this tool created it.
  if (migration.targetPreexisted !== false) {
    return {
      eligible: false,
      reason: "target-preexisted",
      detail:
        migration.targetPreexisted === true
          ? "Target repo existed before this migration; it is not ours to clean up."
          : "Target provenance is unknown; refusing to act.",
    };
  }

  // 6. We must have captured the node_id of the repo we created.
  if (!migration.targetRepoNodeId) {
    return {
      eligible: false,
      reason: "no-recorded-node-id",
      detail: "No target repo node_id was recorded; cannot prove identity.",
    };
  }

  // 7. Immutable identity: the live node_id must still match the captured one.
  if (live.nodeId !== migration.targetRepoNodeId) {
    return {
      eligible: false,
      reason: "node-id-mismatch",
      detail:
        "The repository at this path is not the one this tool created " +
        "(node_id changed — likely deleted and recreated). Refusing to act.",
    };
  }

  // 8. Owner/name must still match the migration record (defense in depth).
  if (live.owner !== migration.targetOrg || live.name !== migration.targetRepo) {
    return {
      eligible: false,
      reason: "owner-name-mismatch",
      detail: `Live repo ${live.owner}/${live.name} no longer matches record ${migration.targetOrg}/${migration.targetRepo}.`,
    };
  }

  // 9. Temporal corroboration: the repo must have been created during the run.
  const createdMs = Date.parse(live.createdAt);
  const startMs = Date.parse(migration.startedAt);
  const endMs = migration.completedAt ? Date.parse(migration.completedAt) : Date.now();
  if (!Number.isFinite(createdMs) || !Number.isFinite(startMs)) {
    return {
      eligible: false,
      reason: "created-outside-window",
      detail: "Could not parse repo creation or migration start time.",
    };
  }
  if (createdMs < startMs - WINDOW_TOLERANCE_MS || createdMs > endMs + WINDOW_TOLERANCE_MS) {
    return {
      eligible: false,
      reason: "created-outside-window",
      detail:
        "Target repo's creation time falls outside this migration's run window; " +
        "it may be a different repository. Refusing to act.",
    };
  }

  // 10. Explicit typed confirmation must match exactly.
  if (request.confirmation !== `${migration.targetOrg}/${migration.targetRepo}`) {
    return {
      eligible: false,
      reason: "confirmation-mismatch",
      detail: "Confirmation text does not match the target repository.",
    };
  }

  return { eligible: true };
}
