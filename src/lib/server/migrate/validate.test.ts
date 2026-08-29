import { describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import {
  parseJsonBody,
  requestFromPersistedOptions,
  restartValidationInput,
  serializeRequestOptions,
  validateMigrationTargetSelection,
} from "./validate";

describe("migration request validation", () => {
  test("accepts only JSON object request bodies", async () => {
    expect(
      await parseJsonBody(
        new Request("https://example.test", {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: '{"sourceRepo":"acme/widget"}',
        }),
      ),
    ).toEqual({ data: { sourceRepo: "acme/widget" } });
    expect(
      await parseJsonBody(new Request("https://example.test", { method: "POST", body: "{}" })),
    ).toEqual({ error: "Content-Type must be application/json", status: 415 });
  });

  test("validates provider and target compatibility", () => {
    expect(validateMigrationTargetSelection({ sourceProvider: "github" })).toBeNull();
    expect(
      validateMigrationTargetSelection({ sourceProvider: "github", targetProfileId: "missing" }),
    ).toBe("Target profile is not configured");
  });

  test("persists restart-safe options without credentials", () => {
    const serialized = serializeRequestOptions({
      sourceRepo: "acme/widget",
      targetOrg: "acme-cloud",
      sourceToken: "source-secret",
      targetToken: "target-secret",
      sourceApp: { appId: "1", installationId: "2", privateKey: "private-secret" },
      skipReleases: true,
    });
    expect(serialized).not.toContain("secret");
    expect(requestFromPersistedOptions(JSON.parse(serialized))).toEqual({
      sourceApiUrl: undefined,
      sourceRepo: "acme/widget",
      targetProfileId: undefined,
      targetOrg: "acme-cloud",
      targetRepo: undefined,
      noSslVerify: undefined,
      skipReleases: true,
      lockSource: undefined,
      archiveSource: undefined,
      targetRepoVisibility: undefined,
      directPassthrough: undefined,
    });
  });

  test("reconstructs authoritative identity for restart validation", () => {
    const migration = {
      sourceProvider: "gitlab",
      sourceApiUrl: "https://gitlab.example/api/v4",
      sourceOrg: "group/subgroup",
      sourceRepo: "widget",
      targetOrg: "acme-cloud",
      targetProfileId: "ghec",
      targetPlatform: "ghec",
    } as Migration;
    expect(restartValidationInput(migration, { targetToken: "new-token" })).toEqual({
      targetToken: "new-token",
      sourceProvider: "gitlab",
      sourceApiUrl: "https://gitlab.example/api/v4",
      sourceRepo: "group/subgroup/widget",
      targetOrg: "acme-cloud",
      targetProfileId: "ghec",
      targetPlatform: "ghec",
    });
  });
});
