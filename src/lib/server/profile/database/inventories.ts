import { getDb } from "$lib/server/core/db";
import { parseSourceNamespaceInventory } from "$lib/source/inventory";
import { parseBitbucketProfileEnrichment, parseGitLabProfileEnrichment } from "$lib/source/profile";
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
					 (run_id, payload, project_count, summary, fetched_at)
				 SELECT $run_id, '{}', $project_count, $summary, $fetched_at
				 WHERE EXISTS (
					 SELECT 1 FROM profile_runs
					 WHERE profile_runs.id = $id AND profile_runs.state = 'running'
				 )
				 ON CONFLICT(run_id) DO UPDATE SET
					 payload = '{}',
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

export function getProfileInventory(runId: string): SourceNamespaceInventory | null {
  const row = getDb()
    .prepare("SELECT project_count FROM profile_source_inventories WHERE run_id = $run_id")
    .get({ $run_id: runId }) as ProfileInventoryRow | null;
  if (!row) return null;
  try {
    const run = getProfileRun(runId);
    if (!run) throw new Error("Stored inventory has no owning profile run");
    const projects = getDb()
      .prepare(
        `SELECT payload FROM profile_source_inventory_projects
				 WHERE run_id = $run_id ORDER BY position`,
      )
      .all({ $run_id: runId }) as ProfileInventoryProjectRow[];
    return parseSourceNamespaceInventory({
      version: 1,
      provider: run.sourceProvider,
      sourceApiUrl: run.sourceApiUrl,
      namespace: run.org,
      projectCount: JSON.parse(row.project_count),
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
  try {
    return parseProfileInventorySummary(JSON.parse(row.summary));
  } catch {
    const inventory = getProfileInventory(runId);
    if (!inventory) return null;
    const summary = summarizeProfileInventory(inventory);
    getDb()
      .prepare("UPDATE profile_source_inventories SET summary = $summary WHERE run_id = $run_id")
      .run({ $summary: JSON.stringify(summary), $run_id: runId });
    return summary;
  }
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
