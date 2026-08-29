import { describe, expect, test } from "bun:test";
import type { Migration } from "$lib/migrate/types";
import type { GitHubClient, GitHubClients } from "$lib/server/core/github";
import {
  __setArchiveTransportDependenciesForTests,
  assertTrustedArchiveHost,
  checkGhesVersion,
  resolveMigrationArchives,
  startGitArchiveExport,
  startMetadataArchiveExport,
  waitForArchive,
} from "./exports";

function client(
  request: (route: string, options?: Record<string, unknown>) => Promise<{ data: unknown }>,
): GitHubClient {
  return { request } as unknown as GitHubClient;
}

describe("GitHub archive exports", () => {
  test("requires GHES 3.15 or newer", async () => {
    await expect(
      checkGhesVersion(client(async () => ({ data: { installed_version: "3.14.9" } }))),
    ).rejects.toThrow("below minimum required 3.15.0");
    expect(
      await checkGhesVersion(client(async () => ({ data: { installed_version: "3.15.0" } }))),
    ).toBe("3.15.0");
  });

  test("starts git and metadata exports with distinct flags", async () => {
    const calls: Array<{ route: string; options?: Record<string, unknown> }> = [];
    const github = client(async (route, options) => {
      calls.push({ route, options });
      return { data: { id: calls.length } };
    });
    expect(await startGitArchiveExport(github, "acme", "widget")).toBe(1);
    expect(await startMetadataArchiveExport(github, "acme", "widget", true, false)).toBe(2);
    expect(calls[0]?.options).toMatchObject({ exclude_metadata: true });
    expect(calls[1]?.options).toMatchObject({
      exclude_git_data: true,
      exclude_releases: true,
      lock_repositories: false,
    });
  });

  test("polls until exported and returns the trimmed archive URL", async () => {
    let statusCalls = 0;
    const github = client(async (route) => {
      if (route.endsWith("/archive")) return { data: " https://archives.example/1 \n" };
      statusCalls += 1;
      return { data: { state: statusCalls === 1 ? "pending" : "exported" } };
    });
    expect(await waitForArchive(github, "acme", 1, undefined, 0)).toBe(
      "https://archives.example/1",
    );
  });

  test("fails terminal exports and aborts waiting", async () => {
    const failed = client(async () => ({ data: { state: "failed" } }));
    await expect(waitForArchive(failed, "acme", 1, undefined, 0)).rejects.toThrow(
      "Archive export 1 failed",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(waitForArchive(failed, "acme", 1, controller.signal, 0)).rejects.toThrow(
      "Archive wait aborted",
    );
  });
});

test("skips archive transport for GHEC sources", async () => {
  const steps: string[] = [];
  const result = await resolveMigrationArchives(
    {} as GitHubClients,
    { sourceApiUrl: "https://api.github.com" } as Migration,
    {},
    (message) => steps.push(message),
  );
  expect(result).toEqual({ gitArchiveUrl: "", metadataArchiveUrl: "" });
  expect(steps).toEqual(["GHEC to GHEC migration - no archive export needed"]);
});

test("pins direct archive passthrough to the source origin", async () => {
  const restore = __setArchiveTransportDependenciesForTests({
    startGitArchiveExport: async () => 1,
    startMetadataArchiveExport: async () => 2,
    waitForArchive: async (_client, _org, id) =>
      id === 1 ? "https://github.example/git.tar.gz" : "https://attacker.example/metadata.tar.gz",
  });
  try {
    await expect(
      resolveMigrationArchives(
        { source: {} } as GitHubClients,
        {
          sourceApiUrl: "https://github.example/api/v3",
          sourceOrg: "acme",
          sourceRepo: "widget",
        } as Migration,
        { directPassthrough: true },
        () => {},
      ),
    ).rejects.toThrow("Refusing to send credentials");
  } finally {
    restore();
  }
  expect(() =>
    assertTrustedArchiveHost(
      "https://github.example/archive.tar.gz",
      "https://github.example/api/v3",
    ),
  ).not.toThrow();
});
