import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkBoundary,
  checkSourceProviderBoundary,
  type Layer,
} from "../../scripts/checks/boundary-policy";

describe("server architecture boundaries", () => {
  test("rejects browser imports of a server module by relative path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "browser-boundaries-"));
    try {
      mkdirSync(join(cwd, "src/lib/server/core"), { recursive: true });
      writeFileSync(join(cwd, "src/lib/server/core/model.ts"), "export type Row = string;\n");
      writeFileSync(
        join(cwd, "src/lib/model.ts"),
        'export type { Row } from "./server/core/model";\n',
      );
      const run = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "../../scripts/checks/boundaries.ts")],
        { cwd },
      );
      expect(run.exitCode).toBe(1);
      expect(run.stderr.toString()).toContain("src/lib/model.ts:1");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  test.each<Layer>(["core", "source", "profile", "migrate"])(
    "%s cannot import the application layer",
    (layer) => {
      expect(checkBoundary(layer, "application")).toBe(
        `${layer}/ must not import the application layer`,
      );
    },
  );

  test.each<Layer>(["core", "source", "profile", "migrate"])(
    "application can compose %s",
    (layer) => {
      expect(checkBoundary("application", layer)).toBeNull();
    },
  );

  test("domains remain isolated from siblings", () => {
    expect(checkBoundary("migrate", "source")).toBe(
      "domain 'migrate' must not import domain 'source'",
    );
    expect(checkBoundary("profile", "migrate")).toBe(
      "domain 'profile' must not import domain 'migrate'",
    );
  });

  test("classified layers cannot import root-level server modules", () => {
    expect(checkBoundary("application", "unclassified")).toBe(
      "server imports must target a classified layer",
    );
  });

  test.each([
    ["source/bitbucket/client.ts", "source/gitlab/client"],
    ["source/gitlab/archive.ts", "source/bitbucket/client.ts"],
    ["migrate/executors/bitbucket-to-ghes.ts", "migrate/exporters/gitlab"],
    ["migrate/executors/gitlab-to-ghec.ts", "migrate/executors/github-to-ghec"],
    ["migrate/executors/github-to-ghec.ts", "migrate/executors/bitbucket-to-ghec.ts"],
    ["migrate/executors/bitbucket-to-ghec.ts", "migrate/github/exports"],
    ["migrate/ghes/import.ts", "migrate/executors/bitbucket-to-ghes"],
    ["migrate/github/upload.ts", "migrate/exporters/gitlab"],
  ])("rejects provider coupling from %s to %s", (from, to) => {
    expect(checkSourceProviderBoundary(from, to)).toContain("must not import");
  });

  test.each([
    ["source/bitbucket/config.ts", "source/bitbucket/client"],
    ["migrate/executors/gitlab-to-ghes.ts", "migrate/exporters/gitlab"],
    ["migrate/executors/github-to-ghec.ts", "migrate/github/exports.ts"],
    ["migrate/executors/bitbucket-to-ghec.ts", "migrate/github/migration-source"],
    ["migrate/executors/gitlab-to-ghec.ts", "migrate/github/monitor"],
    ["migrate/executors/bitbucket-to-ghes.ts", "migrate/ghes/import"],
    ["migrate/executors/registry.ts", "migrate/executors/github-to-ghec"],
    ["application/adapters/source-runtime.ts", "source/bitbucket/client"],
  ])("allows same-provider or shared-protocol imports from %s to %s", (from, to) => {
    expect(checkSourceProviderBoundary(from, to)).toBeNull();
  });
});
