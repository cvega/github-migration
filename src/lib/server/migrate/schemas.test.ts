import { describe, expect, test } from "bun:test";
import {
  batchMigrationSchema,
  confirmRestartSchema,
  createMigrationSchema,
  restartMigrationSchema,
  validateBody,
} from "./schemas";

describe("migration request schemas", () => {
  test("parses a single request and strips unknown fields", () => {
    const result = validateBody(createMigrationSchema, {
      sourceRepo: "acme/widget",
      targetOrg: "acme-cloud",
      sourceToken: "secret",
      ignored: "value",
    });
    expect(result).toEqual({
      ok: true,
      value: { sourceRepo: "acme/widget", targetOrg: "acme-cloud", sourceToken: "secret" },
    });
  });

  test("rejects unsafe source URLs and field values over the bound", () => {
    expect(
      validateBody(createMigrationSchema, {
        sourceRepo: "acme/widget",
        targetOrg: "acme-cloud",
        sourceApiUrl: "https://user:secret@example.com/api?token=secret",
      }),
    ).toEqual({
      ok: false,
      error: "sourceApiUrl: must be an HTTPS URL without credentials, query, or fragment",
    });
    expect(validateBody(restartMigrationSchema, { sourceToken: "x".repeat(256) })).toMatchObject({
      ok: false,
      error: "sourceToken: must be at most 255 characters",
    });
  });

  test("applies provider-specific project path validation", () => {
    expect(
      validateBody(createMigrationSchema, {
        sourceProvider: "bitbucket-server",
        sourceRepo: "project/subgroup/repository",
        targetOrg: "acme-cloud",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateBody(createMigrationSchema, {
        sourceProvider: "gitlab",
        sourceRepo: "group/subgroup/project",
        targetOrg: "acme-cloud",
      }),
    ).toMatchObject({ ok: true });
  });

  test("requires exactly one batch mapping form and unique target names", () => {
    expect(validateBody(batchMigrationSchema, { targetOrg: "acme-cloud" })).toMatchObject({
      ok: false,
      error: "repos: repos or items is required",
    });
    expect(
      validateBody(batchMigrationSchema, {
        targetOrg: "acme-cloud",
        repos: ["acme/one"],
        items: [{ sourceRepo: "acme/two", targetRepo: "two" }],
      }),
    ).toMatchObject({ ok: false, error: "items: use either repos or items, not both" });
    expect(
      validateBody(batchMigrationSchema, {
        targetOrg: "acme-cloud",
        items: [
          { sourceRepo: "acme/one", targetRepo: "Widget" },
          { sourceRepo: "acme/two", targetRepo: "widget" },
        ],
      }),
    ).toMatchObject({
      ok: false,
      error: "items.1.targetRepo: target repository names must be unique",
    });
  });

  test("requires an explicit confirm-restart repository attestation", () => {
    expect(validateBody(confirmRestartSchema, { confirmation: "" })).toMatchObject({ ok: false });
    expect(validateBody(confirmRestartSchema, { confirmation: "acme-cloud/widget" })).toEqual({
      ok: true,
      value: { confirmation: "acme-cloud/widget" },
    });
  });
});
