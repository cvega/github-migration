/**
 * Unit tests for the Zod request schemas. These verify the schemas accept and
 * reject exactly what the endpoints did before the swap, and (via the typed
 * assignments in the "is assignable" tests) prove each schema's output type
 * matches the hand-written request type in types.ts.
 */
import { describe, expect, test } from "bun:test";
import type { BatchMigrationRequest, CreateMigrationRequest, MigrationOptions } from "$lib/types";
import {
  batchMigrationSchema,
  createMigrationSchema,
  restartSchema,
  validateBody,
} from "./schemas";

describe("createMigrationSchema", () => {
  test("accepts a minimal valid request and output is assignable to CreateMigrationRequest", () => {
    const r = validateBody(createMigrationSchema, { sourceRepo: "octo/widget", targetOrg: "acme" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const typed: CreateMigrationRequest = r.value;
      expect(typed.sourceRepo).toBe("octo/widget");
      expect(typed.targetOrg).toBe("acme");
    }
  });

  test("accepts all option fields", () => {
    const r = validateBody(createMigrationSchema, {
      sourceRepo: "octo/widget",
      targetOrg: "acme",
      sourceToken: "ghp_s",
      skipReleases: true,
      targetRepoVisibility: "private",
      sourceApp: { appId: "1", privateKey: "k", installationId: "2" },
    });
    expect(r.ok).toBe(true);
  });

  test("strips unknown keys", () => {
    const r = validateBody(createMigrationSchema, {
      sourceRepo: "octo/widget",
      targetOrg: "acme",
      bogus: "ignored",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect("bogus" in r.value).toBe(false);
  });

  test("rejects a missing sourceRepo", () => {
    const r = validateBody(createMigrationSchema, { targetOrg: "acme" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sourceRepo/i);
  });

  test("rejects an empty sourceRepo", () => {
    const r = validateBody(createMigrationSchema, { sourceRepo: "", targetOrg: "acme" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sourceRepo/i);
  });

  test("rejects a sourceRepo without a slash, naming the format", () => {
    const r = validateBody(createMigrationSchema, { sourceRepo: "widget", targetOrg: "acme" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sourceRepo/i);
  });

  test("rejects a missing targetOrg", () => {
    const r = validateBody(createMigrationSchema, { sourceRepo: "octo/widget" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/targetOrg/i);
  });

  test("rejects a non-boolean boolean field, naming it", () => {
    const r = validateBody(createMigrationSchema, {
      sourceRepo: "octo/widget",
      targetOrg: "acme",
      skipReleases: "yes",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/skipReleases/i);
  });

  test("rejects an invalid targetRepoVisibility", () => {
    const r = validateBody(createMigrationSchema, {
      sourceRepo: "octo/widget",
      targetOrg: "acme",
      targetRepoVisibility: "secret",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/visibility/i);
  });

  test("rejects an over-length field", () => {
    const r = validateBody(createMigrationSchema, {
      sourceRepo: `o/${"r".repeat(300)}`,
      targetOrg: "acme",
    });
    expect(r.ok).toBe(false);
  });

  test("rejects an app-auth object missing a required key, naming the field", () => {
    const r = validateBody(createMigrationSchema, {
      sourceRepo: "octo/widget",
      targetOrg: "acme",
      sourceApp: { appId: "1", privateKey: "k" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sourceApp/i);
  });
});

describe("batchMigrationSchema", () => {
  test("accepts a valid batch and output is assignable to BatchMigrationRequest", () => {
    const r = validateBody(batchMigrationSchema, {
      repos: ["octo/a", "octo/b"],
      targetOrg: "acme",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const typed: BatchMigrationRequest = r.value;
      expect(typed.repos).toHaveLength(2);
    }
  });

  test("rejects missing repos", () => {
    const r = validateBody(batchMigrationSchema, { targetOrg: "acme" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/repos/i);
  });

  test("rejects an empty repos array", () => {
    const r = validateBody(batchMigrationSchema, { repos: [], targetOrg: "acme" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/repos/i);
  });

  test("rejects more than the max repos", () => {
    const repos = Array.from({ length: 501 }, (_, i) => `octo/r${i}`);
    const r = validateBody(batchMigrationSchema, { repos, targetOrg: "acme" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/repos|500|max/i);
  });

  test("rejects a repo entry without a slash", () => {
    const r = validateBody(batchMigrationSchema, { repos: ["octo/a", "bad"], targetOrg: "acme" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/repos/i);
  });

  test("rejects a missing targetOrg", () => {
    const r = validateBody(batchMigrationSchema, { repos: ["octo/a"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/targetOrg/i);
  });
});

describe("restartSchema", () => {
  test("accepts an empty object and output is assignable to MigrationOptions", () => {
    const r = validateBody(restartSchema, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const typed: MigrationOptions = r.value;
      expect(typed.sourceToken).toBeUndefined();
    }
  });

  test("accepts credentials and options", () => {
    const r = validateBody(restartSchema, { sourceToken: "ghp_s", skipReleases: true });
    expect(r.ok).toBe(true);
  });

  test("rejects a non-boolean option, naming it", () => {
    const r = validateBody(restartSchema, { noSslVerify: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/noSslVerify/i);
  });
});
