import { describe, expect, test } from "bun:test";
import {
  buildMigrationReviewModel,
  buildSubmissionPlan,
  type MigrationValidationState,
  type MigrationWorkflowPosition,
  nextWorkflowPosition,
  parseRepositories,
  previousWorkflowPosition,
  validateMigrationStep,
} from "./workflow.svelte";

function validState(overrides: Partial<MigrationValidationState> = {}): MigrationValidationState {
  return {
    mode: "single",
    sourceProvider: "github",
    targetProfileId: "ghec",
    targetProfileAvailable: true,
    targetProfileCompatible: true,
    targetProfileExecutionReady: true,
    hasSourceNamespaces: true,
    sourceNamespace: "platform",
    sourceRepository: "",
    sourceRepositoryName: "api",
    repositoryInput: "",
    validRepositories: [],
    invalidRepositories: [],
    sourceApiUrl: "",
    sourceAuthReady: true,
    targetOrganization: "engineering",
    targetAuthReady: true,
    ...overrides,
  };
}

describe("new migration workflow", () => {
  test("normalizes bare batch names and preserves explicit repository paths", () => {
    expect(parseRepositories("api\nother/widget, docs", "platform")).toEqual({
      parsed: ["api", "other/widget", "docs"],
      normalized: ["platform/api", "other/widget", "platform/docs"],
      valid: ["platform/api", "other/widget", "platform/docs"],
      invalid: [],
    });
    expect(parseRepositories("api\nplatform/widget", "")).toMatchObject({
      valid: ["platform/widget"],
      invalid: ["api"],
    });
  });

  test("builds distinct single and batch endpoints, payloads, and destinations", () => {
    const commonFields = { sourceProvider: "gitlab", targetProfileId: "ghec" };
    const single = buildSubmissionPlan({
      mode: "single",
      commonFields,
      sourceRepo: "platform/api",
      targetOrg: "engineering",
      targetRepo: "api",
      repositories: [],
    });
    expect(single).toMatchObject({
      endpoint: "/api/migrate",
      body: {
        ...commonFields,
        sourceRepo: "platform/api",
        targetOrg: "engineering",
        targetRepo: "api",
      },
    });
    expect(single.destination("migration-1")).toBe("/migrate/migration-1");

    const batch = buildSubmissionPlan({
      mode: "batch",
      commonFields,
      sourceRepo: "",
      targetOrg: "engineering",
      targetRepo: "",
      repositories: ["platform/api", "platform/web"],
    });
    expect(batch).toMatchObject({
      endpoint: "/api/migrate/batches",
      body: {
        ...commonFields,
        repos: ["platform/api", "platform/web"],
        targetOrg: "engineering",
      },
    });
    expect(batch.destination("batch-1")).toBe("/migrate/batches/batch-1");
  });

  test("preserves dry-run and production execution flags in submission bodies", () => {
    const dryRun = buildSubmissionPlan({
      mode: "single",
      commonFields: {
        lockSource: false,
        archiveSource: false,
        skipReleases: true,
      },
      sourceRepo: "platform/api",
      targetOrg: "engineering",
      targetRepo: "api",
      repositories: [],
    });
    expect(dryRun.body).toMatchObject({
      lockSource: false,
      archiveSource: false,
      skipReleases: true,
    });

    const production = buildSubmissionPlan({
      mode: "batch",
      commonFields: {
        lockSource: true,
        archiveSource: true,
        directPassthrough: true,
      },
      sourceRepo: "",
      targetOrg: "engineering",
      targetRepo: "",
      repositories: ["platform/api", "platform/web"],
    });
    expect(production.body).toMatchObject({
      lockSource: true,
      archiveSource: true,
      directPassthrough: true,
    });
  });

  test("moves through every workflow position in both directions", () => {
    const positions: MigrationWorkflowPosition[] = [
      { stage: "route", configurationStep: "repositories" },
      { stage: "configure", configurationStep: "repositories" },
      { stage: "configure", configurationStep: "source-access" },
      { stage: "configure", configurationStep: "destination" },
      { stage: "configure", configurationStep: "options" },
      { stage: "review", configurationStep: "options" },
    ];

    for (let index = 0; index < positions.length; index += 1) {
      expect(nextWorkflowPosition(positions[index]!)).toEqual(
        positions[Math.min(index + 1, positions.length - 1)]!,
      );
      expect(previousWorkflowPosition(positions[index]!)).toEqual(
        positions[Math.max(index - 1, 0)]!,
      );
    }
  });

  test("returns structured route and repository validation failures", () => {
    expect(validateMigrationStep("route", validState({ sourceProvider: "" }))).toEqual([
      { step: "route", field: "sourceProvider", message: "Choose a source platform." },
    ]);
    expect(validateMigrationStep("route", validState({ targetProfileAvailable: false }))).toEqual([
      {
        step: "route",
        field: "targetProfileId",
        message: "Choose an available destination.",
      },
    ]);
    expect(validateMigrationStep("route", validState({ targetProfileCompatible: false }))).toEqual([
      {
        step: "route",
        field: "targetProfileId",
        message: "The selected destination does not support this source platform.",
      },
    ]);
    expect(
      validateMigrationStep("route", validState({ targetProfileExecutionReady: false })),
    ).toEqual([
      {
        step: "route",
        field: "targetProfileId",
        message: "The selected destination requires additional migration configuration.",
      },
    ]);

    expect(
      validateMigrationStep(
        "repositories",
        validState({ sourceNamespace: "", sourceRepositoryName: "" }),
      ).map((issue) => issue.field),
    ).toEqual(["sourceNamespace", "sourceRepository"]);
    expect(
      validateMigrationStep(
        "repositories",
        validState({ hasSourceNamespaces: false, sourceRepository: "api" }),
      ),
    ).toEqual([
      {
        step: "repositories",
        field: "sourceRepository",
        message: "Enter the repository in owner/repository format.",
      },
    ]);
    expect(
      validateMigrationStep(
        "repositories",
        validState({
          mode: "batch",
          repositoryInput: "api",
          validRepositories: [],
          invalidRepositories: ["api"],
        }),
      ).map((issue) => issue.field),
    ).toEqual(["repositoryInput", "repositoryInput"]);
  });

  test("returns structured access and destination validation failures", () => {
    expect(
      validateMigrationStep(
        "source-access",
        validState({ sourceProvider: "gitlab", sourceApiUrl: "", sourceAuthReady: false }),
      ).map((issue) => issue.field),
    ).toEqual(["sourceApiUrl", "sourceAuth"]);
    expect(
      validateMigrationStep(
        "source-access",
        validState({ sourceApiUrl: "github.example.com", sourceAuthReady: true }),
      ),
    ).toEqual([
      {
        step: "source-access",
        field: "sourceApiUrl",
        message: "Enter a valid HTTP or HTTPS source API URL.",
      },
    ]);
    expect(
      validateMigrationStep(
        "destination",
        validState({ targetOrganization: "", targetAuthReady: false }),
      ).map((issue) => issue.field),
    ).toEqual(["targetOrganization", "targetAuth"]);
    expect(validateMigrationStep("options", validState())).toEqual([]);
  });

  test("builds single and bounded batch readiness models", () => {
    expect(
      buildMigrationReviewModel({
        mode: "single",
        migrationMode: "dry-run",
        sourceRepository: "platform/api",
        targetOrganization: "engineering",
        targetRepository: "api-copy",
        repositories: [],
        activeMigrations: 0,
        maxConcurrent: 10,
      }),
    ).toEqual({
      title: "Migration readiness",
      repositoryCount: 1,
      allRepositoryMappings: [{ source: "platform/api", target: "engineering/api-copy" }],
      repositoryMappings: [{ source: "platform/api", target: "engineering/api-copy" }],
      additionalRepositoryCount: 0,
      launchLabel: "Start dry run",
      queueMessage: "Migration capacity is available.",
    });

    const batch = buildMigrationReviewModel({
      mode: "batch",
      migrationMode: "production",
      sourceRepository: "",
      targetOrganization: "engineering",
      targetRepository: "",
      repositories: ["platform/api", "platform/web", "platform/docs", "platform/worker"],
      activeMigrations: 10,
      maxConcurrent: 10,
    });
    expect(batch).toMatchObject({
      title: "Batch readiness",
      repositoryCount: 4,
      additionalRepositoryCount: 1,
      launchLabel: "Start production batch",
      queueMessage: "All 10 migration slots are in use; this work will queue automatically.",
    });
    expect(batch.repositoryMappings).toEqual([
      { source: "platform/api", target: "engineering/api" },
      { source: "platform/web", target: "engineering/web" },
      { source: "platform/docs", target: "engineering/docs" },
    ]);
    expect(batch.allRepositoryMappings).toEqual([
      { source: "platform/api", target: "engineering/api" },
      { source: "platform/web", target: "engineering/web" },
      { source: "platform/docs", target: "engineering/docs" },
      { source: "platform/worker", target: "engineering/worker" },
    ]);
  });
});
