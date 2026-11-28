/**
 * Seed script — generates realistic migration and profiler datasets for UI testing.
 *
 * Targets:
 *   • At least 2,500 migrations spanning six calendar months
 *   • ~150 batches (5–40 repos each)
 *   • 10 currently running migrations (5 individual + 5 inside an active batch)
 *   • Realistic distribution: ~92% succeeded, ~5% failed, ~3% cancelled, plus running/pending
 *   • 4 profiler runs with 349 repository profiles across clean, mixed, large, and failed scenarios
 *
 * Run: bun run seed [--migrations-only]
 */
/// <reference types="bun" />

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { initializeSchema } from "../../src/lib/server/core/db";
import { DOMAIN_STORES } from "../../src/lib/server/schemas";
import type { SourceProvider } from "../../src/lib/source-provider";
import type { TargetPlatform } from "../../src/lib/target-platform";
import {
  LARGE_REPOSITORY_SIZE_KB,
  MIGRATION_SEED_ROUTES,
  migrationSeedRoute,
} from "./migration-seed-routes";
import { seedProfiles } from "./seed-profiles";

const dataDirectory = process.env.DATA_DIR || "data";
const migrationsOnly = process.argv.includes("--migrations-only");
mkdirSync(dataDirectory, { recursive: true });
const db = new Database(join(dataDirectory, "gh-migrate.db"), { create: true });
db.run("PRAGMA busy_timeout = 5000");
initializeSchema(db, DOMAIN_STORES);

// ── Helpers ────────────────────────────────────────────────────────────────
const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const pick = <T>(arr: readonly T[]): T => {
  const v = arr[Math.floor(Math.random() * arr.length)];
  if (v === undefined) throw new Error("pick() called on an empty array");
  return v;
};

/**
 * Mimic a GitHub GraphQL global node ID for a RepositoryMigration, e.g.
 * `RM_kgDOABcdEfGhIjk`. Real IDs are `RM_` + base64url of an opaque payload;
 * `kgC`/`kgD` is the common prefix seen in practice.
 */
function fakeMigrationNodeId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const len = rand(14, 18);
  let suffix = "";
  for (let i = 0; i < len; i++) suffix += alphabet[rand(0, alphabet.length - 1)];
  return `RM_${pick(["kgC", "kgD"])}${suffix}`;
}

/**
 * Repo size in KB, log-distributed across ~12 KB → ~4.5 GB so the dataset has
 * realistic variety (plenty of small KB/MB repos, fewer huge ones) instead of
 * clustering in the gigabytes like a uniform range would.
 */
function randomRepoSizeKb(): number {
  const minKb = 12;
  const maxKb = 4_500_000;
  const t = Math.random();
  const kb = minKb * (maxKb / minKb) ** t;
  return Math.max(minKb, Math.round(kb));
}

function isoTs(base: Date, offsetSec: number): string {
  return new Date(base.getTime() + offsetSec * 1000).toISOString();
}

function randomCounts() {
  return {
    commits: rand(50, 25000),
    branches: rand(1, 120),
    tags: rand(0, 200),
    issues: rand(0, 5000),
    pullRequests: rand(0, 3000),
    releases: rand(0, 80),
  };
}

// ── Data pools ─────────────────────────────────────────────────────────────
const sourceOrgs = [
  "acme-corp",
  "widgets-inc",
  "foxtrot-labs",
  "nova-systems",
  "delta-eng",
  "pinnacle-tech",
  "redwood-io",
  "silverline-dev",
  "quantum-ops",
  "northstar-hq",
  "blue-harbor",
  "ironclad-sec",
  "atlas-platform",
  "vortex-ai",
  "skybridge-net",
];

const targetOrgs = [
  "acme-cloud",
  "widgets-cloud",
  "foxtrot-cloud",
  "nova-cloud",
  "delta-cloud",
  "pinnacle-cloud",
  "redwood-cloud",
  "silverline-cloud",
  "quantum-cloud",
  "northstar-cloud",
  "blue-harbor-cc",
  "ironclad-cc",
  "atlas-cc",
  "vortex-cc",
  "skybridge-cc",
];

