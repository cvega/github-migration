import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import { dispatchProfiles, enqueueProfiles, profileQueueStatus } from "./queue";
import { createProfileRun, failProfileRun } from "./runs";
import { profileStore } from "./schema";

beforeEach(() => initStore(":memory:", [profileStore]));
afterEach(closeStore);

test("deduplicates namespace work, waits for the active lane, and continues after failure", () => {
  const previous = process.env.PROFILE_CONNECTION_SCOPE;
  process.env.PROFILE_CONNECTION_SCOPE = "bitbucket-server";
  try {
    const provider = "bitbucket-server";
    expect(enqueueProfiles(provider, ["A", "B", "a"])).toBe(2);
    const started: string[] = [];
    const start = (_: string, org: string) => {
      createProfileRun({
        sourceProvider: provider,
        id: org,
        org,
        sourceApiUrl: "https://bb.example/rest/api/1.0",
        enforceCapacity: true,
      });
      started.push(org);
    };
    dispatchProfiles(start);
    expect(enqueueProfiles(provider, ["A", "B"])).toBe(0);
    dispatchProfiles(start);
    expect(started).toEqual(["A"]);
    failProfileRun("A", "fixture failure");
    dispatchProfiles(start);
    expect(started).toEqual(["A", "B"]);
    expect(profileQueueStatus(provider)).toEqual({ pending: 0, failed: 0 });
  } finally {
    if (previous === undefined) delete process.env.PROFILE_CONNECTION_SCOPE;
    else process.env.PROFILE_CONNECTION_SCOPE = previous;
  }
});
