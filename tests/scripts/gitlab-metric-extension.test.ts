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

import { GITLAB_PROFILE_METRICS } from "../../src/lib/source/gitlab-metrics";

const ROOT = join(import.meta.dir, "../..");
const SKIPPED = new Set(["node_modules", ".git", "build", "coverage", ".e2e-data", "data"]);

interface Probe {
  stem: string;
  key: string;
  order: number;
  position: number;
}

const metricModule = ({
  key,
  order,
  position,
}: Probe) => `import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "${key}",
  order: ${order},
  card: { label: "Probe", icon: "tag", position: ${position} },
});
`;
const fixtureModule = ({
  stem,
}: Probe) => `import type { ProfileNumericMetric } from "$lib/source/types";

export default {
  provider: "gitlab",
  endpointFamily: "${stem}",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: { kind: "exact", value: 1, basis: "enumerated", scope: "probe" },
} satisfies ProfileNumericMetric;
`;
const collectorModule = ({
  stem,
}: Probe) => `import descriptor from "$lib/source/gitlab-metrics/${stem}.metric";
import { budgetObservation, metric } from "./counts";
import { defineGitLabCollector } from "./types";

// Makes no request, but honors the shared request budget like every collector.
export default defineGitLabCollector(descriptor, async (client, _project, options = {}) =>
  metric(
    "${stem}",
    options.apiCallCeiling !== undefined && client.getApiCalls() >= options.apiCallCeiling
      ? budgetObservation("probe")
      : { kind: "exact", value: 1, basis: "enumerated", scope: "probe" },
    options.nowMs ?? Date.now(),
  ),
);
`;

/** The lowest unused `order` and card `position` above everything already registered. */
function freeSlots(taken: ReadonlyArray<{ order: number; position: number }>) {
  return {
    order: Math.max(-1, ...taken.map(({ order }) => order)) + 1,
    position: Math.max(-1, ...taken.map(({ position }) => position)) + 1,
  };
}

const REGISTERED = GITLAB_PROFILE_METRICS.map(({ order, card }) => ({
  order,
  position: card.position,
}));

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
function verifyExtension(probes: Probe[]): void {
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
    for (const probe of probes) {
      const client = join(copy, "src/lib/source/gitlab-metrics", probe.stem);
      writeFileSync(`${client}.metric.ts`, metricModule(probe));
      writeFileSync(`${client}.fixture.ts`, fixtureModule(probe));
      writeFileSync(
        join(copy, "src/lib/server/source/gitlab/metrics", `${probe.stem}.collector.ts`),
        collectorModule(probe),
      );
    }

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
}

const probe = (stem: string, key: string, slots: { order: number; position: number }): Probe => ({
  stem,
  key,
  ...slots,
});

test("a new metric needs only its own files and the regenerated lists", () => {
  verifyExtension([probe("zz-probe", "zzProbe", freeSlots(REGISTERED))]);
}, 120_000);

test("a new metric still fits when the next order and card position are already taken", () => {
  const first = freeSlots(REGISTERED);
  const occupant = probe("zz-occupant", "zzOccupant", first);
  const second = freeSlots([...REGISTERED, first]);
  expect(second.order).not.toBe(first.order);
  expect(second.position).not.toBe(first.position);
  verifyExtension([occupant, probe("zz-probe", "zzProbe", second)]);
}, 120_000);
