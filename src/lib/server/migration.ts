/**
 * Migration pipeline orchestrator.
 * Port of pkg/migration/runner.go — runs the full migration lifecycle:
 *   preflight → resolveArchives → startMigration → monitor
 *
 * Emits MigrationEvents via a callback so the manager can persist them
 * in SQLite and broadcast via SSE.
 */
// bun:sqlite built-in UUIDv7 — time-sortable, zero deps
import type { CreateMigrationRequest, Migration } from "$lib/types";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "$env/dynamic/private";
import {
  createClients,
  checkGhesVersion,
  startGitArchiveExport,
  startMetadataArchiveExport,
  waitForArchive,
  doesOrgExist,
  doesRepoExist,
  getOrgId,
  getOrgDatabaseId,
  createMigrationSource,
  startMigration as ghecStartMigration,
  abortMigration,
  getRepoCounts,
  getRepoNodeId,
  archiveRepository,
  sourceBaseUrl,
  isGhecSource,
  type GitHubClients,
} from "./github";
import { uploadArchive } from "./upload";
import { runMonitor, type EventEmitter } from "./monitor";
import { resolveSourceAuth, resolveTargetAuth } from "./auth";

export interface MigrationPipelineOpts extends CreateMigrationRequest {
  id?: string;
  signal?: AbortSignal;
  emit: EventEmitter;
}

/**
 * Run the full migration pipeline. Returns the completed Migration record.
 * Throws on unrecoverable errors.
 */
export async function runMigrationPipeline(
  opts: MigrationPipelineOpts,
): Promise<Migration> {
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
    startedAt,
    completedAt: null,
    elapsedSeconds: null,
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
    await preflight(clients, migration, opts, emitStep);

    // Fetch source counts.
    try {
      migration.sourceCounts = await getRepoCounts(
        clients.source,
        migration.sourceOrg,
        migration.sourceRepo,
      );
    } catch {
      // Non-fatal
    }

    // ── Step 2+3: Resolve archives ─────────────────────────────────
    const { gitArchiveUrl, metadataArchiveUrl } = await resolveArchives(
      clients,
      migration,
      opts,
      emitStep,
    );

    // ── Step 4: Start migration on GHEC ────────────────────────────
    const orgId = await getOrgId(clients.targetGraphql, migration.targetOrg);
    const migSourceId = await createMigrationSource(
      clients.targetGraphql,
      orgId,
    );

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
    emitStep(`Migration started (${githubMigrationId})`);

    // ── Step 5: Monitor until terminal state ───────────────────────
    const terminalPhase = await runMonitor({
      clients,
      migrationId,
      githubMigrationId,
      targetOrg: migration.targetOrg,
      targetRepo: migration.targetRepo,
      sourceOrg: migration.sourceOrg,
      sourceRepo: migration.sourceRepo,
      signal: opts.signal,
      emit,
    });

    // If GHEC reported failure, don't mark as succeeded.
    if (terminalPhase === "FAILED") {
      migration.state = "failed";
      migration.failureReason = "Migration failed on GHEC";
      migration.completedAt = new Date().toISOString();
      migration.elapsedSeconds =
        (Date.now() - new Date(startedAt).getTime()) / 1000;
      return migration;
    }

    // Fetch final target counts.
    try {
      migration.targetCounts = await getRepoCounts(
        clients.target,
        migration.targetOrg,
        migration.targetRepo,
      );
    } catch {
      // Non-fatal
    }

    migration.state = "succeeded";
    migration.completedAt = new Date().toISOString();
    migration.elapsedSeconds =
      (Date.now() - new Date(startedAt).getTime()) / 1000;

    // ── Post-migration: Archive source repo if requested ───────────
    if (opts.archiveSource) {
      try {
        const repoNodeId = await getRepoNodeId(
          clients.sourceGraphql,
          migration.sourceOrg,
          migration.sourceRepo,
        );
        await archiveRepository(clients.sourceGraphql, repoNodeId);
        emitStep(
          `Source repository ${migration.sourceOrg}/${migration.sourceRepo} archived`,
        );
      } catch (archiveErr) {
        const msg =
          archiveErr instanceof Error ? archiveErr.message : String(archiveErr);
        emitStep(`⚠ Failed to archive source repository: ${msg}`);
      }
    }

    return migration;
  } catch (err) {
    // If aborted, try to cancel on GHEC.
    if (opts.signal?.aborted && migration.githubMigrationId) {
      try {
        const cancelClients = createClients({
          sourceApiUrl: migration.sourceApiUrl,
          sourceAuth: resolveSourceAuth(opts.sourceToken, opts.sourceApp),
          targetAuth: resolveTargetAuth(opts.targetToken, opts.targetApp),
        });
        await abortMigration(
          cancelClients.targetGraphql,
          migration.githubMigrationId,
        );
      } catch {
        // Best-effort
      }
      migration.state = "cancelled";
    } else {
      migration.state = "failed";
      migration.failureReason =
        err instanceof Error ? err.message : String(err);
    }

    migration.completedAt = new Date().toISOString();
    migration.elapsedSeconds =
      (Date.now() - new Date(startedAt).getTime()) / 1000;

    emit({
      migrationId,
      eventType: "failure",
      phase: "FAILED",
      payload: { error: migration.failureReason ?? undefined },
      createdAt: new Date().toISOString(),
    });

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
    throw new Error(
      `Target organization "${migration.targetOrg}" does not exist on GHEC`,
    );
  }

  // Check target repo.
  const repoExists = await doesRepoExist(
    clients.target,
    migration.targetOrg,
    migration.targetRepo,
  );
  if (repoExists) {
    emitStep(
      `Target repo ${migration.targetOrg}/${migration.targetRepo} already exists — migration will overwrite`,
    );
  }

  emitStep("Pre-flight checks passed");
}

