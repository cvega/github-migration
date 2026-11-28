import type { ProfilePlanRepo } from "$lib/profile/migration-plan";
import { getDb } from "$lib/server/core/db";
import { parseSourceProjectInventory } from "$lib/source/inventory";
import { getSourceProviderAdapter } from "$lib/source-provider";
import type { RepoProfile } from "../analysis/repos";
import type { RepoSignals, StoredRepoProfile } from "../types";
import { repositoryNamespace } from "./namespace";
import { parsePersistedCatalogMatches, parsePersistedRepoSignals } from "./results";
import { getProfileRun } from "./runs";

interface ProfileRepoRow {
  name_with_owner: string;
  signals: string;
  blockers: number;
  warnings: number;
  infos: number;
  applying_considerations: string;
}

function rowToRepoProfile(row: ProfileRepoRow): StoredRepoProfile {
  return {
    nameWithOwner: row.name_with_owner,
    signals: parsePersistedRepoSignals(row.signals),
    blockers: row.blockers,
    warnings: row.warnings,
    infos: row.infos,
    catalogMatches: parsePersistedCatalogMatches(row.applying_considerations),
  };
}

export function recordRepoProfile(
  runId: string,
  signals: RepoSignals,
  profile: RepoProfile,
  nowMs?: number,
): void {
  const persistedMatches = profile.findings
    .filter((finding) => finding.status === "applies")
    .map((finding) => ({
      catalogEntryId: finding.entry.id,
      evidence: finding.evidence ?? "",
    }));

  const result = getDb()
    .prepare(
      `INSERT INTO profile_repos
				 (run_id, name_with_owner, signals, blockers, warnings, infos, applying_considerations, created_at)
			 SELECT $run_id, $name, $signals, $blockers, $warnings, $infos, $applying, $created_at
			 WHERE EXISTS (
				 SELECT 1 FROM profile_runs
				 WHERE profile_runs.id = $id AND profile_runs.state = 'running'
			 )
			 ON CONFLICT(run_id, name_with_owner) DO UPDATE SET
				 signals = excluded.signals,
				 blockers = excluded.blockers,
				 warnings = excluded.warnings,
				 infos = excluded.infos,
				 applying_considerations = excluded.applying_considerations,
				 created_at = excluded.created_at`,
    )
    .run({
      $run_id: runId,
      $name: profile.nameWithOwner,
      $signals: JSON.stringify(signals),
      $blockers: profile.summary.blockers,
      $warnings: profile.summary.warnings,
      $infos: profile.summary.infos,
      $applying: JSON.stringify(persistedMatches),
      $created_at: new Date(nowMs ?? Date.now()).toISOString(),
      $id: runId,
    });
  if (result.changes === 0) throw new Error("Repositories can only be saved to a running run");
}

export function recordRepoProfiles(
  runId: string,
  records: ReadonlyArray<{ signals: RepoSignals; profile: RepoProfile }>,
  nowMs?: number,
): void {
  if (records.length === 0) return;
  const recordedAt = nowMs ?? Date.now();
  getDb().transaction(() => {
    for (const record of records) {
      recordRepoProfile(runId, record.signals, record.profile, recordedAt);
    }
  })();
}

export function getRunRepoProfiles(runId: string): StoredRepoProfile[] {
  const rows = getDb()
    .prepare(
      `SELECT name_with_owner, signals, blockers, warnings, infos, applying_considerations
			 FROM profile_repos WHERE run_id = $id ORDER BY name_with_owner ASC`,
    )
    .all({ $id: runId }) as ProfileRepoRow[];
  return rows.map(rowToRepoProfile);
}

export type RepoReadinessFilter = "all" | "ready" | "warnings" | "blockers";

export interface RunRepoProfilePage {
  repos: StoredRepoProfile[];
  page: number;
  totalPages: number;
  total: number;
  limit: number;
}

export function* iterateRunRepoProfiles(
  runId: string,
  namespace?: string,
): IterableIterator<StoredRepoProfile> {
  const scope = repositoryNamespace("name_with_owner", namespace);
  const rows = getDb()
    .prepare(
      `SELECT name_with_owner, signals, blockers, warnings, infos, applying_considerations
			 FROM profile_repos WHERE run_id = $id${scope.sql} ORDER BY name_with_owner ASC`,
    )
    .iterate({ $id: runId, ...scope.params }) as IterableIterator<ProfileRepoRow>;
  for (const row of rows) yield rowToRepoProfile(row);
}

