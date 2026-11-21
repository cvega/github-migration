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

  test("accepts only the explicitly configured insecure Bitbucket URL", () => {
    const previousUrl = process.env.BITBUCKET_SERVER_URL;
    const previousAllow = process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP;
    try {
      process.env.BITBUCKET_SERVER_URL = "http://bitbucket:7990";
      process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP = "true";
      const request = {
        sourceProvider: "bitbucket-server",
        sourceRepo: "TEST/repo-01",
        targetOrg: "target",
        sourceApiUrl: "http://bitbucket:7990/rest/api/1.0",
      };
      expect(validateBody(createMigrationSchema, request)).toMatchObject({ ok: true });
      expect(
        validateBody(batchMigrationSchema, { ...request, repos: ["TEST/repo-01"] }),
      ).toMatchObject({ ok: true });
      expect(
        validateBody(createMigrationSchema, {
          ...request,
          sourceApiUrl: "http://other:7990/rest/api/1.0",
        }),
      ).toMatchObject({ ok: false });
      expect(
        validateBody(createMigrationSchema, { ...request, sourceProvider: "gitlab" }),
      ).toMatchObject({ ok: false });
      expect(
        validateBody(createMigrationSchema, {
          ...request,
          sourceApiUrl: "http://user:pass@bitbucket:7990/rest/api/1.0",
        }),
      ).toMatchObject({ ok: false });
      process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP = "false";
      expect(validateBody(createMigrationSchema, request)).toMatchObject({ ok: false });
    } finally {
      if (previousUrl === undefined) delete process.env.BITBUCKET_SERVER_URL;
      else process.env.BITBUCKET_SERVER_URL = previousUrl;
      if (previousAllow === undefined) delete process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP;
      else process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP = previousAllow;
    }
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