const repoNames = [
  "admin-panel",
  "analytics-engine",
  "api-gateway",
  "asset-manager",
  "audit-log",
  "auth-service",
  "backup-service",
  "batch-processor",
  "billing-api",
  "cache-layer",
  "cdn-proxy",
  "cert-manager",
  "chatbot",
  "ci-runner",
  "cli-tools",
  "cloud-config",
  "compliance-checker",
  "config-service",
  "container-registry",
  "cron-scheduler",
  "dashboard-ui",
  "data-lake",
  "data-pipeline",
  "db-migrator",
  "deploy-agent",
  "docs-generator",
  "docs-site",
  "edge-proxy",
  "email-service",
  "event-bus",
  "feature-flags",
  "file-storage",
  "form-builder",
  "gateway-auth",
  "graphql-api",
  "health-monitor",
  "iam-service",
  "image-resizer",
  "infra-terraform",
  "ingestion-pipeline",
  "internal-wiki",
  "invoice-generator",
  "job-queue",
  "k8s-operator",
  "keycloak-plugin",
  "label-printer",
  "lambda-functions",
  "load-balancer",
  "log-aggregator",
  "markdown-renderer",
  "message-broker",
  "metrics-collector",
  "mobile-bff",
  "model-server",
  "notification-hub",
  "notification-svc",
  "oauth-provider",
  "onboarding-flow",
  "ops-toolbox",
  "order-service",
  "payment-gateway",
  "pdf-generator",
  "permission-engine",
  "plugin-sdk",
  "poll-service",
  "portal-frontend",
  "pricing-engine",
  "queue-worker",
  "rate-limiter",
  "recommendation-api",
  "redis-cache",
  "release-train",
  "report-builder",
  "rest-adapter",
  "sandbox-env",
  "schema-registry",
  "search-indexer",
  "secret-manager",
  "security-scanner",
  "service-mesh",
  "session-store",
  "slack-bot",
  "sms-gateway",
  "snapshot-service",
  "socket-server",
  "spa-frontend",
  "status-page",
  "storage-api",
  "stream-processor",
  "support-portal",
  "sync-engine",
  "task-scheduler",
  "team-dashboard",
  "telemetry-agent",
  "tenant-manager",
  "test-harness",
  "theme-engine",
  "ticket-system",
  "time-tracker",
  "token-service",
  "url-shortener",
  "user-dashboard",
  "vault-proxy",
  "video-transcoder",
  "webhook-relay",
  "workflow-engine",
  "workspace-api",
];

const sourceApiUrls = [
  "https://ghes.acme.corp/api/v3",
  "https://github.widgets.io/api/v3",
  "https://git.foxtrot-labs.dev/api/v3",
  "https://ghes.nova-systems.net/api/v3",
  "https://api.github.com",
];

const failureReasons = [
  "Archive upload failed: 413 Payload Too Large",
  "Migration stuck in EXPORTING phase for over 2 hours",
  "Target organization rate limit exceeded during import",
  "GHES responded with 502 Bad Gateway during archive download",
  "Repository contains forbidden file types (git-lfs pointer mismatch)",
  "Installation token expired during long-running migration",
  "Archive export timed out after 3600 seconds",
  "Repository is locked by another migration in progress",
  "Source repository has been deleted or renamed",
  "GHEC returned 422: Repository name already exists in target org",
  "Git archive checksum mismatch after upload",
  "Metadata archive contains invalid JSON in issues export",
  "Migration aborted: source server unreachable after 5 retries",
  "GHEC import failed: organization storage quota exceeded",
  "GraphQL mutation failed: insufficient permissions for migration source creation",
];

