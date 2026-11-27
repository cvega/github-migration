import { expect, test } from "bun:test";

test("excludes named gates and validates exclusions", () => {
  const run = (...args: string[]) =>
    Bun.spawnSync(["bun", "scripts/gates.ts", ...args], { stdout: "pipe", stderr: "pipe" });
  const selected = run("icons", "runtime", "--except", "icons");
  expect(selected.exitCode).toBe(0);
  expect(Object.keys(JSON.parse(selected.stdout.toString()).gates)).toEqual(["runtime"]);
  expect(run("--except").exitCode).toBe(2);
  expect(run("--except", "unknown").exitCode).toBe(2);
});
