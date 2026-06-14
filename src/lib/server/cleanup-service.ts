/**
 * Guarded target-repo cleanup — the privileged service that actually renames
 * or deletes. This is the ONLY module with destructive capability, and it
 * routes every action through `evaluateCleanupEligibility`: it re-fetches the
 * target's LIVE identity with the admin credential, refuses on anything other
 * than `{ eligible: true }`, and only then acts. Every outcome (refusal or
 * action) is written to the migration's event trail as an audit record.
 */
import { env } from "$env/dynamic/private";
import {
  type CleanupAction,
  type CleanupGateStatus,
  type CleanupRefusalReason,
  describeCleanupGates,
  evaluateCleanupEligibility,
  loadCleanupConfig,
} from "./cleanup";
import { createSingleClient, deleteRepo, getRepoFacts, renameRepo } from "./github";
import { getMigration, insertEvent } from "./migrate/store";

/** GHEC is always the target instance. */
const GHEC_API_URL = "https://api.github.com";

/** An Octokit client as produced by `createSingleClient`. */
type GhClient = ReturnType<typeof createSingleClient>;

/** Build an Octokit authenticated with the dedicated cleanup admin PAT, or null. */
function adminClient(): GhClient | null {
  const token = env.GH_TARGET_ADMIN_PAT;
  if (!token) return null;
  return createSingleClient({ token }, GHEC_API_URL);
}

/** A blank LiveRepoFacts stand-in used when the live repo can't be read. */
const ABSENT_FACTS = { nodeId: "", owner: "", name: "", createdAt: "" };

export interface CleanupPreview {
  migrationId: string;
  action: CleanupAction;
  /** Per-gate status for the confirmation UI checklist. */
  gates: CleanupGateStatus[];
  /** True only if every non-confirmation gate passes (confirmation is typed in the modal). */
  ready: boolean;
  /** The exact string the operator must type to confirm. */
  confirmationPhrase: string;
}

export type CleanupResult =
  | { ok: true; action: CleanupAction; detail: string }
  | {
      ok: false;
      reason: CleanupRefusalReason | "migration-not-found" | "live-fetch-failed";
      detail: string;
    };

/**
 * Read-only preview for the confirmation modal: evaluates every gate against
 * the live repo and reports their status. Performs a GitHub READ only — never
 * renames or deletes. `ready` ignores the confirmation gate (the operator
 * supplies that in the modal).
 */
export async function previewCleanup(
  migrationId: string,
  action: CleanupAction,
): Promise<CleanupPreview | null> {
  const migration = getMigration(migrationId);
  if (!migration) return null;

  const config = loadCleanupConfig();
  const client = adminClient();
  const live = client
    ? ((await getRepoFacts(client, migration.targetOrg, migration.targetRepo)) ?? ABSENT_FACTS)
    : ABSENT_FACTS;

  const confirmationPhrase = `${migration.targetOrg}/${migration.targetRepo}`;
  // Preview with an empty confirmation: the operator hasn't typed yet, so the
  // confirmation gate must show as outstanding (not pre-satisfied). The modal
  // re-evaluates that one gate live against the input box.
  const gates = describeCleanupGates({
    migration,
    live,
    config,
    request: { action, confirmation: "" },
  });
  // `ready` = everything except the operator's typed confirmation is satisfied.
  const ready = gates.every((g) => g.passed || g.reason === "confirmation-mismatch");

  return { migrationId, action, gates, ready, confirmationPhrase };
}

/** Build the "moved aside" name for a rename, bounded to GitHub's 100-char limit. */
function renamedAsideName(repo: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = `-migfailed-${stamp}`;
  return `${repo.slice(0, 100 - suffix.length)}${suffix}`;
}

/** Persist an audit record of a cleanup outcome into the migration's event trail. */
function audit(migrationId: string, message: string): void {
  insertEvent({
    migrationId,
    eventType: "step",
    phase: null,
    payload: { message },
    createdAt: new Date().toISOString(),
  });
}

/**
 * Execute a guarded cleanup. Re-fetches the live repo identity, runs the full
 * gate, and acts ONLY on `{ eligible: true }`. Both refusals and successful
 * actions are audited. Never throws for a refusal — returns a structured result.
 */
export async function executeCleanup(
  migrationId: string,
  action: CleanupAction,
  confirmation: string,
): Promise<CleanupResult> {
  const migration = getMigration(migrationId);
  if (!migration) {
    return { ok: false, reason: "migration-not-found", detail: "Migration not found." };
  }

  const config = loadCleanupConfig();
  const client = adminClient();

  // Re-fetch LIVE identity now — never trust the DB for the act-time check.
  const live = client
    ? await getRepoFacts(client, migration.targetOrg, migration.targetRepo)
    : null;
  if (!client || !live) {
    // Still run the evaluator so the refusal reason is precise and audited.
    const decision = evaluateCleanupEligibility({
      migration,
      live: ABSENT_FACTS,
      config,
      request: { action, confirmation },
    });
    const reason = decision.eligible ? "live-fetch-failed" : decision.reason;
    const detail = decision.eligible
      ? "Could not read the live target repository."
      : decision.detail;
    audit(migration.id, `Cleanup ${action} refused: ${detail}`);
    return { ok: false, reason, detail };
  }

  const decision = evaluateCleanupEligibility({
    migration,
    live,
    config,
    request: { action, confirmation },
  });
  if (!decision.eligible) {
    audit(migration.id, `Cleanup ${action} refused: ${decision.detail}`);
    return { ok: false, reason: decision.reason, detail: decision.detail };
  }

  // ── Eligible: perform the privileged action. ──────────────────────────────
  if (action === "rename") {
    const newName = renamedAsideName(migration.targetRepo);
    const fullName = await renameRepo(client, migration.targetOrg, migration.targetRepo, newName);
    audit(
      migration.id,
      `Cleanup: renamed target ${migration.targetOrg}/${migration.targetRepo} aside to ${fullName} (node_id ${live.nodeId}).`,
    );
    return { ok: true, action, detail: `Renamed to ${fullName}.` };
  }

  await deleteRepo(client, migration.targetOrg, migration.targetRepo);
  audit(
    migration.id,
    `Cleanup: deleted target ${migration.targetOrg}/${migration.targetRepo} (node_id ${live.nodeId}).`,
  );
  return { ok: true, action, detail: `Deleted ${migration.targetOrg}/${migration.targetRepo}.` };
}
