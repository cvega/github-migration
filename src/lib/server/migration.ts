/**
 * Migration pipeline orchestrator.
 * Port of pkg/migration/runner.go — runs the full migration lifecycle:
 *   preflight → resolveArchives → startMigration → monitor
 *
 * Emits MigrationEvents via a callback so the manager can persist them
 * in SQLite and broadcast via SSE.
 */
// bun:sqlite built-in UUIDv7 — time-sortable, zero deps

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "$env/dynamic/private";
import type { AuthMode, CreateMigrationRequest, Migration } from "$lib/types";
import {
  isSourceAppConfigured,
  isSourceAuthAvailable,
  isTargetAppConfigured,
  isTargetAuthAvailable,
  resolveSourceAuth,
  resolveTargetAuth,
} from "./auth";
import {
  abortMigration,
  archiveRepository,
  checkGhesVersion,
  createClients,
  createMigrationSource,
  doesOrgExist,
  doesRepoExist,
  type GitHubClients,
  getOrgDatabaseId,
  getOrgId,
  getRepoCounts,
  getRepoNodeId,
  getRepoSize,
  startMigration as ghecStartMigration,
  isGhecSource,
  sourceBaseUrl,
  startGitArchiveExport,
  startMetadataArchiveExport,
  waitForArchive,
} from "./github";
import { type EventEmitter, runMonitor } from "./monitor";
import { updateCheckpoint, updateMigrationProvenance, updateMigrationSourceSize } from "./store";
import { uploadArchive } from "./upload";
import { extractOrg, extractRepo } from "./util";

export interface MigrationPipelineOpts extends CreateMigrationRequest {
  id?: string;
  signal?: AbortSignal;
  emit: EventEmitter;
}

/**
 * Run the full migration pipeline. Returns the completed Migration record.
 * Throws on unrecoverable errors.
 */
