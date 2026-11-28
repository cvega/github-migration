import { getDb } from "$lib/server/core/db";
import { parseConfiguredSourceInventory as parseSourceNamespaceInventory } from "$lib/server/core/source-url";
import {
  bitbucketActivitySchema,
  parseBitbucketProfileEnrichment,
  parseGitLabProfileEnrichment,
} from "$lib/source/profile";
import type {
  BitbucketProfileEnrichment,
  GitLabProfileEnrichment,
  SourceNamespaceInventory,
} from "$lib/source/types";
import { getSourceProviderAdapter } from "$lib/source-provider";
import {
  type ProfileInventorySummary,
  parseProfileInventorySummary,
  summarizeBitbucketEnrichment,
  summarizeGitLabEnrichment,
  summarizeProfileInventory,
} from "../analysis/overview";
import { repositoryNamespace } from "./namespace";
import { failProfileRun, getProfileRun, setProfileRunApiCalls } from "./runs";

interface ProfileInventoryRow {
  project_count: string;
}

interface ProfileInventoryProjectRow {
  payload: string;
}

interface ProfileInventorySummaryRow {
  summary: string;
}

type SourceProfileEnrichment = GitLabProfileEnrichment | BitbucketProfileEnrichment;

export function saveProfileInventory(
  runId: string,
  inventory: SourceNamespaceInventory,
  nowMs?: number,
): void {
  const run = getProfileRun(runId);
  if (!run) throw new Error(`Profile run '${runId}' does not exist`);
  if (run.state !== "running") throw new Error("Inventory can only be saved to a running run");
  if (run.sourceProvider !== inventory.provider) {
    throw new Error("Inventory provider does not match the profile run");
  }
  if (run.sourceApiUrl !== inventory.sourceApiUrl) {
    throw new Error("Inventory source API URL does not match the profile run");
  }
  if (run.org !== inventory.namespace) {
    throw new Error("Inventory namespace does not match the profile run");
  }
  const parsed = parseSourceNamespaceInventory(inventory);
  const database = getDb();
  database.transaction(() => {
    const result = database
      .prepare(
        `INSERT INTO profile_source_inventories
					 (run_id, project_count, summary, fetched_at)
				 SELECT $run_id, $project_count, $summary, $fetched_at
				 WHERE EXISTS (
					 SELECT 1 FROM profile_runs
					 WHERE profile_runs.id = $id AND profile_runs.state = 'running'
				 )
				 ON CONFLICT(run_id) DO UPDATE SET
					 project_count = excluded.project_count,
					 summary = excluded.summary,
					 fetched_at = excluded.fetched_at`,
      )
      .run({
        $run_id: runId,
        $project_count: JSON.stringify(parsed.projectCount),
        $summary: JSON.stringify(summarizeProfileInventory(parsed)),
        $fetched_at: new Date(nowMs ?? Date.now()).toISOString(),
        $id: runId,
      });
    if (result.changes === 0) throw new Error("Inventory can only be saved to a running run");

    database.prepare("DELETE FROM profile_source_inventory_projects WHERE run_id = ?").run(runId);
    const insertProject = database.prepare(
      `INSERT INTO profile_source_inventory_projects
				 (run_id, position, source_id, path, payload)
			 VALUES ($run_id, $position, $source_id, $path, $payload)`,
    );
    for (const [position, project] of parsed.projects.entries()) {
      const details = project.providerDetails;
      if (project.provider === "bitbucket-server") {
        const bitbucket = details?.provider === "bitbucket-server" ? details : undefined;
        project.providerDetails = {
          ...bitbucket,
          provider: "bitbucket-server",
          rootLfsRules: bitbucket?.rootLfsRules ?? "unknown",
        };
      }
      insertProject.run({
        $run_id: runId,
        $position: position,
        $source_id: project.sourceId,
        $path: project.path,
        $payload: JSON.stringify(project),
      });
    }
  })();
}

export function getProfileInventory(
  runId: string,
  namespace?: string,
): SourceNamespaceInventory | null {
  const row = getDb()
    .prepare("SELECT project_count FROM profile_source_inventories WHERE run_id = $run_id")
    .get({ $run_id: runId }) as ProfileInventoryRow | null;
  if (!row) return null;
  try {
    const run = getProfileRun(runId);
    if (!run) throw new Error("Stored inventory has no owning profile run");
    const scope = repositoryNamespace("path", namespace);
    const projects = getDb()
      .prepare(
        `SELECT payload FROM profile_source_inventory_projects
				 WHERE run_id = $run_id${scope.sql} ORDER BY position`,
      )
      .all({ $run_id: runId, ...scope.params }) as ProfileInventoryProjectRow[];
    const projectCount = JSON.parse(row.project_count);
    return parseSourceNamespaceInventory({
      version: 1,
      provider: run.sourceProvider,
      sourceApiUrl: run.sourceApiUrl,
      namespace: run.org,
      projectCount:
        namespace !== undefined && projectCount.kind !== "unavailable"
          ? { kind: projectCount.kind, value: projects.length }
          : projectCount,
      projects: projects.map((project) => JSON.parse(project.payload)),
    });
  } catch (cause) {
    throw new Error(`Invalid stored source inventory for profile run '${runId}'`, { cause });
  }
}

