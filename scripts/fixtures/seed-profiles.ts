import type { Database } from "bun:sqlite";
import { summarizeProfileInventory } from "../../src/lib/server/profile/analysis/overview";
import { analyzeRepo } from "../../src/lib/server/profile/analysis/repos";
import { buildProfileDetailRollup } from "../../src/lib/server/profile/analysis/rollup";
import type {
  OrgResources,
  ProfileRunState,
  RepoSignals,
  StoredRepoProfile,
} from "../../src/lib/server/profile/types";
import type {
  NumericObservation,
  SourceNamespaceInventory,
  SourceProjectInventory,
} from "../../src/lib/server/source/inventory";
import type { SourceProvider } from "../../src/lib/source-provider";

const PROFILE_PREFIX = "seed-profile-";

interface ProfileSeedSpec {
  id: string;
  org: string;
  state: ProfileRunState;
  repoCount: number;
  totalRepos?: number;
  sourceApiUrl: string;
  startedAt: string;
  completedAt: string;
  failureReason?: string;
  orgRulesetCount: number;
  orgResources: OrgResources;
  apiCalls: number;
  flavor: "mixed" | "clean" | "large" | "failed";
}

export interface ProfileSeedSummary {
  runs: number;
  repos: number;
  completed: number;
  failed: number;
}

const RUNS: readonly ProfileSeedSpec[] = [
  {
    id: `${PROFILE_PREFIX}mixed`,
    org: "acme-corp",
    state: "completed",
    repoCount: 120,
    sourceApiUrl: "https://ghes.acme.corp/api/v3",
    startedAt: "2026-08-05T13:00:00.000Z",
    completedAt: "2026-08-05T13:18:42.000Z",
    orgRulesetCount: 7,
    orgResources: {
      actionsSecrets: 24,
      actionsVariables: 18,
      dependabotSecrets: 8,
      codespacesSecrets: 5,
      selfHostedRunners: 14,
      customProperties: 6,
      teams: 32,
      appInstallations: 11,
    },
    apiCalls: 684,
    flavor: "mixed",
  },
  {
    id: `${PROFILE_PREFIX}clean`,
    org: "northstar-hq",
    state: "completed",
    repoCount: 32,
    sourceApiUrl: "https://api.github.com",
    startedAt: "2026-08-03T09:30:00.000Z",
    completedAt: "2026-08-03T09:33:18.000Z",
    orgRulesetCount: 0,
    orgResources: {
      actionsSecrets: 2,
      actionsVariables: 4,
      dependabotSecrets: 0,
      codespacesSecrets: 0,
      selfHostedRunners: 0,
      customProperties: 2,
      teams: 6,
      appInstallations: 3,
    },
    apiCalls: 176,
    flavor: "clean",
  },
  {
    id: `${PROFILE_PREFIX}large`,
    org: "atlas-platform",
    state: "completed",
    repoCount: 180,
    sourceApiUrl: "https://github.atlas.example/api/v3",
    startedAt: "2026-07-28T15:00:00.000Z",
    completedAt: "2026-07-28T15:41:09.000Z",
    orgRulesetCount: 12,
    orgResources: {
      actionsSecrets: 43,
      actionsVariables: 57,
      dependabotSecrets: 15,
      codespacesSecrets: 9,
      selfHostedRunners: 28,
      customProperties: 14,
      teams: 71,
      appInstallations: 26,
    },
    apiCalls: 1042,
    flavor: "large",
  },
  {
    id: `${PROFILE_PREFIX}failed`,
    org: "legacy-systems",
    state: "failed",
    repoCount: 17,
    totalRepos: 50,
    sourceApiUrl: "https://github.legacy.example/api/v3",
    startedAt: "2026-07-25T11:00:00.000Z",
    completedAt: "2026-07-25T11:04:27.000Z",
    failureReason: "Source API rate limit exhausted while scanning repository details",
    orgRulesetCount: 3,
    orgResources: {
      actionsSecrets: 7,
      actionsVariables: 3,
      dependabotSecrets: 2,
      codespacesSecrets: 0,
      selfHostedRunners: 9,
      customProperties: 1,
      teams: 18,
      appInstallations: 5,
    },
    apiCalls: 96,
    flavor: "failed",
  },
];

