import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import playwrightConfig from "../../playwright.config";

const probe = '#!/usr/bin/env node\nconsole.log(process.env.DOTENV_LAUNCH_PROBE ?? "unset");\n';
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "dashboard-env-"));
  copyFileSync(new URL("../../package.json", import.meta.url), join(cwd, "package.json"));
  for (const directory of ["node_modules/.bin", "scripts/fixtures"]) {
    mkdirSync(join(cwd, directory), { recursive: true });
  }
  for (const script of [
    "node_modules/.bin/vite",
    "node_modules/.bin/playwright",
    "scripts/fixtures/seed-e2e.ts",
    "scripts/gates.ts",
  ]) {
    writeFileSync(join(cwd, script), probe, { mode: 0o700 });
  }
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function run(argv: string[]): string {
  const result = Bun.spawnSync(argv, { cwd, env: { PATH: process.env.PATH } });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function writeLocalEnv(): void {
  writeFileSync(join(cwd, ".env"), "DOTENV_LAUNCH_PROBE=dotenv-fixture\n");
}

test("dev forwards the root .env to the Vite process", () => {
  writeLocalEnv();
  expect(run([process.execPath, "run", "dev"])).toBe("dotenv-fixture");
});

test("dev launches Vite without a local .env", () => {
  expect(run([process.execPath, "run", "dev"])).toBe("unset");
});

test("the browser test runner does not load the local .env", () => {
  writeLocalEnv();
  expect(run([process.execPath, "run", "test:e2e"])).toBe("unset");
});

test("the browser test seeder and web server do not load the local .env", () => {
  writeLocalEnv();
  const server = playwrightConfig.webServer;
  if (!server || Array.isArray(server)) throw new Error("Expected one Playwright web server");
  expect(run(["sh", "-c", server.command]).split("\n")).toEqual(["unset", "unset"]);
});

test("verify does not load the local .env before dispatching browser tests", () => {
  writeLocalEnv();
  expect(run([process.execPath, "run", "verify", "e2e"])).toBe("unset");
});
