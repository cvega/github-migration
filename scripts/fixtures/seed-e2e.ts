import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import type { Progress } from "../../src/lib/migrate/types";
import type { RepoSignals } from "../../src/lib/server/profile/types";
import { DOMAIN_STORES } from "../../src/lib/server/schemas";

const dataDir = ".e2e-data";
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const db = new Database(`${dataDir}/gh-migrate.db`, { create: true });
for (const domain of DOMAIN_STORES) domain.applySchema(db);

const insert = db.prepare(`
  INSERT INTO migrations (
    id, batch_id, source_api_url, source_org, source_repo,
    target_org, target_repo, state, started_at, completed_at, elapsed_seconds
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, 60)
`);
const nowMs = Date.now();
const completedAt = new Date(nowMs).toISOString();
const startedAt = new Date(nowMs - 60_000).toISOString();

insert.run(
  "seed-e2e-migration-one",
  "seed-e2e-batch-one",
  "https://api.github.com",
  "source-one",
  "repository-one",
  "target-one",
  "repository-one",
  startedAt,
  completedAt,
);
insert.run(
  "seed-e2e-migration-two",
  "seed-e2e-batch-two",
  "https://api.github.com",
  "source-two",
  "repository-two",
  "target-two",
  "repository-two",
  startedAt,
  completedAt,
);

