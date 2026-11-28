import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import playwrightConfig from "../../playwright.config";
import { mutationLanes } from "../../scripts/checks/mutation-manifest";

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

function run(argv: string[], env: Record<string, string> = {}): string {
  const result = Bun.spawnSync(argv, { cwd, env: { PATH: process.env.PATH, ...env } });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function writeLocalEnv(): void {
  writeFileSync(join(cwd, ".env"), "DOTENV_LAUNCH_PROBE=dotenv-fixture\n");
}

function writeTestProbe(): void {
  writeFileSync(join(cwd, "subject.ts"), "export const value = () => 1;\n");
  writeFileSync(
    join(cwd, "probe.test.ts"),
    `import { expect, test } from "bun:test";
import { value } from "./subject";
test("environment", () => { expect(value()).toBeGreaterThan(0); expect(process.env.DOTENV_LAUNCH_PROBE).toBeUndefined(); console.log("dotenv-probe-passed"); });
`,
  );
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

test.each(["test", "test:changed"])("%s does not load the local .env", (script) => {
  writeLocalEnv();
  writeTestProbe();
  if (script === "test:changed") {
    run(["git", "init", "--quiet", "--template="]);
    run(["git", "add", "package.json", "subject.ts", "probe.test.ts"]);
    run([
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "fixture",
    ]);
    writeFileSync(join(cwd, "subject.ts"), "export const value = () => 2;\n");
  }
  expect(() => run([process.execPath, "test", "probe.test.ts"])).toThrow();
  expect(run([process.execPath, "run", script, "probe.test.ts"])).toContain("dotenv-probe-passed");
});

test("coverage gate does not load the local .env", () => {
  writeLocalEnv();
  mkdirSync(join(cwd, "scripts/checks"), { recursive: true });
  writeTestProbe();
  copyFileSync(
    new URL("../../scripts/checks/coverage-check.ts", import.meta.url),
    join(cwd, "scripts/checks/coverage-check.ts"),
  );
  expect(run([process.execPath, "--no-env-file", "scripts/checks/coverage-check.ts"])).toContain(
    "Coverage gate passed",
  );
});

test("mutation test commands do not load the local .env", async () => {
  writeLocalEnv();
  mkdirSync(join(cwd, "tests/mutation"), { recursive: true });
  writeFileSync(join(cwd, "tests/mutation/tsconfig.json"), "{}");
  writeTestProbe();
  for (const lane of mutationLanes) {
    const config = await Bun.file(join(import.meta.dir, "../..", lane.configPath)).json();
    const command = config.commandRunner.command.replace(/(?:\S+\.test\.ts\s*)+$/, "probe.test.ts");
    expect(() => run(["sh", "-c", command.replace("--no-env-file ", "")])).toThrow();
    expect(run(["sh", "-c", command])).toContain("dotenv-probe-passed");
  }
});

test("mutation entry point does not load the local .env", () => {
  writeLocalEnv();
  mkdirSync(join(cwd, "scripts/checks"), { recursive: true });
  writeFileSync(join(cwd, "scripts/checks/mutation-runner.ts"), probe);
  expect(run([process.execPath, "run", "mutation"])).toBe("unset");
});

test.each(["unset", "explicit-fixture"])(
  "Stryker receives runtime flags before its entry point and preserves explicit env (%s)",
  async (inherited) => {
    writeLocalEnv();
    for (const path of [
      "scripts/checks/mutation-runner.ts",
      "scripts/checks/mutation-manifest.ts",
      ...mutationLanes.map((lane) => lane.configPath),
    ]) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      copyFileSync(new URL(`../../${path}`, import.meta.url), join(cwd, path));
    }
    for (const lane of mutationLanes) {
      for (const path of [...lane.sourcePaths, ...lane.testPaths]) {
        mkdirSync(dirname(join(cwd, path)), { recursive: true });
        writeFileSync(join(cwd, path), "// Synthetic mutation input.\n");
      }
    }
    writeFileSync(join(cwd, "bun.lock"), "synthetic-lock\n");
    writeFileSync(
      join(cwd, "node_modules/.bin/stryker"),
      `#!/usr/bin/env node
await Bun.write("spawn-probe.json", JSON.stringify({ args: process.argv.slice(2), env: process.env.DOTENV_LAUNCH_PROBE ?? "unset" }));
const config = await Bun.file(process.argv.at(-1)).json();
await Bun.write(config.jsonReporter.fileName, JSON.stringify({ files: { "fixture.ts": { mutants: [{ status: "Killed" }] } } }));
`,
      { mode: 0o700 },
    );
    expect(
      run(
        [process.execPath, "run", "mutation", "--force", "--lane", "domain"],
        inherited === "unset" ? {} : { DOTENV_LAUNCH_PROBE: inherited },
      ),
    ).toContain("domain: passed");
    expect(await Bun.file(join(cwd, "spawn-probe.json")).json()).toEqual({
      args: ["run", "--force", "tests/mutation/stryker.domain.conf.json"],
      env: inherited,
    });
  },
);