export function getRunRepoProfilesPage(
  runId: string,
  options: {
    page?: number;
    limit?: number;
    search?: string;
    readiness?: RepoReadinessFilter;
    namespace?: string;
  } = {},
): RunRepoProfilePage {
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 25)));
  const requestedPage = Math.max(1, Math.trunc(options.page ?? 1));
  const search = options.search?.trim().toLowerCase() ?? "";
  const readiness = options.readiness ?? "all";
  const readinessSql = {
    all: "1 = 1",
    ready: "blockers = 0",
    warnings: "blockers = 0 AND warnings > 0",
    blockers: "blockers > 0",
  }[readiness];
  const scope = repositoryNamespace("name_with_owner", options.namespace);
  const where = `run_id = $id${scope.sql} AND instr(lower(name_with_owner), $search) > 0 AND ${readinessSql}`;
  const bindings = { $id: runId, $search: search, ...scope.params };
  const total = (
    getDb().prepare(`SELECT COUNT(*) AS count FROM profile_repos WHERE ${where}`).get(bindings) as {
      count: number;
    }
  ).count;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requestedPage, totalPages);
  const rows = getDb()
    .prepare(
      `SELECT name_with_owner, signals, blockers, warnings, infos, applying_considerations
			 FROM profile_repos WHERE ${where}
			 ORDER BY name_with_owner ASC LIMIT $limit OFFSET $offset`,
    )
    .all({ ...bindings, $limit: limit, $offset: (page - 1) * limit }) as ProfileRepoRow[];
  return { repos: rows.map(rowToRepoProfile), page, totalPages, total, limit };
}

export interface PlanningRow {
  nameWithOwner: string;
  blockers: number;
  warnings: number;
  isEmpty: number | null;
  releaseComplete: number | null;
  rulesComplete: number | null;
}

export const PLANNING_COLUMNS = `name_with_owner AS nameWithOwner, blockers, warnings,
  json_extract(signals, '$.isEmpty') AS isEmpty,
  json_extract(signals, '$.releaseAssetScanComplete') AS releaseComplete,
  json_extract(signals, '$.branchRuleScanComplete') AS rulesComplete`;

export function planningRepo(row: PlanningRow): ProfilePlanRepo {
  const { isEmpty, releaseComplete, rulesComplete, ...repo } = row;
  const planning = isEmpty === 1 ? { ...repo, isEmpty: true } : repo;
  return releaseComplete === 1 && rulesComplete === 1
    ? planning
    : { ...planning, incompleteReadinessScan: true };
}

export function getRunRepoPlanProfiles(
  runId: string,
  limit: number,
  namespace?: string,
): ProfilePlanRepo[] {
  const boundedLimit = Math.max(0, Math.trunc(limit));
  const scope = repositoryNamespace("name_with_owner", namespace);
  const profiles = getDb()
    .prepare(
      `SELECT ${PLANNING_COLUMNS}
			 FROM profile_repos WHERE run_id = $id${scope.sql}
			 ORDER BY name_with_owner ASC LIMIT $limit`,
    )
    .all({ $id: runId, $limit: boundedLimit, ...scope.params }) as PlanningRow[];
  if (profiles.length > 0) return profiles.map(planningRepo);
  const inventoryScope = repositoryNamespace("path", namespace);
  const inventoryProjects = getDb()
    .prepare(
      `SELECT path AS nameWithOwner, payload
			 FROM profile_source_inventory_projects WHERE run_id = $id${inventoryScope.sql}
			 ORDER BY position LIMIT $limit`,
    )
    .all({ $id: runId, $limit: boundedLimit, ...inventoryScope.params }) as Array<{
    nameWithOwner: string;
    payload: string;
  }>;
  return inventoryProjects.map((row) => {
    const project = parseSourceProjectInventory(JSON.parse(row.payload));
    const details = project.providerDetails;
    if (namespace && details?.forkedFromPath) {
      const fork = details.forkedFromPath;
      if (fork.slice(0, fork.lastIndexOf("/")) !== namespace) delete details.forkedFromPath;
    }
    return {
      nameWithOwner: row.nameWithOwner,
      blockers: 0,
      warnings: 0,
      ...(details ? { providerDetails: details } : {}),
    };
  });
}

export function findMissingProfileProjectPaths(runId: string, paths: readonly string[]): string[] {
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length === 0) return [];
  const placeholders = uniquePaths.map(() => "?").join(", ");
  const run = getProfileRun(runId);
  if (!run) return uniquePaths;
  const rows =
    getSourceProviderAdapter(run.sourceProvider).profileKind === "source-inventory"
      ? (getDb()
          .prepare(
            `SELECT path FROM profile_source_inventory_projects
						 WHERE run_id = ? AND path IN (${placeholders})`,
          )
          .all(runId, ...uniquePaths) as Array<{ path: string }>)
      : (getDb()
          .prepare(
            `SELECT name_with_owner AS path FROM profile_repos
						 WHERE run_id = ? AND name_with_owner IN (${placeholders})`,
          )
          .all(runId, ...uniquePaths) as Array<{ path: string }>);
  const found = new Set(rows.map((row) => row.path));
  return uniquePaths.filter((path) => !found.has(path));
}