// ── Archive resolution ──────────────────────────────────────────────────────

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

  emitStep("Waiting for archive exports to complete");

  const [gitSourceUrl, metaSourceUrl] = await Promise.all([
    waitForArchive(
      clients.source,
      migration.sourceOrg,
      gitArchiveId,
      opts.signal,
    ),
    waitForArchive(
      clients.source,
      migration.sourceOrg,
      metaArchiveId,
      opts.signal,
    ),
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
      downloadToFile(gitSourceUrl, sourceToken, gitTmpPath, opts.noSslVerify),
      downloadToFile(metaSourceUrl, sourceToken, metaTmpPath, opts.noSslVerify),
    ]);

    // Upload to GitHub storage (sequential to limit peak memory to one archive).
    emitStep("Uploading archives to GitHub storage");

    const orgDbId = await getOrgDatabaseId(
      clients.targetGraphql,
      migration.targetOrg,
    );

    const gitBuf = new Uint8Array(await Bun.file(gitTmpPath).arrayBuffer());
    const gitUploadToken = await clients.getTargetToken();
    const gitArchiveUrl = await uploadArchive(
      gitBuf,
      "git-archive.tar.gz",
      orgDbId,
      gitUploadToken,
    );

    const metaBuf = new Uint8Array(await Bun.file(metaTmpPath).arrayBuffer());
    const metaUploadToken = await clients.getTargetToken();
    const metadataArchiveUrl = await uploadArchive(
      metaBuf,
      "metadata-archive.tar.gz",
      orgDbId,
      metaUploadToken,
    );

    emitStep("Archives uploaded");
    return { gitArchiveUrl, metadataArchiveUrl };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Stream a download to a temp file instead of buffering in memory. */
async function downloadToFile(
  url: string,
  token: string,
  destPath: string,
  noSslVerify?: boolean,
): Promise<void> {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    // Bun supports a `tls` option for self-signed certificates.
    ...(noSslVerify ? { tls: { rejectUnauthorized: false } } : {}),
  });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  await Bun.write(destPath, resp);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Extract org from "org/repo" format — returns whole string if no slash. */
function extractOrg(repoSlug: string): string {
  const idx = repoSlug.indexOf("/");
  return idx > 0 ? repoSlug.substring(0, idx) : repoSlug;
}

/** Extract repo name from "org/repo" format. */
function extractRepo(repoSlug: string): string {
  const idx = repoSlug.indexOf("/");
  return idx > 0 ? repoSlug.substring(idx + 1) : repoSlug;
}