interface SourceInventorySeedSpec {
  id: string;
  provider: Extract<SourceProvider, "gitlab" | "bitbucket-server">;
  sourceApiUrl: string;
  namespace: string;
  projectCount: number;
  startedAt: string;
  completedAt: string;
}

const SOURCE_INVENTORY_RUNS: readonly SourceInventorySeedSpec[] = [
  {
    id: `${PROFILE_PREFIX}gitlab-enterprise`,
    provider: "gitlab",
    sourceApiUrl: "https://gitlab.example.com/api/v4",
    namespace: "enterprise/platform",
    projectCount: 250,
    startedAt: "2026-08-06T14:00:00.000Z",
    completedAt: "2026-08-06T14:12:31.000Z",
  },
  {
    id: `${PROFILE_PREFIX}bitbucket-enterprise`,
    provider: "bitbucket-server",
    sourceApiUrl: "https://bitbucket.example.com/rest/api/1.0",
    namespace: "ENTERPRISE",
    projectCount: 250,
    startedAt: "2026-08-06T15:00:00.000Z",
    completedAt: "2026-08-06T15:11:48.000Z",
  },
];

const unavailable = (): NumericObservation => ({ kind: "unavailable", reason: "not-reported" });
const exact = (value: number): NumericObservation => ({ kind: "exact", value });

function sourceInventoryProject(
  spec: SourceInventorySeedSpec,
  index: number,
): SourceProjectInventory {
  const number = String(index + 1).padStart(3, "0");
  const slug = `service-${number}`;
  const archived = index > 0 && index % 19 === 0;
  const defaultBranch = index > 0 && index % 23 === 0 ? null : "main";
  const lastActivityAt = new Date(
    Date.UTC(2026, 7, 6 - (index % 28), 12, index % 60),
  ).toISOString();

  if (spec.provider === "gitlab") {
    const repositorySize = (8 + ((index * 37) % 1_992)) * 1024 * 1024;
    const lfsSize = index % 11 === 0 ? (index + 1) * 16 * 1024 * 1024 : 0;
    const packagesSize = index % 7 === 0 ? (index + 3) * 4 * 1024 * 1024 : 0;
    const wikiSize = index % 5 === 0 ? (index + 1) * 128 * 1024 : 0;
    const uploadsSize = index % 9 === 0 ? (index + 1) * 256 * 1024 : 0;
    return {
      provider: "gitlab",
      sourceId: `gitlab-${1_000 + index}`,
      path: `${spec.namespace}/${slug}`,
      name: slug,
      visibility: index % 13 === 0 ? "public" : index % 7 === 0 ? "internal" : "private",
      archived,
      defaultBranch,
      lastActivityAt,
      repositorySizeBytes: exact(repositorySize),
      storageSizeBytes: exact(repositorySize + lfsSize + packagesSize + wikiSize + uploadsSize),
      lfsObjectsSizeBytes: index % 41 === 0 ? unavailable() : exact(lfsSize),
      packagesSizeBytes: exact(packagesSize),
      wikiSizeBytes: exact(wikiSize),
      uploadsSizeBytes: exact(uploadsSize),
      jobArtifactsSizeBytes: unavailable(),
      pipelineArtifactsSizeBytes: unavailable(),
      snippetsSizeBytes: unavailable(),
      containerRegistrySizeBytes: unavailable(),
      providerDetails: {
        provider: "gitlab",
        webUrl: `https://gitlab.example.com/${spec.namespace}/${slug}`,
        description: `Seeded GitLab platform service ${number}`,
        topics: ["platform", index % 4 === 0 ? "customer-facing" : "internal-service"],
        emptyRepository: index > 0 && index % 47 === 0,
        features: {
          issues: true,
          mergeRequests: true,
          wiki: index % 5 === 0,
          snippets: index % 8 === 0,
          containerRegistry: index % 3 === 0,
        },
      },
    };
  }

  return {
    provider: "bitbucket-server",
    sourceId: `bitbucket-${2_000 + index}`,
    path: `${spec.namespace}/${slug}`,
    name: `Service ${number}`,
    visibility: index % 11 === 0 ? "public" : "private",
    archived,
    defaultBranch,
    lastActivityAt,
    repositorySizeBytes: unavailable(),
    storageSizeBytes: unavailable(),
    lfsObjectsSizeBytes: unavailable(),
    packagesSizeBytes: unavailable(),
    wikiSizeBytes: unavailable(),
    uploadsSizeBytes: unavailable(),
    jobArtifactsSizeBytes: unavailable(),
    pipelineArtifactsSizeBytes: unavailable(),
    snippetsSizeBytes: unavailable(),
    containerRegistrySizeBytes: unavailable(),
    providerDetails: {
      provider: "bitbucket-server",
      webUrl: `https://bitbucket.example.com/projects/${spec.namespace}/repos/${slug}/browse`,
      description: `Seeded Bitbucket platform service ${number}`,
      scmId: "git",
      forkable: index % 17 !== 0,
      rootLfsRules: "unknown",
      state: archived ? "ARCHIVED" : "AVAILABLE",
    },
  };
}

