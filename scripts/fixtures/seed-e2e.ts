import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
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
const completedAt = "2026-08-07T12:01:00.000Z";
const startedAt = "2026-08-07T12:00:00.000Z";

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
     target_org, target_repo, state, started_at, failure_reason
   ) VALUES (?, ?, ?, ?, ?, ?, 'reconciliation_required', ?, ?)`,
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
     (id, source_api_url, org, state, total_repos, profiled_repos, blockers, warnings, started_at, completed_at)
   VALUES (?, ?, ?, 'completed', 2, 2, 1, 1, ?, ?)`,
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
insertProfileRepo.run(
  "seed-e2e-profile",
  "e2e-source/ready-repo",
  JSON.stringify(profileSignals("ready-repo")),
  0,
  1,
  JSON.stringify([{ considerationId: "workflow-history", evidence: "1 workflow" }]),
  startedAt,
);
insertProfileRepo.run(
  "seed-e2e-profile",
  "e2e-source/blocked-repo",
  JSON.stringify(profileSignals("blocked-repo")),
  1,
  0,
  JSON.stringify([{ considerationId: "release-size-limit", evidence: "Estimated over limit" }]),
  startedAt,
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

db.close();
