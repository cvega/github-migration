import {
  MIGRATION_CATALOG,
  type MigrationCatalogKind,
  type MigrationCatalogSeverity,
} from "$lib/profile/migration-catalog";
import { releaseScanComplete, ruleScanComplete } from "$lib/profile/readiness";
import type { StoredRepoProfile } from "../types";
import { DETECTED_CATALOG_ENTRY_IDS } from "./detectors";
import { ORG_EVALUATED_CATALOG_ENTRY_IDS } from "./repos";

interface PreparationItem {
  catalogEntryId: string;
  label: string;
  kind: MigrationCatalogKind;
  severity: MigrationCatalogSeverity;
  routesTo: string | null;
  affectedRepos: number;
}

interface UncrawledCatalogEntry {
  catalogEntryId: string;
  label: string;
  severity: MigrationCatalogSeverity;
}

interface AlwaysLostCatalogEntry {
  catalogEntryId: string;
  label: string;
  summary: string;
}

export interface PreparationSummary {
  items: PreparationItem[];
  notYetCrawled: UncrawledCatalogEntry[];
  alwaysLost: AlwaysLostCatalogEntry[];
  blockerRepos: number;
  warnRepos: number;
  cleanRepos: number;
  incompleteRepos: number;
}

const SEVERITY_RANK: Record<MigrationCatalogSeverity, number> = { blocker: 0, warn: 1, info: 2 };

export function buildPreparationSummary(repos: Iterable<StoredRepoProfile>): PreparationSummary {
  const metadata = new Map(MIGRATION_CATALOG.map((entry) => [entry.id, entry]));
  const affected = new Map<string, number>();
  let blockerRepos = 0;
  let warnRepos = 0;
  let cleanRepos = 0;
  let incompleteRepos = 0;

  for (const repo of repos) {
    if (repo.blockers > 0) blockerRepos += 1;
    if (repo.warnings > 0) warnRepos += 1;
    if (!releaseScanComplete(repo.signals) || !ruleScanComplete(repo.signals)) incompleteRepos += 1;
    else if (repo.blockers === 0 && repo.warnings === 0) cleanRepos += 1;
    for (const match of repo.catalogMatches) {
      affected.set(match.catalogEntryId, (affected.get(match.catalogEntryId) ?? 0) + 1);
    }
  }

  const items: PreparationItem[] = [];
  for (const [id, affectedRepos] of affected) {
    const entry = metadata.get(id);
    if (!entry) continue;
    items.push({
      catalogEntryId: id,
      label: entry.label,
      kind: entry.kind,
      severity: entry.severity,
      routesTo: entry.routesTo,
      affectedRepos,
    });
  }
  items.sort(
    (left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
      right.affectedRepos - left.affectedRepos ||
      left.label.localeCompare(right.label),
  );

  const alwaysLost: AlwaysLostCatalogEntry[] = MIGRATION_CATALOG.filter(
    (entry) => entry.scope === "migration",
  ).map((entry) => ({
    catalogEntryId: entry.id,
    label: entry.label,
    summary: entry.summary,
  }));

  const evaluated = new Set([...DETECTED_CATALOG_ENTRY_IDS, ...ORG_EVALUATED_CATALOG_ENTRY_IDS]);
  const notYetCrawled: UncrawledCatalogEntry[] = MIGRATION_CATALOG.filter(
    (entry) => entry.scope !== "migration" && !evaluated.has(entry.id),
  ).map((entry) => ({
    catalogEntryId: entry.id,
    label: entry.label,
    severity: entry.severity,
  }));

  return { items, notYetCrawled, alwaysLost, blockerRepos, warnRepos, cleanRepos, incompleteRepos };
}
