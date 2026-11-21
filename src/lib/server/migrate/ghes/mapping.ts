import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

type MappingRow = Record<string, string> & {
  model_name: string;
  source_url: string;
  target_url: string;
};

function parseRows(csv: string): MappingRow[] {
  if (!csv.trim()) return [];
  const rows = parse(csv, {
    columns: (columns: string[]) => {
      if (!["model_name", "source_url", "target_url"].every((column) => columns.includes(column))) {
        throw new Error("ghe-migrator CSV is missing required mapping columns");
      }
      return columns;
    },
    bom: true,
    skip_empty_lines: true,
    relax_column_count: false,
    trim: true,
  }) as MappingRow[];
  for (const row of rows) {
    if (!row.model_name || !row.source_url) {
      throw new Error("ghe-migrator CSV is missing required mapping columns");
    }
  }
  return rows;
}

function targetUrl(webUrl: string, ...segments: string[]): string {
  return `${webUrl.replace(/\/+$/, "")}/${segments.map(encodeURIComponent).join("/")}`;
}

export function getGhesUserConflicts(conflictsCsv: string): string[] {
  return parseRows(conflictsCsv)
    .filter((row) => row.model_name === "user")
    .map((row) => row.source_url);
}

export function buildGhesMigrationMap(
  conflictsCsv: string,
  recordsCsv: string,
  webUrl: string,
  targetOrg: string,
  targetRepo: string,
  userMappings: ReadonlyMap<string, string> = new Map(),
): string {
  const deduplicated = new Map<string, MappingRow>();
  for (const original of [...parseRows(conflictsCsv), ...parseRows(recordsCsv)]) {
    const row = { ...original };
    const actionColumn = "recommended_action" in row ? "recommended_action" : "state";
    if (!(actionColumn in row)) throw new Error("ghe-migrator CSV is missing an action column");
    const targetLogin = row.model_name === "user" ? userMappings.get(row.source_url) : undefined;
    if (targetLogin) {
      row.target_url = targetUrl(webUrl, targetLogin);
      row[actionColumn] = "map";
    } else if (row.model_name === "organization") {
      row.target_url = targetUrl(webUrl, targetOrg);
      row[actionColumn] = "map";
    } else if (row.model_name === "repository") {
      row.target_url = targetUrl(webUrl, targetOrg, targetRepo);
      row[actionColumn] = "rename";
    }
    if (!row.target_url) {
      throw new Error(
        `GHES ${row.model_name} conflict requires a target URL for ${row.source_url}; resolve the mapping before importing`,
      );
    }
    const action = row[actionColumn];
    if (!action) throw new Error("ghe-migrator CSV contains an empty action");
    row.recommended_action = action;
    delete row.state;
    deduplicated.set(`${row.model_name}\0${row.source_url}`, row);
  }
  if (deduplicated.size === 0) return "";
  return stringify([...deduplicated.values()], {
    header: true,
    columns: ["model_name", "source_url", "target_url", "recommended_action"],
  });
}

export function countGhesAuditFailures(csv: string): number {
  return parseRows(csv).length;
}
