import { getDb } from "$lib/server/core/db";
import type { SourceProvider } from "$lib/source-provider";

interface SourceScope {
  sourceProvider: SourceProvider;
  sourceApiUrl: string;
  namespace: string;
}

interface Repository {
  name: string;
  path: string;
}

const pageSize = 25;

// Only the latest completed snapshot can authorize a submission. In particular,
// never search historical runs for a repository removed from today's inventory.
function currentRun(scope: SourceScope) {
  return getDb()
    .query<{ id: string; completedAt: string }, [SourceProvider, string, string]>(
      `SELECT id, completed_at AS completedAt FROM profile_runs
       WHERE source_provider = ? AND source_api_url = ? AND org = ?
         AND state = 'completed' AND completed_at IS NOT NULL
       ORDER BY completed_at DESC, started_at DESC, id DESC LIMIT 1`,
    )
    .get(scope.sourceProvider, scope.sourceApiUrl, scope.namespace);
}

function profileTable(scope: SourceScope) {
  return scope.sourceProvider === "github"
    ? { table: "profile_repos", column: "name_with_owner" }
    : { table: "profile_source_inventory_projects", column: "path" };
}

function repositories(scope: SourceScope) {
  const { table, column } = profileTable(scope);
  // GitLab inventories can include descendants. Require a single nonempty
  // remaining path segment, not merely a parent namespace prefix.
  return `WITH candidates AS (
    SELECT ${column} AS path, substr(${column}, length($prefix) + 1) AS name
    FROM ${table}
    WHERE run_id = $run AND substr(${column}, 1, length($prefix)) = $prefix
  ), scoped AS (
    SELECT name, path FROM candidates WHERE name NOT IN ('', '.', '..') AND instr(name, '/') = 0
  )`;
}

export function lookupCurrentRepository(scope: SourceScope, repoName: string): Repository | null {
  if (!repoName || repoName === "." || repoName === ".." || repoName.includes("/")) return null;
  const run = currentRun(scope);
  if (!run) return null;
  const { table, column } = profileTable(scope);
  return getDb()
    .query<Repository, [string, string, string]>(
      `SELECT ? AS name, ${column} AS path FROM ${table} WHERE run_id = ? AND ${column} = ?`,
    )
    .get(repoName, run.id, `${scope.namespace}/${repoName}`);
}

export function listCurrentRepositories(scope: SourceScope, query: string, requestedPage: number) {
  const run = currentRun(scope);
  const empty = { run, repos: [] as Repository[], total: 0, page: 1, pages: 1 };
  if (!run) return empty;
  const params = { $run: run.id, $prefix: `${scope.namespace}/`, $query: query };
  const filter = "FROM scoped WHERE instr(lower(name), lower($query)) > 0";
  const cte = repositories(scope);
  const db = getDb();
  const total =
    db
      .query<{ count: number }, typeof params>(`${cte} SELECT COUNT(*) AS count ${filter}`)
      .get(params)?.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Number.isSafeInteger(requestedPage)
    ? Math.min(pages, Math.max(1, requestedPage))
    : 1;
  const paging = { ...params, $limit: pageSize, $offset: (page - 1) * pageSize };
  const repos = db
    .query<Repository, typeof paging>(
      `${cte} SELECT name, path ${filter} ORDER BY name COLLATE NOCASE, name LIMIT $limit OFFSET $offset`,
    )
    .all(paging);
  return { run, repos, total, page, pages };
}