export async function runMigrationPipeline(opts: MigrationPipelineOpts): Promise<Migration> {
  const migrationId = opts.id ?? Bun.randomUUIDv7();
  const startedAt = new Date().toISOString();
  const emit = opts.emit;

  const migration: Migration = {
    id: migrationId,
    batchId: null,
    githubMigrationId: null,
    sourceApiUrl: opts.sourceApiUrl || "https://api.github.com",
    sourceOrg: extractOrg(opts.sourceRepo),
    sourceRepo: extractRepo(opts.sourceRepo),
    targetOrg: opts.targetOrg,
    targetRepo: opts.targetRepo || extractRepo(opts.sourceRepo),
    state: "running",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt,
    completedAt: null,
    elapsedSeconds: null,
    authMode: null,
    requestOptions: null,
    targetPreexisted: null,
    targetRepoNodeId: null,
  };

  const emitStep = (message: string) => {
    emit({
      migrationId,
      eventType: "step",
      phase: null,
      payload: { message },
      createdAt: new Date().toISOString(),
    });
  };

  try {
    // Resolve auth — credentials (not pre-resolved tokens) so Octokit
    // can auto-refresh GitHub App installation tokens during long migrations.
    const sourceAuth = resolveSourceAuth(opts.sourceToken, opts.sourceApp);
    const targetAuth = resolveTargetAuth(opts.targetToken, opts.targetApp);

    // Determine auth mode for crash recovery eligibility.
    const authMode: AuthMode = determineAuthMode(opts);

    // Build clients — when using GitHub App auth, the underlying Octokit
    // instances use createAppAuth as their auth strategy, automatically
    // refreshing installation tokens before they expire.
    const clients = createClients({
      sourceApiUrl: migration.sourceApiUrl,
      sourceAuth,
      targetAuth,
      noSslVerify: opts.noSslVerify,
    });

    emitStep(
      `Starting migration: ${migration.sourceOrg}/${migration.sourceRepo} → ${migration.targetOrg}/${migration.targetRepo}`,
    );

    // ── Step 1: Preflight ──────────────────────────────────────────
    updateCheckpoint(migrationId, "preflight", { authMode });
    await preflight(clients, migration, opts, emitStep);

    // Fetch source counts.
    try {
      migration.sourceCounts = await getRepoCounts(
        clients.source,
        clients.sourceGraphql,
        migration.sourceOrg,
        migration.sourceRepo,
      );
    } catch {
      // Non-fatal
    }

    // Fetch source repo disk size (KB) — used for display and the stall
    // watchdog's "large repo" guard. Non-fatal if unavailable.
    try {
      const sizeKb = await getRepoSize(clients.source, migration.sourceOrg, migration.sourceRepo);
      if (sizeKb != null) {
        migration.sourceSizeKb = sizeKb;
        updateMigrationSourceSize(migrationId, sizeKb);
      }
    } catch {
      // Non-fatal
    }

    // ── Step 2+3: Resolve archives ─────────────────────────────────
    updateCheckpoint(migrationId, "archiving");
    const { gitArchiveUrl, metadataArchiveUrl } = await resolveArchives(
      clients,
      migration,
      opts,
      emitStep,
    );

    // ── Step 4: Start migration on GHEC ────────────────────────────
    updateCheckpoint(migrationId, "ghec_starting");
    const orgId = await getOrgId(clients.targetGraphql, migration.targetOrg);
    const migSourceId = await createMigrationSource(clients.targetGraphql, orgId);

    const srcRepoUrl = `${sourceBaseUrl(migration.sourceApiUrl)}/${migration.sourceOrg}/${migration.sourceRepo}`;

    // Resolve tokens just-in-time for the GHEC startMigration mutation
    // which embeds them as GraphQL variables (not HTTP auth headers).
    const [sourceTokenStr, targetTokenStr] = await Promise.all([
      clients.getSourceToken(),
      clients.getTargetToken(),
    ]);

    const githubMigrationId = await ghecStartMigration(clients.targetGraphql, {
      migrationSourceId: migSourceId,
      sourceRepoUrl: srcRepoUrl,
      orgId,
      repoName: migration.targetRepo,
      sourceToken: sourceTokenStr,
      targetToken: targetTokenStr,
      gitArchiveUrl: gitArchiveUrl || "",
      metadataArchiveUrl: metadataArchiveUrl || "",
      skipReleases: opts.skipReleases,
      targetRepoVisibility: opts.targetRepoVisibility,
      lockSource: opts.lockSource,
    });

    migration.githubMigrationId = githubMigrationId;
    updateCheckpoint(migrationId, "monitoring", { githubMigrationId });
    emitStep(`Migration started (${githubMigrationId})`);

    // ── Step 5: Monitor until terminal state ───────────────────────
    const { phase: terminalPhase, finalCounts } = await runMonitor({
      clients,
      migrationId,
      githubMigrationId,
      targetOrg: migration.targetOrg,
      targetRepo: migration.targetRepo,
      sourceOrg: migration.sourceOrg,
      sourceRepo: migration.sourceRepo,
      sourceCounts: migration.sourceCounts,
      signal: opts.signal,
      emit,
    });

    // If GHEC reported failure, don't mark as succeeded.
    if (terminalPhase === "FAILED") {
      // The repo may have been created before the import failed — capture its
      // identity so a guarded cleanup/restart can later prove provenance.
      await captureTargetNodeId(clients, migration);
      migration.state = "failed";
      migration.failureReason = "Migration failed on GHEC";
      migration.completedAt = new Date().toISOString();
      migration.elapsedSeconds = (Date.now() - new Date(startedAt).getTime()) / 1000;
      return migration;
    }

    // If the monitor didn't reach SUCCEEDED, something went wrong — either
    // GHEC never reported success, the signal was aborted during a poll()
    // network call (not during sleep, which throws), or the monitor exited
    // with UNKNOWN.  Re-throw so the catch block handles it properly
    // instead of falling through to "succeeded".
    if (terminalPhase !== "SUCCEEDED") {
      throw new Error(
        opts.signal?.aborted ? "Migration cancelled" : `Monitor exited in phase ${terminalPhase}`,
      );
    }

    // Final target counts: prefer the monitor's final snapshot (taken when
    // GHEC reported SUCCEEDED). A fresh re-fetch here can race GHEC's
    // post-migration indexing lag and report transient zeros for issues/PRs,
    // so only re-fetch when the snapshot didn't capture counts.
    if (finalCounts) {
      migration.targetCounts = finalCounts;
    } else {
      try {
        migration.targetCounts = await getRepoCounts(
          clients.target,
          clients.targetGraphql,
          migration.targetOrg,
          migration.targetRepo,
        );
      } catch {
        // Non-fatal
      }
    }

    // Capture the created repo's immutable identity for provenance.
    await captureTargetNodeId(clients, migration);

    migration.state = "succeeded";
    migration.completedAt = new Date().toISOString();
    migration.elapsedSeconds = (Date.now() - new Date(startedAt).getTime()) / 1000;

    // ── Post-migration: Archive source repo if requested ───────────
    updateCheckpoint(migrationId, "post_migration");
    if (opts.archiveSource) {
      try {
        const repoNodeId = await getRepoNodeId(
          clients.sourceGraphql,
          migration.sourceOrg,
          migration.sourceRepo,
        );
        await archiveRepository(clients.sourceGraphql, repoNodeId);
        emitStep(`Source repository ${migration.sourceOrg}/${migration.sourceRepo} archived`);
      } catch (archiveErr) {
        const msg = archiveErr instanceof Error ? archiveErr.message : String(archiveErr);
        emitStep(`⚠ Failed to archive source repository: ${msg}`);
      }
    }

    return migration;
  } catch (err) {
    if (opts.signal?.aborted) {
      // User-initiated cancellation — try to abort on GHEC if it was started.
      if (migration.githubMigrationId) {
        try {
          const cancelClients = createClients({
            sourceApiUrl: migration.sourceApiUrl,
            sourceAuth: resolveSourceAuth(opts.sourceToken, opts.sourceApp),
            targetAuth: resolveTargetAuth(opts.targetToken, opts.targetApp),
          });
          await abortMigration(cancelClients.targetGraphql, migration.githubMigrationId);
        } catch {
          // Best-effort
        }
      }
      migration.state = "cancelled";
    } else {
      migration.state = "failed";
      migration.failureReason = err instanceof Error ? err.message : String(err);
    }

    migration.completedAt = new Date().toISOString();
    migration.elapsedSeconds = (Date.now() - new Date(startedAt).getTime()) / 1000;

    // Only emit a failure event for genuine errors, not user cancellations.
    if (migration.state !== "cancelled") {
      emit({
        migrationId,
        eventType: "failure",
        phase: "FAILED",
        payload: { error: migration.failureReason ?? undefined },
        createdAt: new Date().toISOString(),
      });
    }

    return migration;
  }
}

