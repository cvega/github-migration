import { describe, expect, test } from "bun:test";
import { GHES_IMPORT_JOB_PHASES, isGhesImportJobPhase } from "./job";

describe("GHES import job phases", () => {
  test("preserves every durable phase including reconciliation", () => {
    expect(GHES_IMPORT_JOB_PHASES).toContain("reconciliation_required");
    expect(GHES_IMPORT_JOB_PHASES.at(-1)).toBe("reconciliation_required");
  });

  test("accepts only persisted phase literals", () => {
    for (const phase of GHES_IMPORT_JOB_PHASES) expect(isGhesImportJobPhase(phase)).toBe(true);
    for (const value of ["running", "complete", "", null, 1]) {
      expect(isGhesImportJobPhase(value)).toBe(false);
    }
  });
});
