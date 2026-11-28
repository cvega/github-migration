import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const SKIPPED = new Set(["node_modules", ".git", "build", "coverage", ".e2e-data", "data"]);

const METRIC = `import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "zzProbe",
  order: 12,
  card: { label: "Probe", icon: "tag", position: 13 },
});
`;
const FIXTURE = `import type { ProfileNumericMetric } from "$lib/source/types";

export default {
  provider: "gitlab",
  endpointFamily: "zz-probe",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: { kind: "exact", value: 1, basis: "enumerated", scope: "probe" },
} satisfies ProfileNumericMetric;
`;
const COLLECTOR = `import descriptor from "$lib/source/gitlab-metrics/zz-probe.metric";
import { budgetObservation, metric } from "./counts";
import { defineGitLabCollector } from "./types";

// Makes no request, but honors the shared request budget like every collector.
export default defineGitLabCollector(descriptor, async (client, _project, options = {}) =>
  metric(
    "zz-probe",
    options.apiCallCeiling !== undefined && client.getApiCalls() >= options.apiCallCeiling
      ? budgetObservation("probe")
      : { kind: "exact", value: 1, basis: "enumerated", scope: "probe" },
    options.nowMs ?? Date.now(),
  ),
);
`;

const FAILURE_LINE = /^\(fail\)|^error:|<error|Found \d+ error/;

function run(cwd: string, command: string[], keep: RegExp = /./): { code: number; output: string } {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const output = `${result.stdout}${result.stderr}`;
  const failures = output.split("\n").filter((line) => keep.test(line));
  return { code: result.exitCode ?? 1, output: failures.join("\n") };
}

/**
 * A later metric PR adds `.metric`, `.fixture` and `.collector` files and
 * regenerates the lists. Prove that, in an isolated copy of the tree, a valid
 * extra metric leaves every shared fixture consumer and the type check passing
 * without editing any shared fixture list.
 */
test("a new metric needs only its own files and the regenerated lists", () => {
  const copy = mkdtempSync(join(tmpdir(), "gitlab-metric-extension-"));
  try {
    cpSync(ROOT, copy, {
      recursive: true,
      filter: (path) =>
        !relative(ROOT, path)
          .split(sep)
          .some((part) => SKIPPED.has(part)),
    });
    // `svelte-kit sync` writes `node_modules/$app`, so give the copy its own and link the rest.
    mkdirSync(join(copy, "node_modules"));
    for (const entry of readdirSync(join(ROOT, "node_modules"))) {
      if (entry === "$app")
        cpSync(join(ROOT, "node_modules", entry), join(copy, "node_modules", entry), {
          recursive: true,
        });
      else symlinkSync(join(ROOT, "node_modules", entry), join(copy, "node_modules", entry));
    }
    // A partial run would trip the repository-wide coverage threshold.
    writeFileSync(join(copy, "bunfig.toml"), '[test]\npreload = ["./src/test-setup.ts"]\n');
    writeFileSync(join(copy, "src/lib/source/gitlab-metrics/zz-probe.metric.ts"), METRIC);
    writeFileSync(join(copy, "src/lib/source/gitlab-metrics/zz-probe.fixture.ts"), FIXTURE);
    writeFileSync(
      join(copy, "src/lib/server/source/gitlab/metrics/zz-probe.collector.ts"),
      COLLECTOR,
    );

    const generated = run(copy, ["bun", "scripts/packaging/generate-gitlab-metrics.ts"]);
    expect(generated.output).toContain("generated lists");
    const tests = run(
      copy,
      [
        "bun",
        "test",
        // The two exact key-list snapshots in gitlab-metrics.test.ts name every metric by design.
        "-t",
        "^(?!.*(declares each metric once|established order))",
        "src/lib/source",
        "src/lib/server/source/gitlab",
        "src/lib/server/profile",
        "src/lib/server/application/adapters/profile-starters.test.ts",
        "src/routes/api/profile",
      ],
      FAILURE_LINE,
    );
    expect({ code: tests.code, output: tests.output }).toEqual({
      code: 0,
      output: "",
    });
    const types = run(copy, ["bun", "run", "typecheck"], FAILURE_LINE);
    expect({ code: types.code, output: types.output }).toEqual({
      code: 0,
      output: "",
    });
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}, 120_000);
