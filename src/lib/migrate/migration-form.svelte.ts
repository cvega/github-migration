/**
 * Shared rune-based state for the migration credential + options form.
 *
 * Used by the new-migration form and both restart modals (single + batch),
 * which all collect the same source/target authentication and run options and
 * serialise them into the same request payload shape.
 */
import type { AppAuth, AuthFieldMode, RestartMigrationRequest } from "$lib/types";

/** Which env-provided auth methods are available, per side. */
export interface EnvAuthFlags {
  sourceEnvApp: boolean;
  sourceEnvPat: boolean;
  targetEnvApp: boolean;
  targetEnvPat: boolean;
}

type Visibility = "" | "private" | "public" | "internal";

function defaultAuthMode(envApp: boolean, envPat: boolean): AuthFieldMode {
  if (envApp) return "env-app";
  if (envPat) return "env-pat";
  return "pat";
}

export function createMigrationForm(getEnv: () => EnvAuthFlags) {
  const state = $state({
    sourceAuthMode: "pat" as AuthFieldMode,
    targetAuthMode: "pat" as AuthFieldMode,
    sourceToken: "",
    targetToken: "",
    sourceAppId: "",
    sourceAppKey: "",
    sourceAppInstallationId: "",
    targetAppId: "",
    targetAppKey: "",
    targetAppInstallationId: "",
    skipReleases: false,
    migrationMode: "dry-run" as "dry-run" | "production",
    directPassthrough: false,
    noSslVerify: false,
    targetRepoVisibility: "" as Visibility,
  });

  /** Set source/target auth modes from the currently available env auth. */
  function initAuthModes() {
    const env = getEnv();
    state.sourceAuthMode = defaultAuthMode(env.sourceEnvApp, env.sourceEnvPat);
    state.targetAuthMode = defaultAuthMode(env.targetEnvApp, env.targetEnvPat);
  }

  /** Clear all inputs back to defaults (used when (re)opening a modal). */
  function reset() {
    state.sourceToken = "";
    state.targetToken = "";
    state.sourceAppId = "";
    state.sourceAppKey = "";
    state.sourceAppInstallationId = "";
    state.targetAppId = "";
    state.targetAppKey = "";
    state.targetAppInstallationId = "";
    state.skipReleases = false;
    state.migrationMode = "dry-run";
    state.directPassthrough = false;
    state.noSslVerify = false;
    state.targetRepoVisibility = "";
    initAuthModes();
  }

  /** Serialise the auth + options into a request payload. */
  function buildPayload(): RestartMigrationRequest {
    const sourceApp: AppAuth | undefined =
      state.sourceAuthMode === "app"
        ? {
            appId: state.sourceAppId,
            privateKey: state.sourceAppKey,
            installationId: state.sourceAppInstallationId,
          }
        : undefined;
    const targetApp: AppAuth | undefined =
      state.targetAuthMode === "app"
        ? {
            appId: state.targetAppId,
            privateKey: state.targetAppKey,
            installationId: state.targetAppInstallationId,
          }
        : undefined;

    return {
      sourceToken: state.sourceAuthMode === "pat" ? state.sourceToken || undefined : undefined,
      targetToken: state.targetAuthMode === "pat" ? state.targetToken || undefined : undefined,
      sourceApp,
      targetApp,
      skipReleases: state.skipReleases,
      lockSource: state.migrationMode === "production",
      archiveSource: state.migrationMode === "production",
      directPassthrough: state.directPassthrough,
      noSslVerify: state.noSslVerify,
      targetRepoVisibility: state.targetRepoVisibility || undefined,
    };
  }

  return { state, initAuthModes, reset, buildPayload };
}
