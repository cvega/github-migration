import { describe, expect, test } from "bun:test";
import { buildGhesMigrationMap, countGhesAuditFailures } from "./mapping";

const header = "model_name,source_url,target_url,state\n";

describe("GHES migration mapping", () => {
  test("maps organizations, renames repositories, and deduplicates records", () => {
    const conflicts = `${header}organization,https://old/org,https://old/org,conflict\nrepository,https://old/org/repo,https://old/org/repo,conflict\n`;
    const records = `${header}organization,https://old/org,https://old/org,pending\n`;
    const output = buildGhesMigrationMap(
      conflicts,
      records,
      "https://ghes.example",
      "target org",
      "target repo",
    );
    expect(output).toContain("https://ghes.example/target%20org,map");
    expect(output).toContain("https://ghes.example/target%20org/target%20repo,rename");
    expect(output.match(/organization/g)?.length).toBe(1);
  });

  test("counts strict audit rows and rejects malformed CSV", () => {
    expect(countGhesAuditFailures(`${header}repository,a,b,failed\n`)).toBe(1);
    expect(countGhesAuditFailures(`${header}user,a,,failed_map\n`)).toBe(1);
    expect(() => countGhesAuditFailures("model_name,source_url\nrepository,a\n")).toThrow(
      "missing required mapping columns",
    );
  });

  test("reports unresolved user conflicts without guessing their identity", () => {
    const conflicts =
      "model_name,source_url,target_url,recommended_action,notes\n" +
      "user,http://bitbucket:7990/users/admin,,rename,Invalid value in url\n";
    expect(() =>
      buildGhesMigrationMap(conflicts, "", "https://ghes.example", "target", "repo"),
    ).toThrow("GHES user conflict requires a target URL for http://bitbucket:7990/users/admin");
  });
});