// ── Preflight ───────────────────────────────────────────────────────────────

async function preflight(
  clients: GitHubClients,
  migration: Migration,
  _opts: MigrationPipelineOpts,
  emitStep: (msg: string) => void,
): Promise<void> {
  // Check GHES version (skip for GHEC→GHEC).
  if (!isGhecSource(migration.sourceApiUrl)) {
    const version = await checkGhesVersion(clients.source);
    emitStep(`GHES version OK: ${version}`);
  }

  // Check target org exists.
  const orgExists = await doesOrgExist(clients.target, migration.targetOrg);
  if (!orgExists) {
    throw new Error(`Target organization "${migration.targetOrg}" does not exist on GHEC`);
  }

  // Check target repo.
  const repoExists = await doesRepoExist(clients.target, migration.targetOrg, migration.targetRepo);
  // Record provenance: whether the target pre-existed before we touched it.
  // A repo that already existed is never eligible for automated cleanup.
  migration.targetPreexisted = repoExists;
  updateMigrationProvenance(migration.id, { targetPreexisted: repoExists });
  if (repoExists) {
    emitStep(
      `Target repo ${migration.targetOrg}/${migration.targetRepo} already exists — GitHub will reject the import if the name is taken. Delete or rename it on the target, then restart.`,
    );
  }

  emitStep("Pre-flight checks passed");
}

/**
 * Capture the immutable node_id of a target repo this tool created, so a later
 * cleanup can prove identity. Only runs when the repo did NOT pre-exist (i.e.
 * we created it). Best-effort: on a failed migration the repo may not exist, in
 * which case the node_id stays null and the migration is simply not eligible.
 */
async function captureTargetNodeId(clients: GitHubClients, migration: Migration): Promise<void> {
  if (migration.targetPreexisted !== false) return; // never ours, or unknown
  if (migration.targetRepoNodeId) return; // already captured
  try {
    const nodeId = await getRepoNodeId(
      clients.targetGraphql,
      migration.targetOrg,
      migration.targetRepo,
    );
    migration.targetRepoNodeId = nodeId;
    updateMigrationProvenance(migration.id, { targetRepoNodeId: nodeId });
  } catch {
    // Repo not present (e.g. migration failed before creation) — leave null.
  }
}

// ── Archive resolution ──────────────────────────────────────────────────────

/**
 * Kick off the git + metadata archive exports on the source and return their
 * archive IDs. Shared by the direct-passthrough and download→upload branches.
 */
async function startArchiveExports(
  clients: GitHubClients,
  migration: Migration,
  opts: MigrationPipelineOpts,
): Promise<{ gitArchiveId: number; metaArchiveId: number }> {
  const gitArchiveId = await startGitArchiveExport(
    clients.source,
    migration.sourceOrg,
    migration.sourceRepo,
  );
  const metaArchiveId = await startMetadataArchiveExport(
    clients.source,
    migration.sourceOrg,
    migration.sourceRepo,
    opts.skipReleases ?? false,
    opts.lockSource ?? false,
  );
  return { gitArchiveId, metaArchiveId };
}

