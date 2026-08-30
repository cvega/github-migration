import { defineConfig, devices } from "@playwright/test";
import process from "node:process";

const port = 4173;
const host = "[::1]";
const authState = ".e2e-data/auth-state.json";
const isCI = process.env.CI !== undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? "github" : "list",
  use: {
    baseURL: `http://${host}:${port}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "setup",
      testMatch: "**/auth.setup.ts",
    },
    {
      name: "chromium",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: authState },
    },
  ],
  webServer: {
    command: `bun scripts/fixtures/seed-e2e.ts && exec ./node_modules/.bin/vite dev --host ::1 --port ${port}`,
    env: {
      DATA_DIR: ".e2e-data",
      GH_MIGRATE_USER: "e2e-admin",
      GH_MIGRATE_PASS: "e2e-bootstrap-password",
      GH_MIGRATE_ALLOW_UNAUTHENTICATED: "false",
      GH_ALLOW_CREDENTIAL_OVERRIDE: "true",
      GH_SOURCE_PAT: "",
      GH_TARGET_PAT: "",
      GH_SOURCE_ORG: "test-source-org",
      GH_TARGET_ORG: "test-target-org",
      GITLAB_SOURCE_API_URL: "",
      GITLAB_SOURCE_PAT: "",
      GITLAB_SOURCE_NAMESPACE: "",
      BITBUCKET_SERVER_URL: "",
      BITBUCKET_SERVER_USERNAME: "",
      BITBUCKET_SERVER_PASSWORD: "",
      BITBUCKET_SERVER_PROJECT_KEYS: "",
      PLAYWRIGHT_TEST: "1",
    },
    url: `http://${host}:${port}`,
    reuseExistingServer: false,
  },
});