function seedSourceInventories(db: Database): number {
  const upsertRun = db.prepare(`
    INSERT INTO profile_runs (
      id, source_provider, source_api_url, org, state, total_repos, profiled_repos,
      blockers, warnings, org_resources, api_calls, detail_rollup,
      started_at, completed_at, failure_reason
    ) VALUES (?, ?, ?, ?, 'completed', ?, ?, 0, 0, '{"counts":{}}', ?, NULL, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      source_provider = excluded.source_provider,
      source_api_url = excluded.source_api_url,
      org = excluded.org,
      state = excluded.state,
      total_repos = excluded.total_repos,
      profiled_repos = excluded.profiled_repos,
      blockers = excluded.blockers,
      warnings = excluded.warnings,
      org_resources = excluded.org_resources,
      api_calls = excluded.api_calls,
      detail_rollup = excluded.detail_rollup,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      failure_reason = excluded.failure_reason
  `);
  const upsertInventory = db.prepare(`
    INSERT INTO profile_source_inventories
      (run_id, project_count, summary, fetched_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      project_count = excluded.project_count,
      summary = excluded.summary,
      fetched_at = excluded.fetched_at
  `);
  const insertProject = db.prepare(`
    INSERT INTO profile_source_inventory_projects
      (run_id, position, source_id, path, payload)
    VALUES (?, ?, ?, ?, ?)
  `);

  let projectsSeeded = 0;
  for (const spec of SOURCE_INVENTORY_RUNS) {
    const projects = Array.from({ length: spec.projectCount }, (_, index) =>
      sourceInventoryProject(spec, index),
    );
    const inventory: SourceNamespaceInventory = {
      version: 1,
      provider: spec.provider,
      sourceApiUrl: spec.sourceApiUrl,
      namespace: spec.namespace,
      projectCount: {
        kind: spec.provider === "gitlab" ? "at-least" : "exact",
        value: projects.length,
      },
      projects,
    };
    upsertRun.run(
      spec.id,
      spec.provider,
      spec.sourceApiUrl,
      spec.namespace,
      projects.length,
      projects.length,
      Math.ceil(projects.length / 100) * 2,
      spec.startedAt,
      spec.completedAt,
    );
    upsertInventory.run(
      spec.id,
      JSON.stringify(inventory.projectCount),
      JSON.stringify(summarizeProfileInventory(inventory)),
      spec.completedAt,
    );
    for (const [position, project] of projects.entries()) {
      insertProject.run(spec.id, position, project.sourceId, project.path, JSON.stringify(project));
    }
    projectsSeeded += projects.length;
  }
  return projectsSeeded;
}

