/**
 * Tests for the archive-export wait helper. `waitForArchive` polls a GHES
 * migration's status and resolves with the archive URL once it's exported.
 *
 * The helper takes a full `InstanceType<typeof RetryOctokit>` (hundreds of
 * methods, overloaded `request`), which is impractical to construct in a unit
 * test, so the fake implements only `request()` and is cast at the test
 * boundary — a third-party-type test double that silences no production type
 * error (the helper's real signature is unchanged).
 */
import { describe, expect, test } from "bun:test";
import { waitForArchive } from "./github-ops";

type FakeClient = Parameters<typeof waitForArchive>[0];

/**
 * Fake client for the archive-polling helper. `request()` routes by URL: the
 * `/archive` endpoint returns the download URL; every other call returns the
 * next status from `statuses` (the last entry repeats once exhausted).
 */
function archiveClient(
  statuses: string[],
  archiveUrl = "https://archive.example/dl.tar",
): {
  client: FakeClient;
  statusCalls: () => number;
} {
  let i = 0;
  const client = {
    request: async (route: string) => {
      if (route.includes("/archive")) return { data: archiveUrl };
      const state = statuses[Math.min(i, statuses.length - 1)];
      i++;
      return { data: { state } };
    },
  } as unknown as FakeClient;
  return { client, statusCalls: () => i };
}

describe("waitForArchive", () => {
  test("returns the archive URL once the export is 'exported'", async () => {
    const { client } = archiveClient(["exported"]);
    const url = await waitForArchive(client, "acme", 42, undefined, 1);
    expect(url).toBe("https://archive.example/dl.tar");
  });

  test("polls until the status flips to 'exported'", async () => {
    const { client, statusCalls } = archiveClient(["pending", "exporting", "exported"]);
    const url = await waitForArchive(client, "acme", 42, undefined, 1);
    expect(url).toBe("https://archive.example/dl.tar");
    // Three status polls (pending → exporting → exported) before the archive fetch.
    expect(statusCalls()).toBe(3);
  });

  test("throws when the export reports 'failed'", async () => {
    const { client } = archiveClient(["failed"]);
    await expect(waitForArchive(client, "acme", 7, undefined, 1)).rejects.toThrow(
      /Archive export 7 failed/,
    );
  });

  test("throws immediately when the signal is already aborted", async () => {
    const { client } = archiveClient(["pending"]);
    const ac = new AbortController();
    ac.abort();
    await expect(waitForArchive(client, "acme", 1, ac.signal, 1)).rejects.toThrow(/aborted/i);
  });

  test("throws a timeout error once the deadline passes", async () => {
    const { client } = archiveClient(["pending"]);
    // maxWaitMs = 0 → the deadline is already in the past on the first check.
    await expect(waitForArchive(client, "acme", 9, undefined, 1, 0)).rejects.toThrow(/timed out/);
  });
});