async function resolveArchives(
  clients: GitHubClients,
  migration: Migration,
  opts: MigrationPipelineOpts,
  emitStep: (msg: string) => void,
): Promise<{ gitArchiveUrl: string; metadataArchiveUrl: string }> {
  // GHEC→GHEC: no archives needed.
  if (isGhecSource(migration.sourceApiUrl)) {
    emitStep("GHEC→GHEC migration — no archive export needed");
    return { gitArchiveUrl: "", metadataArchiveUrl: "" };
  }

  // Direct passthrough: pass GHES URLs directly to GHEC.
  if (opts.directPassthrough) {
    emitStep("Exporting archives from source (direct passthrough)");
    const { gitArchiveId, metaArchiveId } = await startArchiveExports(clients, migration, opts);
    const gitUrl = await waitForArchive(
      clients.source,
      migration.sourceOrg,
      gitArchiveId,
      opts.signal,
    );
    const metaUrl = await waitForArchive(
      clients.source,
      migration.sourceOrg,
      metaArchiveId,
      opts.signal,
    );

    return { gitArchiveUrl: gitUrl, metadataArchiveUrl: metaUrl };
  }

  // Default: export → download → upload.
  emitStep("Exporting archives from source");

  const { gitArchiveId, metaArchiveId } = await startArchiveExports(clients, migration, opts);

  emitStep("Waiting for archive exports to complete");

  const [gitSourceUrl, metaSourceUrl] = await Promise.all([
    waitForArchive(clients.source, migration.sourceOrg, gitArchiveId, opts.signal),
    waitForArchive(clients.source, migration.sourceOrg, metaArchiveId, opts.signal),
  ]);

  // Download archives to temp files (avoids holding both in memory).
  emitStep("Downloading archives from source");

  const archiveBase = env.ARCHIVE_DIR || tmpdir();
  mkdirSync(archiveBase, { recursive: true });
  const tmpDir = mkdtempSync(join(archiveBase, "gh-migrate-"));
  try {
    const gitTmpPath = join(tmpDir, "git-archive.tar.gz");
    const metaTmpPath = join(tmpDir, "metadata-archive.tar.gz");

    const sourceToken = await clients.getSourceToken();

    await Promise.all([
      downloadToFile(
        gitSourceUrl,
        sourceToken,
        gitTmpPath,
        opts.noSslVerify,
        migration.sourceApiUrl,
      ),
      downloadToFile(
        metaSourceUrl,
        sourceToken,
        metaTmpPath,
        opts.noSslVerify,
        migration.sourceApiUrl,
      ),
    ]);

    // Upload to GitHub storage (sequential to limit peak memory to one archive).
    emitStep("Uploading archives to GitHub storage");

    const orgDbId = await getOrgDatabaseId(clients.targetGraphql, migration.targetOrg);

    // Stream from disk via Bun.file() (BunFile extends Blob) — avoids
    // buffering entire archives into memory.
    const gitUploadToken = await clients.getTargetToken();
    const gitArchiveUrl = await uploadArchive(
      Bun.file(gitTmpPath),
      "git-archive.tar.gz",
      orgDbId,
      gitUploadToken,
      undefined,
      opts.signal,
    );

    const metaUploadToken = await clients.getTargetToken();
    const metadataArchiveUrl = await uploadArchive(
      Bun.file(metaTmpPath),
      "metadata-archive.tar.gz",
      orgDbId,
      metaUploadToken,
      undefined,
      opts.signal,
    );

    emitStep("Archives uploaded");
    return { gitArchiveUrl, metadataArchiveUrl };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Validate that a download URL points to the same host as the source API.
 * Prevents SSRF / token leakage if GHES returns a crafted archive URL.
 */
export function assertTrustedHost(downloadUrl: string, sourceApiUrl: string): void {
  const download = new URL(downloadUrl);
  const source = new URL(sourceApiUrl);
  if (download.hostname !== source.hostname) {
    throw new Error(
      `Refusing to send credentials to ${download.hostname} — expected ${source.hostname}`,
    );
  }
}

/** Stream a download to a temp file instead of buffering in memory. */
async function downloadToFile(
  url: string,
  token: string,
  destPath: string,
  noSslVerify?: boolean,
  sourceApiUrl?: string,
): Promise<void> {
  // Validate the download URL against the source API host if provided.
  if (sourceApiUrl) {
    assertTrustedHost(url, sourceApiUrl);
  }
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    // Bun supports a `tls` option for self-signed certificates.
    ...(noSslVerify ? { tls: { rejectUnauthorized: false } } : {}),
  });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  await Bun.write(destPath, resp);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Determine auth mode for crash recovery eligibility.
 * Only 'env-app' migrations can be reconnected — the credentials
 * live in env vars and are available after a restart.
 */
export function determineAuthMode(opts: MigrationPipelineOpts): AuthMode {
  // If explicit tokens were provided in the request, it's PAT auth.
  if (opts.sourceToken || opts.targetToken) return "request-pat";
  // If explicit app creds were provided per-request, those are lost on crash.
  if (opts.sourceApp || opts.targetApp) return "request-app";
  // Otherwise, both sides must be using env-configured GitHub App.
  if (isSourceAppConfigured() && isTargetAppConfigured()) return "env-app";
  // Env PATs are also resumable since they survive restarts.
  if (isSourceAuthAvailable() && isTargetAuthAvailable()) return "env-pat";
  return "request-pat";
}

/**
 * Resume a migration that was interrupted by a server restart.
 * Only works for env-app auth migrations that have a github_migration_id.
 * Re-creates clients from env vars and reconnects to the GHEC migration.
 */
export async function resumeMigration(
  migration: Migration,
  emit: EventEmitter,
  signal?: AbortSignal,
): Promise<Migration> {
  const migrationId = migration.id;
  const githubMigrationId = migration.githubMigrationId;
  if (!githubMigrationId) {
    throw new Error(`Cannot resume migration ${migrationId}: missing githubMigrationId`);
  }

  const emitStep = (message: string) => {
    emit({
      migrationId,
      eventType: "step",
      phase: null,
      payload: { message },
      createdAt: new Date().toISOString(),
    });
  };

  emitStep(`Reconnecting to in-flight migration ${migration.githubMigrationId}`);

  try {
    // Re-create clients from env-configured GitHub App credentials.
    const sourceAuth = resolveSourceAuth();
    const targetAuth = resolveTargetAuth();

    const clients = createClients({
      sourceApiUrl: migration.sourceApiUrl,
      sourceAuth,
      targetAuth,
    });

    // Resume monitoring the existing GHEC migration.
    const { phase: terminalPhase, finalCounts } = await runMonitor({
      clients,
      migrationId,
      githubMigrationId,
      targetOrg: migration.targetOrg,
      targetRepo: migration.targetRepo,
      sourceOrg: migration.sourceOrg,
      sourceRepo: migration.sourceRepo,
      sourceCounts: migration.sourceCounts,
      signal,
      emit,
    });

    if (terminalPhase === "FAILED") {
      migration.state = "failed";
      migration.failureReason = "Migration failed on GHEC";
      migration.completedAt = new Date().toISOString();
      migration.elapsedSeconds = (Date.now() - new Date(migration.startedAt).getTime()) / 1000;
      return migration;
    }

    // Guard against monitor exiting without reaching SUCCEEDED (e.g. signal
    // aborted during a poll network call, or UNKNOWN exit).
    if (terminalPhase !== "SUCCEEDED") {
      throw new Error(
        signal?.aborted ? "Migration cancelled" : `Monitor exited in phase ${terminalPhase}`,
      );
    }

    // Final target counts: prefer the monitor's final snapshot over a re-fetch
    // to avoid GHEC's post-migration indexing lag (see runMigrationPipeline).
    if (finalCounts) {
      migration.targetCounts = finalCounts;
    } else {
      try {
        migration.targetCounts = await getRepoCounts(
          clients.target,
          clients.targetGraphql,
          migration.targetOrg,
          migration.targetRepo,
        );
      } catch {
        // Non-fatal
      }
    }

    migration.state = "succeeded";
    migration.completedAt = new Date().toISOString();
    migration.elapsedSeconds = (Date.now() - new Date(migration.startedAt).getTime()) / 1000;

    return migration;
  } catch (err) {
    // Mirror the cancellation logic from runMigrationPipeline: if the signal
    // was aborted, treat as cancellation rather than failure.
    if (signal?.aborted) {
      migration.state = "cancelled";
    } else {
      migration.state = "failed";
      migration.failureReason = err instanceof Error ? err.message : String(err);
    }

    migration.completedAt = new Date().toISOString();
    migration.elapsedSeconds = (Date.now() - new Date(migration.startedAt).getTime()) / 1000;

    // Only emit failure events for genuine errors, not user cancellations.
    if (migration.state !== "cancelled") {
      emit({
        migrationId,
        eventType: "failure",
        phase: "FAILED",
        payload: { error: migration.failureReason ?? undefined },
        createdAt: new Date().toISOString(),
      });
    }

    return migration;
  }
}
