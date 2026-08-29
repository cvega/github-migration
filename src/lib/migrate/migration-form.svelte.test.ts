import { beforeAll, describe, expect, test } from "bun:test";
import type { createMigrationForm as CreateMigrationForm } from "./migration-form.svelte";

let createMigrationForm: typeof CreateMigrationForm;

beforeAll(async () => {
  (globalThis as unknown as { $state: <Value>(value: Value) => Value }).$state = (value) => value;
  ({ createMigrationForm } = await import("./migration-form.svelte"));
});

describe("migration form state", () => {
  test("selects environment auth by precedence and resets every input", () => {
    const form = createMigrationForm(() => ({
      sourceEnvApp: true,
      sourceEnvPat: true,
      targetEnvApp: false,
      targetEnvPat: true,
    }));

    form.initAuthModes();
    expect(form.state.sourceAuthMode).toBe("env-app");
    expect(form.state.targetAuthMode).toBe("env-pat");

    Object.assign(form.state, {
      sourceToken: "source-secret",
      targetToken: "target-secret",
      sourceAppId: "1",
      sourceAppKey: "source-key",
      sourceAppInstallationId: "2",
      targetAppId: "3",
      targetAppKey: "target-key",
      targetAppInstallationId: "4",
      skipReleases: true,
      migrationMode: "production",
      directPassthrough: true,
      noSslVerify: true,
      targetRepoVisibility: "private",
    });

    form.reset();
    expect(form.state).toEqual({
      sourceAuthMode: "env-app",
      targetAuthMode: "env-pat",
      sourceToken: "",
      targetToken: "",
      sourceAppId: "",
      sourceAppKey: "",
      sourceAppInstallationId: "",
      targetAppId: "",
      targetAppKey: "",
      targetAppInstallationId: "",
      skipReleases: false,
      migrationMode: "dry-run",
      directPassthrough: false,
      noSslVerify: false,
      targetRepoVisibility: "",
    });
  });

  test("serializes PAT credentials and omits blank values", () => {
    const form = createMigrationForm(() => ({
      sourceEnvApp: false,
      sourceEnvPat: false,
      targetEnvApp: false,
      targetEnvPat: false,
    }));
    form.initAuthModes();
    form.state.sourceToken = "source-token";

    expect(form.buildPayload()).toEqual({
      sourceToken: "source-token",
      targetToken: undefined,
      sourceApp: undefined,
      targetApp: undefined,
      skipReleases: false,
      lockSource: false,
      archiveSource: false,
      directPassthrough: false,
      noSslVerify: false,
      targetRepoVisibility: undefined,
    });
  });

  test("serializes App credentials and production execution options", () => {
    const form = createMigrationForm(() => ({
      sourceEnvApp: false,
      sourceEnvPat: false,
      targetEnvApp: false,
      targetEnvPat: false,
    }));
    Object.assign(form.state, {
      sourceAuthMode: "app",
      targetAuthMode: "app",
      sourceAppId: "source-app",
      sourceAppKey: "source-key",
      sourceAppInstallationId: "source-installation",
      targetAppId: "target-app",
      targetAppKey: "target-key",
      targetAppInstallationId: "target-installation",
      skipReleases: true,
      migrationMode: "production",
      directPassthrough: true,
      noSslVerify: true,
      targetRepoVisibility: "internal",
    });

    expect(form.buildPayload()).toEqual({
      sourceToken: undefined,
      targetToken: undefined,
      sourceApp: {
        appId: "source-app",
        privateKey: "source-key",
        installationId: "source-installation",
      },
      targetApp: {
        appId: "target-app",
        privateKey: "target-key",
        installationId: "target-installation",
      },
      skipReleases: true,
      lockSource: true,
      archiveSource: true,
      directPassthrough: true,
      noSslVerify: true,
      targetRepoVisibility: "internal",
    });
  });
});