function saveSourceProfileEnrichment(runId: string, enrichment: SourceProfileEnrichment): void {
  const run = getProfileRun(runId);
  if (!run) throw new Error(`Profile run '${runId}' does not exist`);
  if (run.state !== "running") throw new Error("Enrichment can only be saved to a running run");
  if (enrichment.provider !== run.sourceProvider) {
    throw new Error("Enrichment provider does not match the profile run");
  }
  if (run.sourceApiUrl !== enrichment.sourceApiUrl) {
    throw new Error("Enrichment source API URL does not match the profile run");
  }
  if (run.org !== enrichment.namespace) {
    throw new Error("Enrichment namespace does not match the profile run");
  }
  const parsed =
    enrichment.provider === "gitlab"
      ? parseGitLabProfileEnrichment(enrichment)
      : parseBitbucketProfileEnrichment(enrichment);
  const inventory = getProfileInventory(runId);
  if (!inventory) throw new Error("Enrichment requires a persisted source inventory");
  if (parsed.projects.length !== inventory.projects.length) {
    throw new Error("Enrichment projects do not match the source inventory");
  }
  for (const [position, project] of parsed.projects.entries()) {
    const inventoryProject = inventory.projects[position];
    if (
      !inventoryProject ||
      project.sourceId !== inventoryProject.sourceId ||
      project.path !== inventoryProject.path
    ) {
      throw new Error("Enrichment projects do not match the source inventory");
    }
  }

  const database = getDb();
  database.transaction(() => {
    database.prepare("DELETE FROM profile_source_project_profiles WHERE run_id = ?").run(runId);
    const insert = database.prepare(
      `INSERT INTO profile_source_project_profiles (run_id, source_id, path, payload)
			 VALUES ($run_id, $source_id, $path, $payload)`,
    );
    for (const project of parsed.projects) {
      insert.run({
        $run_id: runId,
        $source_id: project.sourceId,
        $path: project.path,
        $payload: JSON.stringify(project),
      });
    }
    const summary = getProfileInventorySummary(runId);
    if (!summary) throw new Error("Enrichment requires a persisted inventory summary");
    database
      .prepare("UPDATE profile_source_inventories SET summary = $summary WHERE run_id = $run_id")
      .run({
        $run_id: runId,
        $summary: JSON.stringify(
          parsed.provider === "gitlab"
            ? summarizeGitLabEnrichment(summary, parsed)
            : summarizeBitbucketEnrichment(summary, parsed),
        ),
      });
  })();
}

export function getProfileInventorySummary(runId: string): ProfileInventorySummary | null {
  const row = getDb()
    .prepare("SELECT summary FROM profile_source_inventories WHERE run_id = $run_id")
    .get({ $run_id: runId }) as ProfileInventorySummaryRow | null;
  if (!row) return null;
  return parseProfileInventorySummary(JSON.parse(row.summary));
}

/** Stored summaries may include GitLab descendants; aggregate only direct projects. */
export function getScopedInventorySummary(runId: string, namespace: string) {
  const inventory = getProfileInventory(runId, namespace);
  if (!inventory) return null;
  const summary = summarizeProfileInventory(inventory);
  const scope = repositoryNamespace("path", namespace);
  const rows = getDb()
    .query<{ payload: string }, Record<string, string>>(
      `SELECT payload FROM profile_source_project_profiles WHERE run_id = $id${scope.sql}`,
    )
    .all({ $id: runId, ...scope.params });
  const enrichment = {
    version: 2,
    provider: inventory.provider,
    namespace,
    sourceApiUrl: inventory.sourceApiUrl,
    projects: rows.map((row) => JSON.parse(row.payload)),
  };
  if (inventory.provider === "bitbucket-server")
    return {
      ...(rows.length
        ? summarizeBitbucketEnrichment(summary, parseBitbucketProfileEnrichment(enrichment))
        : summary),
      lfsTracking: getBitbucketLfsTracking(runId, namespace),
    };
  return rows.length
    ? summarizeGitLabEnrichment(summary, parseGitLabProfileEnrichment(enrichment))
    : summary;
}