function baseSignals(org: string, index: number): RepoSignals {
  const suffix = String(index + 1).padStart(3, "0");
  return {
    name: `service-${suffix}`,
    nameWithOwner: `${org}/service-${suffix}`,
    visibility: index % 9 === 0 ? "INTERNAL" : "PRIVATE",
    isArchived: false,
    isFork: false,
    isEmpty: false,
    diskUsageKb: 8_000 + index * 1_337,
    hasWiki: false,
    hasIssues: true,
    hasProjects: false,
    hasDiscussions: false,
    hasPages: false,
    defaultBranch: "main",
    pushedAt: new Date(Date.UTC(2026, 6, 31 - (index % 20))).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 7, 1 - (index % 15))).toISOString(),
    commitsCount: 120 + index * 17,
    discussionsCount: 0,
    projectsV2Count: 0,
    environmentsCount: 0,
    releaseAssetBytes: 0,
    releaseAssetScanComplete: true,
    branchRuleScanComplete: true,
    stargazerCount: 0,
    watcherCount: 0,
    forkCount: 0,
    rulesetCount: 0,
    branchProtectionRuleCount: index % 4,
    branchProtectionRulesUsingUnmigratedFeatures: 0,
    packagesCount: 0,
    usesLfs: false,
    workflowFileCount: 0,
    webhooksCount: 0,
    hasCodeScanningAlerts: false,
    collaboratorsCount: 0,
    tagProtectionCount: 0,
    issuesCount: index * 11,
    pullRequestsCount: index * 7,
    branchesCount: 2 + (index % 18),
    tagsCount: index % 24,
    releasesCount: index % 8,
  };
}

function signalsFor(spec: ProfileSeedSpec, index: number): RepoSignals {
  const signals = baseSignals(spec.org, index);
  if (spec.flavor === "clean") {
    return {
      ...signals,
      name: `modern-service-${String(index + 1).padStart(2, "0")}`,
      nameWithOwner: `${spec.org}/modern-service-${String(index + 1).padStart(2, "0")}`,
    };
  }

  const large = spec.flavor === "large";
  return {
    ...signals,
    diskUsageKb:
      index % 41 === 0
        ? 6 * 1024 * 1024 + index * 100
        : index % 17 === 0
          ? 2 * 1024 * 1024 + index * 100
          : (signals.diskUsageKb ?? 0) * (large ? 3 : 1),
    isArchived: index % 23 === 0,
    isFork: index % 29 === 0,
    isEmpty: index % 37 === 0,
    hasWiki: index % 7 === 0,
    hasDiscussions: index % 11 === 0,
    hasPages: index % 19 === 0,
    pushedAt:
      index % 13 === 0 ? new Date(Date.UTC(2022, index % 12, 1)).toISOString() : signals.pushedAt,
    discussionsCount: index % 11 === 0 ? 3 + (index % 20) : 0,
    projectsV2Count: index % 8 === 0 ? 1 + (index % 4) : 0,
    environmentsCount: index % 6 === 0 ? 2 + (index % 7) : 0,
    releaseAssetBytes:
      index % 43 === 0 ? 44 * 1024 ** 3 : index % 21 === 0 ? 12 * 1024 ** 3 : index * 1024 ** 2,
    stargazerCount: index % 5 === 0 ? 12 + index * 3 : 0,
    watcherCount: index % 5 === 0 ? 4 + index : 0,
    forkCount: index % 29 === 0 ? 2 + (index % 8) : 0,
    rulesetCount: index % 10 === 0 ? 1 + (index % 3) : 0,
    branchProtectionRulesUsingUnmigratedFeatures: index % 9 === 0 ? 1 : 0,
    packagesCount: index % 12 === 0 ? 1 + (index % 6) : 0,
    usesLfs: index % 16 === 0,
    workflowFileCount: index % 4 === 0 ? 1 + (index % 9) : 0,
    webhooksCount: index % 6 === 0 ? 1 + (index % 5) : 0,
    hasCodeScanningAlerts: index % 14 === 0,
    collaboratorsCount: index % 9 === 0 ? 2 + (index % 12) : 0,
    tagProtectionCount: index % 18 === 0 ? 1 + (index % 3) : 0,
  };
}

