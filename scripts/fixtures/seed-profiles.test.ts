import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { analyzeRepo } from "$lib/server/profile/analysis/repos";
import { profileStore } from "$lib/server/profile/database/schema";
import type { RepoSignals } from "$lib/server/profile/types";
import { seedProfiles } from "./seed-profiles";

interface StoredRepoRow {
  signals: string;
  blockers: number;
  warnings: number;
  infos: number;
  applying_considerations: string;
}

interface PersistedCatalogMatch {
  considerationId: string;
  evidence: string;
}

describe("seedProfiles", () => {
  test("creates realistic idempotent runs whose findings match production analysis", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    profileStore.applySchema(db);

    expect(seedProfiles(db)).toEqual({ runs: 6, repos: 849, completed: 5, failed: 1 });
    expect(seedProfiles(db)).toEqual({ runs: 6, repos: 849, completed: 5, failed: 1 });

    expect(
      db.query("SELECT COUNT(*) AS count FROM profile_runs WHERE id LIKE 'seed-profile-%'").get(),
    ).toEqual({ count: 6 });
    expect(
      db
        .query("SELECT COUNT(*) AS count FROM profile_repos WHERE run_id LIKE 'seed-profile-%'")
        .get(),
    ).toEqual({ count: 349 });
    expect(
      db
        .query(
          `SELECT run_id, COUNT(*) AS count
					 FROM profile_source_inventory_projects
					 WHERE run_id LIKE 'seed-profile-%-enterprise'
					 GROUP BY run_id ORDER BY run_id`,
        )
        .all(),
    ).toEqual([
      { run_id: "seed-profile-bitbucket-enterprise", count: 250 },
      { run_id: "seed-profile-gitlab-enterprise", count: 250 },
    ]);

    const failed = db
      .query(
        `SELECT state, total_repos, profiled_repos, failure_reason
				 FROM profile_runs WHERE id = 'seed-profile-failed'`,
      )
      .get() as {
      state: string;
      total_repos: number;
      profiled_repos: number;
      failure_reason: string | null;
    };
    expect(failed.state).toBe("failed");
    expect(failed.total_repos).toBe(50);
    expect(failed.profiled_repos).toBe(17);
    expect(failed.failure_reason).toContain("rate limit");

    const row = db
      .query(
        `SELECT signals, blockers, warnings, infos, applying_considerations
				 FROM profile_repos
				 WHERE run_id = 'seed-profile-mixed'
				 ORDER BY name_with_owner LIMIT 1`,
      )
      .get() as StoredRepoRow;
    const signals = JSON.parse(row.signals) as RepoSignals;
    const storedMatches = JSON.parse(row.applying_considerations) as PersistedCatalogMatch[];
    const analyzed = analyzeRepo(signals);
    const expectedFindings = analyzed.findings
      .filter((finding) => finding.status === "applies")
      .map((finding) => ({
        considerationId: finding.entry.id,
        evidence: finding.evidence ?? "",
      }));

    expect(signals.nameWithOwner).toBe("acme-corp/service-001");
    expect(row.blockers).toBe(analyzed.summary.blockers);
    expect(row.warnings).toBe(analyzed.summary.warnings);
    expect(row.infos).toBe(analyzed.summary.infos);
    expect(storedMatches).toEqual(expectedFindings);

    db.close();
  });
});