export function getBitbucketLfsTracking(runId: string, namespace?: string) {
  const scope = repositoryNamespace("path", namespace);
  const coverage = getDb()
    .query<{ found: number; checked: number; example: string | null }, Record<string, string>>(
      `SELECT count(*) FILTER (WHERE status = 'found') AS found,
        count(*) FILTER (WHERE status IN ('found', 'none')) AS checked,
        min(path) FILTER (WHERE status = 'found') AS example
       FROM (SELECT path, json_extract(payload, '$.providerDetails.rootLfsRules') AS status
             FROM profile_source_inventory_projects WHERE run_id = $id${scope.sql})`,
    )
    .get({ $id: runId, ...scope.params });
  if (!coverage) throw new Error("Could not read LFS tracking coverage");
  return coverage;
}

export function getBitbucketLfsReportRows(runId: string, namespace?: string) {
  const scope = repositoryNamespace("path", namespace);
  return getDb()
    .query<
      { repository: string; defaultBranch: string | null; rootLfsRules: string },
      Record<string, string>
    >(
      `SELECT path AS repository, json_extract(payload, '$.defaultBranch') AS defaultBranch,
        json_extract(payload, '$.providerDetails.rootLfsRules') AS rootLfsRules
       FROM profile_source_inventory_projects WHERE run_id = $id${scope.sql} ORDER BY position`,
    )
    .all({ $id: runId, ...scope.params });
}

export function getBitbucketActivityPage(runId: string, requested: number, namespace?: string) {
  const db = getDb();
  const scope = repositoryNamespace("i.path", namespace);
  const bindings = { $id: runId, ...scope.params };
  const from = `FROM profile_source_inventory_projects i LEFT JOIN profile_source_project_profiles p
      ON p.run_id=i.run_id AND p.source_id=i.source_id AND p.path=i.path WHERE i.run_id=$id${scope.sql}`;
  const coverage = db
    .query<
      { total: number; collected: number; covered: number; open: number | null; withOpen: number },
      Record<string, string>
    >(`SELECT count(*) AS total,
      count(p.source_id) AS collected,
      count(json_extract(p.payload,'$.activity.review.open')) AS covered,
      sum(json_extract(p.payload,'$.activity.review.open')) AS open,
      count(*) FILTER (WHERE json_extract(p.payload,'$.activity.review.open')>0) AS withOpen ${from}`)
    .get(bindings);
  if (!coverage) throw new Error("Could not read review coverage");
  const limit = 10,
    totalPages = Math.max(1, Math.ceil(coverage.total / limit));
  const page = Math.max(1, Math.min(requested, totalPages));
  const rows = db
    .query<{ path: string; activity: string | null }, Record<string, string | number>>(
      `SELECT i.path,json_extract(p.payload,'$.activity') AS activity ${from} ORDER BY i.position LIMIT $limit OFFSET $offset`,
    )
    .all({ ...bindings, $limit: limit, $offset: (page - 1) * limit });
  return {
    coverage,
    pagination: { page, totalPages, total: coverage.total, limit },
    rows: rows.map((row) => ({
      path: row.path,
      activity:
        row.activity === null ? null : bitbucketActivitySchema.parse(JSON.parse(row.activity)),
    })),
  };
}

export function settleProfileInventoryRun(
  runId: string,
  inventory: SourceNamespaceInventory,
  apiCalls: number,
  nowMs?: number,
  enrichment?: SourceProfileEnrichment,
): void {
  getDb().transaction(() => {
    saveProfileInventory(runId, inventory, nowMs);
    if (enrichment) saveSourceProfileEnrichment(runId, enrichment);
    setProfileRunApiCalls(runId, apiCalls);
    if (inventory.projectCount.kind === "unavailable") {
      failProfileRun(
        runId,
        `${getSourceProviderAdapter(inventory.provider).displayName} namespace inventory unavailable: ${inventory.projectCount.reason}`,
        nowMs,
      );
      return;
    }
    const result = getDb()
      .prepare(
        `UPDATE profile_runs SET
					 total_repos = $count,
					 profiled_repos = $count,
					 state = 'completed',
					 completed_at = $completed_at
				 WHERE id = $id AND state = 'running'`,
      )
      .run({
        $id: runId,
        $count: inventory.projects.length,
        $completed_at: new Date(nowMs ?? Date.now()).toISOString(),
      });
    if (result.changes === 0) throw new Error("Inventory can only settle a running run");
  })();
}

export function failProfileInventoryRun(
  runId: string,
  reason: string,
  apiCalls: number,
  nowMs?: number,
): void {
  getDb().transaction(() => {
    setProfileRunApiCalls(runId, apiCalls);
    failProfileRun(runId, reason, nowMs);
  })();
}