export function seedProfiles(db: Database): ProfileSeedSummary {
  db.prepare(`DELETE FROM profile_repos WHERE run_id LIKE ?`).run(`${PROFILE_PREFIX}%`);
  db.prepare(`DELETE FROM profile_source_project_profiles WHERE run_id LIKE ?`).run(
    `${PROFILE_PREFIX}%`,
  );
  db.prepare(`DELETE FROM profile_source_inventory_projects WHERE run_id LIKE ?`).run(
    `${PROFILE_PREFIX}%`,
  );
  db.prepare(`DELETE FROM profile_source_inventories WHERE run_id LIKE ?`).run(
    `${PROFILE_PREFIX}%`,
  );

  const insertRun = db.prepare(`
    INSERT INTO profile_runs (
      id, source_provider, source_api_url, org, state, total_repos, profiled_repos,
      blockers, warnings, observed_org_ruleset_count, org_resources, api_calls, detail_rollup,
      started_at, completed_at, failure_reason
    ) VALUES (?, 'github', ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_provider = excluded.source_provider,
      source_api_url = excluded.source_api_url,
      org = excluded.org,
      state = excluded.state,
      total_repos = excluded.total_repos,
      profiled_repos = excluded.profiled_repos,
      blockers = excluded.blockers,
      warnings = excluded.warnings,
      observed_org_ruleset_count = excluded.observed_org_ruleset_count,
      org_resources = excluded.org_resources,
      api_calls = excluded.api_calls,
      detail_rollup = excluded.detail_rollup,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      failure_reason = excluded.failure_reason
  `);
  const insertRepo = db.prepare(`
    INSERT INTO profile_repos (
      run_id, name_with_owner, signals, blockers, warnings, infos,
      applying_considerations, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateAggregates = db.prepare(`
    UPDATE profile_runs SET
      profiled_repos = (SELECT COUNT(*) FROM profile_repos WHERE run_id = ?),
      blockers = (SELECT COALESCE(SUM(blockers), 0) FROM profile_repos WHERE run_id = ?),
      warnings = (SELECT COALESCE(SUM(warnings), 0) FROM profile_repos WHERE run_id = ?)
    WHERE id = ?
  `);

  const updateRollup = db.prepare("UPDATE profile_runs SET detail_rollup = ? WHERE id = ?");
  let repos = 0;
  for (const spec of RUNS) {
    insertRun.run(
      spec.id,
      spec.sourceApiUrl,
      spec.org,
      spec.state,
      spec.totalRepos ?? spec.repoCount,
      0,
      spec.orgRulesetCount,
      JSON.stringify({ counts: spec.orgResources }),
      spec.apiCalls,
      spec.startedAt,
      spec.completedAt,
      spec.failureReason ?? null,
    );

    const stored: StoredRepoProfile[] = [];
    for (let index = 0; index < spec.repoCount; index++) {
      const signals = signalsFor(spec, index);
      const profile = analyzeRepo(signals);
      const applying = profile.findings
        .filter((finding) => finding.status === "applies")
        .map((finding) => ({
          catalogEntryId: finding.entry.id,
          evidence: finding.evidence ?? "",
        }));
      insertRepo.run(
        spec.id,
        signals.nameWithOwner,
        JSON.stringify(signals),
        profile.summary.blockers,
        profile.summary.warnings,
        profile.summary.infos,
        JSON.stringify(applying),
        spec.completedAt,
      );
      stored.push({
        nameWithOwner: signals.nameWithOwner,
        signals,
        ...profile.summary,
        catalogMatches: applying,
      });
      repos++;
    }
    updateAggregates.run(spec.id, spec.id, spec.id, spec.id);
    if (spec.state === "completed") {
      updateRollup.run(JSON.stringify(buildProfileDetailRollup(stored)), spec.id);
    }
  }

  repos += seedSourceInventories(db);

  return {
    runs: RUNS.length + SOURCE_INVENTORY_RUNS.length,
    repos,
    completed:
      RUNS.filter((run) => run.state === "completed").length + SOURCE_INVENTORY_RUNS.length,
    failed: RUNS.filter((run) => run.state === "failed").length,
  };
}