const unverifiedProgress: Progress = {
  current: {
    timestamp: completedAt,
    migrationState: "SUCCEEDED",
    failureReason: "",
    migrationLogUrl: "",
    warningsCount: 0,
    repoExists: true,
    countsAuthoritative: false,
    repoSize: 0,
    commits: 0,
    branches: 0,
    tags: 0,
    issues: 0,
    pullRequests: 0,
    releases: 0,
    phase: "SUCCEEDED",
    elapsed: 60,
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
};
db.prepare(
  `INSERT INTO events (migration_id, event_type, phase, payload, created_at)
   VALUES ('seed-e2e-migration-two', 'complete', 'SUCCEEDED', ?, ?)`,
).run(
  JSON.stringify({ progress: unverifiedProgress, sourceCounts: null, elapsed: 60 }),
  completedAt,
);

db.prepare(
  `INSERT INTO migrations (
     id, source_provider, source_api_url,
     target_profile_id, target_platform, target_api_url,
     source_org, source_repo, target_org, target_repo,
     state, started_at, completed_at, elapsed_seconds
   ) VALUES (?, 'gitlab', ?, 'seed-e2e-ghes', 'ghes', ?, ?, ?, ?, ?, 'succeeded', ?, ?, 90)`,
).run(
  "seed-e2e-ghes-detail",
  "https://gitlab.example.com/api/v4",
  "https://target.ghes.example.com/api/v3",
  "platform/services",
  "widget",
  "e2e-target",
  "widget",
  startedAt,
  completedAt,
);

db.prepare(
  `INSERT INTO migrations (
     id, source_api_url, source_org, source_repo,
     target_org, target_repo, state, started_at, failure_reason, request_options, batch_id
   ) VALUES (?, ?, ?, ?, ?, ?, 'reconciliation_required', ?, ?, '{"noSslVerify":true}', 'seed-restart-batch')`,
).run(
  "seed-e2e-reconciliation",
  "https://api.github.com",
  "source-review",
  "repository-review",
  "target-review",
  "repository-review",
  startedAt,
  "Remote migration status could not be determined",
);

db.prepare(
  `INSERT INTO migrations (
     id, source_api_url, source_org, source_repo, target_org, target_repo, target_platform,
     target_profile_id, target_api_url, github_migration_id, state, started_at, failure_reason
   ) VALUES ('seed-e2e-unsupported-review', 'https://api.github.com', 'source-review', 'legacy',
     'target-review', ?, 'ghes', 'enterprise', 'https://ghes.example/api/v3', 'saved-import',
     'reconciliation_required', ?, 'No executor is available for this route.')`,
).run("legacy-" + "repository".repeat(7), startedAt);

for (const [id, state] of [
  ["seed-ghes-review", "reconciliation_required"],
  ["seed-ghes-waiting", "queued"],
] as const) {
  db.query(`INSERT INTO migrations (id, source_provider, source_api_url, source_org, source_repo,
    target_org, target_repo, target_platform, target_profile_id, target_api_url, state, started_at)
    VALUES (?, 'bitbucket-server', 'https://bitbucket.invalid', 'project', ?, 'destination',
      'archive', 'ghes', 'enterprise', 'https://ghes.example/api/v3', ?, ?)`).run(
    id,
    "repository".repeat(8),
    state,
    "2021-03-01T12:00:00.000Z",
  );
}
db.query(`INSERT INTO ghes_import_jobs (id, migration_id, phase, ghes_import_id, created_at, updated_at)
  VALUES ('review-job', 'seed-ghes-review', 'importing', 'fixture-guid', ?, ?)`).run(
  startedAt,
  startedAt,
);

db.prepare(
  `INSERT INTO migrations (
     id, source_api_url, source_org, source_repo,
     target_org, target_repo, state, started_at
   ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
).run(
  "seed-e2e-ghe-active",
  "https://api.acme.ghe.com",
  "tenant",
  "live-repo",
  "e2e-target",
  "live-repo",
  startedAt,
);

db.prepare(
  `INSERT INTO profile_runs
     (id, source_api_url, org, state, total_repos, profiled_repos, blockers, warnings, org_resources, started_at, completed_at)
  VALUES (?, ?, ?, 'completed', 2, 2, 1, 0, '{"counts":{"teams":0}}', ?, ?)`,
).run("seed-e2e-profile", "https://ghes.example.com/api/v3", "e2e-source", startedAt, completedAt);

function profileSignals(name: string): RepoSignals {
  return {
    name,
    nameWithOwner: `e2e-source/${name}`,
    visibility: "PRIVATE",
    isArchived: false,
    isFork: false,
    isEmpty: false,
    diskUsageKb: 1024,
    hasWiki: false,
    hasIssues: true,
    hasProjects: false,
    hasDiscussions: false,
    hasPages: false,
    defaultBranch: "main",
    pushedAt: startedAt,
    updatedAt: startedAt,
    commitsCount: 10,
    discussionsCount: 0,
    projectsV2Count: 0,
    environmentsCount: 0,
    releaseAssetBytes: 0,
    stargazerCount: 0,
    watcherCount: 0,
    forkCount: 0,
    rulesetCount: 0,
    branchProtectionRuleCount: 0,
    branchProtectionRulesUsingUnmigratedFeatures: 0,
    packagesCount: 0,
    usesLfs: false,
    workflowFileCount: 0,
    webhooksCount: 0,
    hasCodeScanningAlerts: false,
    collaboratorsCount: 0,
    tagProtectionCount: 0,
    issuesCount: 1,
    pullRequestsCount: 1,
    branchesCount: 1,
    tagsCount: 0,
    releasesCount: 0,
  };
}

const insertProfileRepo = db.prepare(
  `INSERT INTO profile_repos
     (run_id, name_with_owner, signals, blockers, warnings, infos, applying_considerations, created_at)
   VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
);
const readyProfileRepo = insertProfileRepo.run(
  "seed-e2e-profile",
  "e2e-source/ready-repo",
  JSON.stringify(profileSignals("ready-repo")),
  0,
  0,
  JSON.stringify([{ considerationId: "actions-run-history", evidence: "1 workflow" }]),
  startedAt,
);
const blockedProfileRepo = insertProfileRepo.run(
  "seed-e2e-profile",
  "e2e-source/blocked-repo",
  JSON.stringify(profileSignals("blocked-repo")),
  1,
  0,
  JSON.stringify([{ considerationId: "release-size-limit", evidence: "Estimated over limit" }]),
  startedAt,
);

db.prepare(
  `INSERT INTO profile_repository_analysis_runs
     (id, profile_run_id, state, policy_version, selected_repo_count, completed_repo_count,
      failed_repo_count, unknown_size_repo_count, estimated_clone_bytes,
      estimated_peak_workspace_bytes, started_at, completed_at)
   VALUES (?, ?, 'completed', 1, 2, 1, 1, 0, 2097152, 3145728, ?, ?)`,
).run("seed-e2e-analysis", "seed-e2e-profile", startedAt, completedAt);

const insertAnalysisJob = db.prepare(
  `INSERT INTO profile_repository_analysis_jobs
     (id, analysis_run_id, profile_repo_id, name_with_owner, state, priority,
      priority_reasons, estimated_workspace_bytes, attempt, started_at, completed_at,
      failure_reason)
   VALUES (?, 'seed-e2e-analysis', ?, ?, ?, 0, '[]', 3145728, 1, ?, ?, ?)`,
);
insertAnalysisJob.run(
  "seed-e2e-analysis-ready",
  Number(readyProfileRepo.lastInsertRowid),
  "e2e-source/ready-repo",
  "failed",
  startedAt,
  completedAt,
  "Fixture clone failure",
);
insertAnalysisJob.run(
  "seed-e2e-analysis-blocked",
  Number(blockedProfileRepo.lastInsertRowid),
  "e2e-source/blocked-repo",
  "succeeded",
  startedAt,
  completedAt,
  null,
);

db.prepare(
  `INSERT INTO profile_repository_analysis_results
     (id, analysis_job_id, attempt, captured_at, source_ref_fingerprint,
      mirror_size_bytes, git_version, git_lfs_version, git_sizer_version, metrics)
    VALUES (?, ?, 1, ?, ?, 1048576, ?, ?, ?, ?)`,
).run(
  "seed-e2e-analysis-result",
  "seed-e2e-analysis-blocked",
  completedAt,
  "sha256:fixture",
  "git version 2.49.1",
  "git-lfs/3.6.0",
  "git-sizer 1.5.0",
  JSON.stringify({
    uniqueCommitCount: {
      description: "The total number of distinct commit objects",
      value: 18_420,
      unit: "",
      prefixes: "metric",
      referenceValue: 500_000,
      levelOfConcern: 0,
    },
    uniqueBlobCount: {
      description: "The total number of distinct blob objects",
      value: 82_115,
      unit: "",
      prefixes: "metric",
      referenceValue: 500_000,
      levelOfConcern: 0,
    },
    uniqueBlobSize: {
      description: "The total size of distinct blob objects",
      value: 1_073_741_824,
      unit: "B",
      prefixes: "binary",
      referenceValue: 10_000_000_000,
      levelOfConcern: 0,
    },
    referenceCount: {
      description: "The total number of references",
      value: 146,
      unit: "",
      prefixes: "metric",
      referenceValue: 25_000,
      levelOfConcern: 0,
    },
    maxCheckoutPathLength: {
      description: "The maximum path length in any checkout",
      value: 118,
      unit: "B",
      prefixes: "metric",
      referenceValue: 100,
      levelOfConcern: 0,
      objectDescription: "refs/heads/main:src/platform/migrations/repository.ts",
    },
    maxBlobSize: {
      description: "The size of the largest blob object",
      value: 120_000_000,
      unit: "B",
      prefixes: "binary",
      referenceValue: 10_000_000,
      levelOfConcern: 12,
      objectName: "abc123",
      objectDescription: "refs/heads/main:fixtures/archive.bin",
    },
  }),
);

db.prepare(
  `INSERT INTO profile_runs
     (id, source_provider, source_api_url, org, state, total_repos, profiled_repos, started_at, completed_at)
   VALUES (?, 'gitlab', ?, ?, 'completed', 2, 2, ?, ?)`,
).run(
  "seed-e2e-gitlab-profile",
  "https://gitlab.example.com/api/v4",
  "platform/products/services",
  startedAt,
  completedAt,
);

const gitLabProjects = [
  {
    provider: "gitlab",
    sourceId: "101",
    path: "platform/products/services/payments-api",
    name: "payments-api",
    visibility: "private",
    archived: false,
    defaultBranch: "main",
    lastActivityAt: startedAt,
    repositorySizeBytes: { kind: "exact", value: 1_048_576 },
    storageSizeBytes: { kind: "exact", value: 1_310_720 },
    lfsObjectsSizeBytes: { kind: "unavailable", reason: "not-reported" },
    packagesSizeBytes: { kind: "exact", value: 262_144 },
    wikiSizeBytes: { kind: "exact", value: 0 },
    uploadsSizeBytes: { kind: "exact", value: 0 },
  },
  {
    provider: "gitlab",
    sourceId: "102",
    path: "platform/products/services/legacy-web",
    name: "legacy-web",
    visibility: "internal",
    archived: true,
    defaultBranch: null,
    lastActivityAt: startedAt,
    repositorySizeBytes: { kind: "exact", value: 524_288 },
    storageSizeBytes: { kind: "exact", value: 524_288 },
    lfsObjectsSizeBytes: { kind: "exact", value: 0 },
    packagesSizeBytes: { kind: "exact", value: 0 },
    wikiSizeBytes: { kind: "exact", value: 0 },
    uploadsSizeBytes: { kind: "exact", value: 0 },
  },
] as const;
const gitLabInventory = {
  version: 1,
  provider: "gitlab",
  sourceApiUrl: "https://gitlab.example.com/api/v4",
  namespace: "platform/products/services",
  projectCount: { kind: "at-least", value: 2 },
  projects: gitLabProjects,
};
const gitLabSummary = {
  projectCount: gitLabInventory.projectCount,
  projectsCaptured: 2,
  visibility: { public: 0, private: 1, internal: 1 },
  archivedProjects: 1,
  projectsWithoutDefaultBranch: 1,
  storage: {
    repositorySizeBytes: { kind: "exact", value: 1_572_864 },
    storageSizeBytes: { kind: "exact", value: 1_835_008 },
    lfsObjectsSizeBytes: { kind: "unavailable", reason: "not-reported" },
    packagesSizeBytes: { kind: "exact", value: 262_144 },
    wikiSizeBytes: { kind: "exact", value: 0 },
    uploadsSizeBytes: { kind: "exact", value: 0 },
  },
};
db.prepare(
  `INSERT INTO profile_source_inventories (run_id, payload, summary, fetched_at)
   VALUES (?, ?, ?, ?)`,
).run(
  "seed-e2e-gitlab-profile",
  JSON.stringify(gitLabInventory),
  JSON.stringify(gitLabSummary),
  completedAt,
);
const insertInventoryProject = db.prepare(
  `INSERT INTO profile_source_inventory_projects
     (run_id, position, source_id, path, payload)
   VALUES (?, ?, ?, ?, ?)`,
);
for (const [position, project] of gitLabProjects.entries()) {
  insertInventoryProject.run(
    "seed-e2e-gitlab-profile",
    position,
    project.sourceId,
    project.path,
    JSON.stringify(project),
  );
}

db.prepare(
  `INSERT INTO profile_runs
     (id, source_provider, source_api_url, org, state, total_repos, profiled_repos, started_at, completed_at)
   VALUES (?, 'bitbucket-server', ?, ?, 'completed', 2, 2, ?, ?)`,
).run(
  "seed-e2e-bitbucket-profile",
  "https://bitbucket.example.com/rest/api/1.0",
  "PLATFORM",
  startedAt,
  completedAt,
);

const bitbucketProjects = [
  {
    provider: "bitbucket-server",
    sourceId: "201",
    path: "PLATFORM/payments-api",
    name: "Payments API",
    visibility: "private",
    archived: false,
    defaultBranch: "main",
    lastActivityAt: startedAt,
    repositorySizeBytes: { kind: "exact", value: 2_097_152 },
    storageSizeBytes: { kind: "exact", value: 2_097_152 },
    lfsObjectsSizeBytes: { kind: "unavailable", reason: "not-reported" },
    packagesSizeBytes: { kind: "unavailable", reason: "not-reported" },
    wikiSizeBytes: { kind: "unavailable", reason: "not-reported" },
    uploadsSizeBytes: { kind: "unavailable", reason: "not-reported" },
    providerDetails: {
      provider: "bitbucket-server",
      webUrl: "https://bitbucket.example.com/projects/PLATFORM/repos/payments-api/browse",
      description: "Payments API",
      scmId: "git",
      forkable: true,
      state: "AVAILABLE",
    },
  },
  {
    provider: "bitbucket-server",
    sourceId: "202",
    path: "PLATFORM/legacy-web",
    name: "Legacy Web",
    visibility: "public",
    archived: true,
    defaultBranch: null,
    lastActivityAt: startedAt,
    repositorySizeBytes: { kind: "unavailable", reason: "not-reported" },
    storageSizeBytes: { kind: "unavailable", reason: "not-reported" },
    lfsObjectsSizeBytes: { kind: "unavailable", reason: "not-reported" },
    packagesSizeBytes: { kind: "unavailable", reason: "not-reported" },
    wikiSizeBytes: { kind: "unavailable", reason: "not-reported" },
    uploadsSizeBytes: { kind: "unavailable", reason: "not-reported" },
    providerDetails: {
      provider: "bitbucket-server",
      webUrl: "https://bitbucket.example.com/projects/PLATFORM/repos/legacy-web/browse",
      scmId: "git",
      forkable: false,
      state: "ARCHIVED",
    },
  },
] as const;
const bitbucketInventory = {
  version: 1,
  provider: "bitbucket-server",
  sourceApiUrl: "https://bitbucket.example.com/rest/api/1.0",
  namespace: "PLATFORM",
  projectCount: { kind: "exact", value: 2 },
  projects: bitbucketProjects,
};
const bitbucketSummary = {
  projectCount: bitbucketInventory.projectCount,
  projectsCaptured: 2,
  visibility: { public: 1, private: 1, internal: 0 },
  archivedProjects: 1,
  projectsWithoutDefaultBranch: 1,
  storage: {
    repositorySizeBytes: { kind: "unavailable", reason: "not-reported" },
    storageSizeBytes: { kind: "unavailable", reason: "not-reported" },
    lfsObjectsSizeBytes: { kind: "unavailable", reason: "not-reported" },
    packagesSizeBytes: { kind: "unavailable", reason: "not-reported" },
    wikiSizeBytes: { kind: "unavailable", reason: "not-reported" },
    uploadsSizeBytes: { kind: "unavailable", reason: "not-reported" },
  },
};
db.prepare(
  `INSERT INTO profile_source_inventories (run_id, payload, summary, fetched_at)
   VALUES (?, ?, ?, ?)`,
).run(
  "seed-e2e-bitbucket-profile",
  JSON.stringify(bitbucketInventory),
  JSON.stringify(bitbucketSummary),
  completedAt,
);
for (const [position, project] of bitbucketProjects.entries()) {
  insertInventoryProject.run(
    "seed-e2e-bitbucket-profile",
    position,
    project.sourceId,
    project.path,
    JSON.stringify(project),
  );
}

const insertFailedNativeMigration = db.prepare(
  `INSERT INTO migrations (
     id, source_provider, source_api_url, source_org, source_repo,
     target_org, target_repo, state, failure_reason, started_at, completed_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', 'Seeded native migration failure', ?, ?)`,
);
insertFailedNativeMigration.run(
  "seed-e2e-gitlab-failed",
  "gitlab",
  "https://gitlab.example.com/api/v4",
  "platform/products/services",
  "payments-api",
  "e2e-target",
  "payments-api",
  startedAt,
  completedAt,
);
insertFailedNativeMigration.run(
  "seed-e2e-bitbucket-failed",
  "bitbucket-server",
  "https://bitbucket.example.com/rest/api/1.0",
  "PLATFORM",
  "payments-api",
  "e2e-target",
  "payments-api",
  startedAt,
  completedAt,
);

db.prepare(
  "UPDATE migrations SET batch_id='seed-e2e-batch-bitbucket', target_platform='ghes', target_profile_id='ghes', failure_reason=? WHERE id='seed-e2e-bitbucket-failed'",
).run(
  "Bundler will use /tmp temporarily.\nPermission denied @ rb_sysopen - /workspace/export.tar.gz (Errno::EACCES)\nfrom /opt/bbs-exporter/lib/bbs_exporter/archiver.rb",
);
const importStep = db.prepare(`INSERT INTO events (migration_id,event_type,payload,created_at)
  VALUES ('seed-e2e-bitbucket-failed', ?, ?, ?)`);
for (const [type, message] of [
  ["step", "Previous attempt"],
  ["restart", "Migration restarted"],
  ["step", "Starting Bitbucket Server export"],
] as const) {
  importStep.run(type, JSON.stringify({ message }), startedAt);
}
db.close();
