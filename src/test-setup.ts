/**
 * Test preload: stub SvelteKit virtual modules that aren't available outside
 * the Vite/SvelteKit runtime so server modules can be unit-tested under
 * `bun test`. Registered before any test file is evaluated.
 */
import { mock } from "bun:test";

mock.module("$env/dynamic/private", () => ({ env: process.env }));
mock.module("$app/environment", () => ({
  browser: false,
  building: false,
  dev: false,
  version: "",
}));

const LOCAL_CONFIGURATION_KEYS = [
  "GH_MIGRATE_ALLOW_UNAUTHENTICATED",
  "GH_ALLOW_CREDENTIAL_OVERRIDE",
  "GH_SOURCE_API_URL",
  "GH_SOURCE_ORG",
  "GH_SOURCE_PAT",
  "GH_SOURCE_APP_ID",
  "GH_SOURCE_APP_PRIVATE_KEY",
  "GH_SOURCE_APP_INSTALLATION_ID",
  "GH_TARGET_ORG",
  "GH_TARGET_PAT",
  "GH_TARGET_APP_ID",
  "GH_TARGET_APP_PRIVATE_KEY",
  "GH_TARGET_APP_INSTALLATION_ID",
  "GITLAB_SOURCE_API_URL",
  "GITLAB_SOURCE_PAT",
  "GITLAB_SOURCE_NAMESPACE",
  "BITBUCKET_SERVER_URL",
  "BITBUCKET_SERVER_USERNAME",
  "BITBUCKET_SERVER_PASSWORD",
  "BITBUCKET_SERVER_PROJECT_KEYS",
  "BITBUCKET_SERVER_ALLOW_INSECURE_HTTP",
  "BITBUCKET_SERVER_SSH_HOST",
  "BITBUCKET_SERVER_SSH_PORT",
  "BITBUCKET_SERVER_SSH_USERNAME",
  "BITBUCKET_SERVER_SSH_PRIVATE_KEY",
  "BITBUCKET_SERVER_SSH_HOST_KEY_SHA256",
  "BITBUCKET_SERVER_SHARED_HOME",
  "ARCHIVE_DIR",
  "EXPORTER_NETWORK",
  "EXPORTER_MEMORY",
  "EXPORTER_CPUS",
  "EXPORTER_PIDS_LIMIT",
  "EXPORTER_TMPFS_SIZE",
] as const;

for (const key of LOCAL_CONFIGURATION_KEYS) delete process.env[key];

// Stable bootstrap credentials for tests that initialize application authentication.
process.env.GH_MIGRATE_USER = "ci-test-admin";
process.env.GH_MIGRATE_PASS = "ci-test-pass-7f3a9c";
