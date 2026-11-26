import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helper = new URL("../../scripts/packaging/build-exporter.py", import.meta.url).pathname;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "exporter-input-"));
  writeFileSync(
    join(root, "runtime"),
    `#!/bin/sh
set -eu
ctx="\${BBS_EXPORTER_BUILD_CONTEXT:-\${GL_EXPORTER_BUILD_CONTEXT:?}}"
test -f "$ctx/lib/pilot.rb" && test -x "$ctx/exe/pilot" || exit 2
test ! -e "$ctx/.env" && test ! -e "$ctx/unrelated" || exit 3
printf '%s\\n' "$ctx" "$@"
exit "\${PROBE_EXIT:-0}"
`,
    { mode: 0o700 },
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function release(provider: string) {
  const dir = join(root, "private release");
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "exe"));
  for (const name of [
    "Gemfile",
    "Gemfile.lock",
    "LICENSE",
    `${provider === "bitbucket" ? "bbs" : "gl"}_exporter.gemspec`,
    "lib/pilot.rb",
    ".env",
    "unrelated",
  ])
    writeFileSync(join(dir, name), "fixture");
  writeFileSync(join(dir, "exe/pilot"), "fixture", { mode: 0o755 });
  return dir;
}
function build(provider: string, path: string, status = 0) {
  return Bun.spawnSync(["python3", helper, provider, path], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      EXPORTER_RUNTIME: join(root, "runtime"),
      PROBE_EXIT: `${status}`,
    },
  });
}

for (const provider of ["bitbucket", "gitlab"]) {
  test.each(["directory", "flat tar.gz", "wrapped tar.gz"])(
    `${provider} builds from a %s without sending unrelated files`,
    (form) => {
      const dir = release(provider);
      let input = dir;
      if (form !== "directory") {
        input = join(root, "private release.tar.gz");
        const flat = form === "flat tar.gz";
        expect(
          Bun.spawnSync([
            "tar",
            "-czf",
            input,
            "-C",
            flat ? dir : root,
            flat ? "." : "private release",
          ]).exitCode,
        ).toBe(0);
      }
      const result = build(provider, input);
      expect(result.exitCode).toBe(0);
      const [context, ...args] = result.stdout.toString().trim().split("\n");
      expect(args.slice(-2)).toEqual(["build", `${provider}-exporter`]);
      for (const [index, arg] of args.entries()) {
        if (arg === "-f") expect(existsSync(args[index + 1] ?? "")).toBe(true);
      }
      expect(existsSync(context ?? "")).toBe(false);
      expect(existsSync(input)).toBe(true);
    },
  );
}

test("rejects the wrong provider and returns build failures after cleaning up", () => {
  const dir = release("gitlab");
  const wrong = build("bitbucket", dir);
  expect(wrong.exitCode).not.toBe(0);
  expect(wrong.stderr.toString()).toContain("bbs_exporter.gemspec");
  const failed = build("gitlab", dir, 17);
  expect(failed.exitCode).toBe(17);
  expect(existsSync(failed.stdout.toString().split("\n")[0] ?? "")).toBe(false);
  expect(existsSync(dir)).toBe(true);
});