// ── Prepared statements ────────────────────────────────────────────────────
const insertMigration = db.prepare(`
  INSERT INTO migrations (id, batch_id, github_migration_id, source_provider, source_api_url,
    target_profile_id, target_platform, target_api_url, source_org, source_repo, target_org,
    target_repo, state, failure_reason, warnings_count, source_counts, target_counts, started_at,
    completed_at, elapsed_seconds, migration_log_url, source_size_kb)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertEvent = db.prepare(`
  INSERT INTO events (migration_id, event_type, phase, payload, created_at) VALUES (?, ?, ?, ?, ?)
`);

// ── Migration generator ───────────────────────────────────────────────────
interface MigrationOpts {
  id: string;
  batchId?: string;
  state: "succeeded" | "failed" | "cancelled" | "running" | "pending";
  startedAt: Date;
  sourceProvider?: SourceProvider;
  sourceOrg?: string;
  targetOrg?: string;
  repo?: string;
  sourceApiUrl?: string;
  targetProfileId?: string;
  targetPlatform?: TargetPlatform;
  targetApiUrl?: string;
  sourceSizeKb?: number;
  failureReason?: string;
  richEvents?: boolean;
}

function createMigration(opts: MigrationOpts) {
  const sourceProvider = opts.sourceProvider ?? "github";
  const sourceOrg = opts.sourceOrg ?? pick(sourceOrgs);
  const orgIdx = sourceOrgs.indexOf(sourceOrg);
  // Pair the target org to the source by index; fall back to a random pick when
  // the source isn't one of the known orgs (orgIdx < 0) or has no paired entry.
  const targetOrg = opts.targetOrg ?? targetOrgs[orgIdx] ?? pick(targetOrgs);
  const repo = opts.repo ?? pick(repoNames);
  const sourceApiUrl = opts.sourceApiUrl ?? pick(sourceApiUrls);
  const targetProfileId = opts.targetProfileId ?? "ghec";
  const targetPlatform = opts.targetPlatform ?? "ghec";
  const targetApiUrl = opts.targetApiUrl ?? "https://api.github.com";
  const isGhecSource = sourceProvider === "github" && sourceApiUrl === "https://api.github.com";
  const src = randomCounts();

  const maxElapsed = Math.min(
    7200,
    Math.max(0, Math.floor((Date.now() - opts.startedAt.getTime()) / 1000)),
  );
  const elapsed =
    opts.state === "running" || opts.state === "pending"
      ? null
      : rand(Math.min(90, maxElapsed), maxElapsed);
  const completedAt = elapsed !== null ? isoTs(opts.startedAt, elapsed) : null;
  const warnings = opts.state === "succeeded" ? rand(0, 12) : 0;
  const tgt =
    opts.state === "succeeded" && targetPlatform === "ghec"
      ? { ...src, commits: Math.max(0, src.commits + rand(-5, 0)) }
      : null;
  const failure = opts.state === "failed" ? (opts.failureReason ?? pick(failureReasons)) : null;
  const targetWebUrl =
    targetPlatform === "ghec" ? "https://github.com" : targetApiUrl.replace(/\/api\/v3\/?$/, "");
  const logUrl =
    opts.state === "succeeded"
      ? `${targetWebUrl}/${targetOrg}/${repo}/settings/migrations/log`
      : null;

  insertMigration.run(
    opts.id,
    opts.batchId ?? null,
    fakeMigrationNodeId(),
    sourceProvider,
    sourceApiUrl,
    targetProfileId,
    targetPlatform,
    targetApiUrl,
    sourceOrg,
    repo,
    targetOrg,
    repo,
    opts.state,
    failure,
    warnings,
    sourceProvider === "github" && targetPlatform === "ghec" ? JSON.stringify(src) : null,
    tgt ? JSON.stringify(tgt) : null,
    opts.startedAt.toISOString(),
    completedAt,
    elapsed,
    logUrl,
    sourceProvider === "github" && targetPlatform === "ghec"
      ? (opts.sourceSizeKb ?? randomRepoSizeKb())
      : null,
  );

  // ── Events ──────────────────────────────────────────────────────────────
  const startIso = opts.startedAt.toISOString();

  insertEvent.run(
    opts.id,
    "step",
    null,
    JSON.stringify({ message: `Starting migration: ${sourceOrg}/${repo} → ${targetOrg}/${repo}` }),
    startIso,
  );

  insertEvent.run(
    opts.id,
    "step",
    null,
    JSON.stringify({
      message:
        sourceProvider === "github"
          ? isGhecSource
            ? "GHEC→GHEC migration — no archive export needed"
            : `GHES version 3.${rand(17, 20)}.${rand(0, 9)} detected`
          : sourceProvider === "gitlab"
            ? "GitLab source detected"
            : "Bitbucket Server source detected",
    }),
    isoTs(opts.startedAt, 2),
  );

  insertEvent.run(
    opts.id,
    "step",
    null,
    JSON.stringify({
      message: `Target organization "${targetOrg}" exists on ${targetPlatform.toUpperCase()}`,
    }),
    isoTs(opts.startedAt, 3),
  );

  insertEvent.run(
    opts.id,
    "step",
    null,
    JSON.stringify({ message: "Source counts fetched", counts: src }),
    isoTs(opts.startedAt, 5),
  );

  if (!isGhecSource) {
    insertEvent.run(
      opts.id,
      "step",
      null,
      JSON.stringify({ message: "Starting git archive export..." }),
      isoTs(opts.startedAt, 8),
    );
  }

  // Rich events for detailed migrations (running / succeeded with full history)
  if (opts.richEvents && (opts.state === "succeeded" || opts.state === "running")) {
    const phases: [number, string][] = isGhecSource
      ? [
          [10, "PENDING_VALIDATION"],
          [30, "QUEUED"],
          [90, "IMPORTING_GIT"],
        ]
      : [
          [10, "PENDING_VALIDATION"],
          [30, "QUEUED"],
          [60, "EXPORTING"],
          [180, "IMPORTING_GIT"],
        ];

    let prevPhase: string | null = null;
    for (const [offset, phase] of phases) {
      if (offset > (elapsed ?? maxElapsed)) continue;
      if (prevPhase) {
        insertEvent.run(
          opts.id,
          "phase_change",
          phase,
          JSON.stringify({ from: prevPhase, to: phase }),
          isoTs(opts.startedAt, offset),
        );
      }
      prevPhase = phase;
    }

    // Git import snapshots
    const gitStart = isGhecSource ? 90 : 180;
    const gitEnd =
      elapsed !== null
        ? Math.max(gitStart, Math.min(gitStart + rand(300, 1200), elapsed - 120))
        : Math.min(gitStart + 600, maxElapsed + 1);
    let prevCounts = { commits: 0, branches: 0, tags: 0, issues: 0, pullRequests: 0, releases: 0 };

    for (let t = gitStart; t < gitEnd; t += 60) {
      const pct = Math.min(1, (t - gitStart) / (gitEnd - gitStart));
      const snap = {
        commits: Math.round(src.commits * pct),
        branches: Math.round(src.branches * Math.min(1, pct * 1.5)),
        tags: Math.round(src.tags * Math.min(1, pct * 1.3)),
        issues: 0,
        pullRequests: 0,
        releases: 0,
      };
      const progress = {
        current: {
          ...snap,
          phase: "IMPORTING_GIT",
          elapsed: t,
          timestamp: isoTs(opts.startedAt, t),
          migrationState: "IN_PROGRESS",
          failureReason: "",
          migrationLogUrl: "",
          warningsCount: 0,
          repoExists: true,
          countsAuthoritative: true,
          repoSize: 0,
        },
        previous: null,
        deltaCommits: snap.commits - prevCounts.commits,
        deltaBranches: snap.branches - prevCounts.branches,
        deltaTags: snap.tags - prevCounts.tags,
        deltaIssues: 0,
        deltaPRs: 0,
        deltaReleases: 0,
        deltaSize: 0,
        commitsPerMin: snap.commits - prevCounts.commits,
        issuesPerMin: 0,
      };
      insertEvent.run(
        opts.id,
        "snapshot",
        "IMPORTING_GIT",
        JSON.stringify({ progress, sourceCounts: src }),
        isoTs(opts.startedAt, t),
      );
      prevCounts = snap;
    }

    // Metadata phase + snapshots (only for completed)
    if (opts.state === "succeeded" && elapsed !== null && gitEnd < elapsed - 30) {
      insertEvent.run(
        opts.id,
        "phase_change",
        "IMPORTING_METADATA",
        JSON.stringify({ from: "IMPORTING_GIT", to: "IMPORTING_METADATA" }),
        isoTs(opts.startedAt, gitEnd),
      );

      for (let t = gitEnd; t < elapsed - 30; t += 60) {
        const pct = Math.min(1, (t - gitEnd) / (elapsed - gitEnd));
        const snap = {
          commits: src.commits,
          branches: src.branches,
          tags: src.tags,
          issues: Math.round(src.issues * pct),
          pullRequests: Math.round(src.pullRequests * pct),
          releases: Math.round(src.releases * Math.min(1, pct * 1.5)),
        };
        insertEvent.run(
          opts.id,
          "snapshot",
          "IMPORTING_METADATA",
          JSON.stringify({
            progress: {
              current: {
                ...snap,
                timestamp: isoTs(opts.startedAt, t),
                migrationState: "IN_PROGRESS",
                failureReason: "",
                migrationLogUrl: "",
                warningsCount: 0,
                repoExists: true,
                countsAuthoritative: true,
                repoSize: 0,
                phase: "IMPORTING_METADATA",
                elapsed: t,
              },
              previous: null,
              deltaCommits: 0,
              deltaBranches: 0,
              deltaTags: 0,
              deltaIssues: 0,
              deltaPRs: 0,
              deltaReleases: 0,
              deltaSize: 0,
              commitsPerMin: 0,
              issuesPerMin: 0,
            },
            sourceCounts: src,
          }),
          isoTs(opts.startedAt, t),
        );
      }
    }
  }

  // Terminal events
  if (opts.state === "succeeded" && elapsed) {
    insertEvent.run(
      opts.id,
      "complete",
      "SUCCEEDED",
      JSON.stringify({
        progress: {
          current: {
            ...(tgt ?? {
              commits: 0,
              branches: 0,
              tags: 0,
              issues: 0,
              pullRequests: 0,
              releases: 0,
            }),
            timestamp: isoTs(opts.startedAt, elapsed),
            migrationState: "SUCCEEDED",
            failureReason: "",
            migrationLogUrl: logUrl ?? "",
            warningsCount: warnings,
            repoExists: true,
            countsAuthoritative: tgt !== null,
            repoSize: 0,
            phase: "SUCCEEDED",
            elapsed,
          },
          previous: null,
          deltaCommits: 0,
          deltaBranches: 0,
          deltaTags: 0,
          deltaIssues: 0,
          deltaPRs: 0,
          deltaReleases: 0,
          deltaSize: 0,
          commitsPerMin: 0,
          issuesPerMin: 0,
        },
        sourceCounts: sourceProvider === "github" && targetPlatform === "ghec" ? src : null,
        elapsed,
      }),
      isoTs(opts.startedAt, elapsed),
    );
  } else if (opts.state === "failed" && elapsed) {
    insertEvent.run(
      opts.id,
      "failure",
      "FAILED",
      JSON.stringify({
        error: failure,
        detail: {
          migrationId: opts.id,
          state: "FAILED",
          failureReason: failure,
          elapsed,
          logUrl: "",
          logEntries: [
            {
              severity: "ERROR",
              message: failure,
              modelName: pick([
                "git_archive",
                "metadata_import",
                "migration_controller",
                "upload_service",
              ]),
            },
            ...(rand(0, 1)
              ? [
                  {
                    severity: "WARNING",
                    message: "Repository size exceeds recommended limit",
                    modelName: "preflight_check",
                  },
                ]
              : []),
          ],
        },
      }),
      isoTs(opts.startedAt, elapsed),
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Generate data inside a transaction for speed
// ══════════════════════════════════════════════════════════════════════════
const transaction = db.transaction(() => {
  const migrationPrefixes = ["seed-feat-", "seed-running-", "seed-batch-", "seed-ind-"];
  for (const prefix of migrationPrefixes) {
    for (const table of ["events", "migration_batch_items", "ghes_import_jobs"]) {
      db.prepare(`DELETE FROM ${table} WHERE migration_id LIKE ?`).run(`${prefix}%`);
    }
    db.prepare("DELETE FROM migrations WHERE id LIKE ?").run(`${prefix}%`);
  }
  console.log("✓ Cleaned previous migration seed data");
  let migrationCount = 0;
  let batchCount = 0;
  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const now = new Date(nowMs);
  const historyStart = new Date(nowMs);
  historyStart.setUTCDate(1);
  historyStart.setUTCMonth(historyStart.getUTCMonth() - 6);
  const lastDay = new Date(
    Date.UTC(historyStart.getUTCFullYear(), historyStart.getUTCMonth() + 1, 0),
  ).getUTCDate();
  historyStart.setUTCDate(Math.min(now.getUTCDate(), lastDay));
  const historyEndMs = nowMs - dayMs;
  const historySpanMs = historyEndMs - historyStart.getTime();

  // ── 1. Featured migrations with rich event histories ─────────────────
  createMigration({
    id: "seed-feat-001",
    state: "succeeded",
    startedAt: new Date(nowMs - 3 * dayMs),
    sourceOrg: "acme-corp",
    repo: "platform-api",
    sourceApiUrl: "https://ghes.acme.corp/api/v3",
    richEvents: true,
  });
  createMigration({
    id: "seed-feat-002",
    state: "failed",
    startedAt: new Date(nowMs - 2 * dayMs),
    sourceOrg: "acme-corp",
    repo: "legacy-monolith",
    sourceApiUrl: "https://ghes.acme.corp/api/v3",
    failureReason: "Archive export timed out after 3600 seconds",
    richEvents: true,
  });
  migrationCount += 2;

  for (const [index, route] of MIGRATION_SEED_ROUTES.entries()) {
    createMigration({
      ...route,
      state: "succeeded",
      startedAt: new Date(nowMs - (index + 4) * dayMs),
      sourceSizeKb: LARGE_REPOSITORY_SIZE_KB,
      richEvents: false,
    });
    migrationCount++;
  }
  console.log(`✓ ${MIGRATION_SEED_ROUTES.length} large migrations covering every route`);

  // ── 2. Running migrations (one individual per route) ─────────────────
  for (let i = 0; i < MIGRATION_SEED_ROUTES.length; i++) {
    const route = migrationSeedRoute(i);
    createMigration({
      ...route,
      id: `seed-running-${String(i).padStart(3, "0")}`,
      state: "running",
      startedAt: new Date(Date.now() - rand(120, 3600) * 1000),
      repo: repoNames[i],
      richEvents: true,
    });
    migrationCount++;
  }
  console.log(`✓ ${MIGRATION_SEED_ROUTES.length} individual running migrations`);

  // ── 3. Active batch with 5 running + 3 pending ──────────────────────
  const activeBatchId = "seed-batch-active";
  const activeBatchStart = new Date(Date.now() - 1800 * 1000);
  const activeBatchRepos = repoNames.slice(10, 30);

  for (let i = 0; i < activeBatchRepos.length; i++) {
    let state: "succeeded" | "failed" | "running" | "pending";
    if (i < 10) state = "succeeded";
    else if (i < 12) state = "failed";
    else if (i < 15) state = "pending";
    else state = "running";

    createMigration({
      id: `seed-batch-active-${String(i).padStart(3, "0")}`,
      batchId: activeBatchId,
      state,
      startedAt: new Date(activeBatchStart.getTime() + i * 30 * 1000),
      sourceOrg: "pinnacle-tech",
      repo: activeBatchRepos[i],
      sourceApiUrl: "https://ghes.acme.corp/api/v3",
      richEvents: state === "running",
    });
    migrationCount++;
  }
  batchCount++;
  console.log(`✓ Active batch with 20 repos (5 running, 3 pending)`);

  // ── 4. Completed batches (~150) ──────────────────────────────────────
  const completedBatchCount = 150;
  const historicalBatchCount = completedBatchCount - MIGRATION_SEED_ROUTES.length;

  for (let b = 0; b < completedBatchCount; b++) {
    const batchId = `seed-batch-${String(b).padStart(4, "0")}`;
    const batchSize = rand(5, 40);
    const route = migrationSeedRoute(b);
    const batchStart = new Date(
      b < MIGRATION_SEED_ROUTES.length
        ? nowMs - (b + 1) * dayMs
        : historyEndMs -
            Math.floor(
              ((b - MIGRATION_SEED_ROUTES.length) * historySpanMs) / (historicalBatchCount - 1),
            ),
    );

    for (let i = 0; i < batchSize; i++) {
      const r = Math.random();
      const state: "succeeded" | "failed" | "cancelled" =
        r < 0.92 ? "succeeded" : r < 0.97 ? "failed" : "cancelled";

      createMigration({
        ...route,
        id: `seed-batch-${String(b).padStart(4, "0")}-m${String(i).padStart(3, "0")}`,
        batchId,
        state,
        startedAt: new Date(batchStart.getTime() + i * rand(15, 120) * 1000),
        repo: repoNames[(b * 7 + i) % repoNames.length],
        sourceSizeKb:
          b < MIGRATION_SEED_ROUTES.length && i === 0 ? LARGE_REPOSITORY_SIZE_KB : undefined,
        richEvents: false,
      });
      migrationCount++;
    }
    batchCount++;

    if ((b + 1) % 50 === 0) {
      console.log(`  ... ${b + 1}/150 batches seeded (${migrationCount} migrations so far)`);
    }
  }
  console.log(`✓ ${batchCount - 1} completed batches`);

  // ── 5. Individual completed migrations (fill to at least 2500) ───────
  const targetTotal = Math.max(2500, migrationCount + 200);
  const remaining = targetTotal - migrationCount;
  for (let i = 0; i < remaining; i++) {
    const route = migrationSeedRoute(i);
    const r = Math.random();
    const state: "succeeded" | "failed" | "cancelled" =
      r < 0.93 ? "succeeded" : r < 0.975 ? "failed" : "cancelled";

    createMigration({
      ...route,
      id: `seed-ind-${String(i).padStart(4, "0")}`,
      state,
      startedAt: new Date(
        historyStart.getTime() + Math.floor((i * historySpanMs) / Math.max(1, remaining - 1)),
      ),
      repo: repoNames[i % repoNames.length],
      richEvents: false,
    });
    migrationCount++;

    if ((i + 1) % 200 === 0) {
      console.log(`  ... ${i + 1}/${remaining} individual migrations seeded`);
    }
  }
  console.log(`✓ ${remaining} individual completed migrations`);

  console.log(`\n══════════════════════════════════════════════════`);
  console.log(`  Total migrations: ${migrationCount}`);
  console.log(`  Total batches:    ${batchCount}`);
  console.log(`  Running:          11 (6 individual + 5 in active batch)`);
  console.log(`  Pending:          3 (in active batch)`);
  console.log(`══════════════════════════════════════════════════`);

  if (!migrationsOnly) {
    const profiles = seedProfiles(db);
    console.log(`\n✓ ${profiles.runs} profile runs with ${profiles.repos} repository profiles`);
    console.log(`  Completed: ${profiles.completed}; failed: ${profiles.failed}`);
  }
});

console.log("\nInserting data (this may take a few seconds)...\n");
const startTime = performance.now();
transaction();
const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s! Restart the dev server or refresh the page.`);

db.close();
