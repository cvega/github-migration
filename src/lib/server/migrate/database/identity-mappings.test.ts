import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import {
  approveIdentityMapping,
  beginIdentityInvitation,
  discoverIdentityMapping,
  listIdentityMappings,
  markIdentityInvitationSent,
  rejectIdentityInvitation,
  saveIdentityMappings,
} from "./identity-mappings";
import { migrateStore } from "./schema";

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

test("keeps approved identity decisions scoped and preserves them on rediscovery", () => {
  const mapping = {
    targetApiUrl: "https://ghes.example/api/v3",
    targetOrg: "target",
    sourceKind: "ghe-migrator:bitbucket-server",
    sourceIdentity: "http://source/users/alice",
    targetLogin: "octocat",
  };
  discoverIdentityMapping(
    mapping.targetApiUrl,
    mapping.targetOrg,
    mapping.sourceKind,
    mapping.sourceIdentity,
  );
  approveIdentityMapping(mapping);
  discoverIdentityMapping(
    mapping.targetApiUrl,
    mapping.targetOrg,
    mapping.sourceKind,
    mapping.sourceIdentity,
  );
  expect(listIdentityMappings(mapping.targetApiUrl, mapping.targetOrg)).toMatchObject([
    { targetLogin: "octocat", status: "approved" },
  ]);
  expect(listIdentityMappings(mapping.targetApiUrl, "other")).toEqual([]);
  expect(listIdentityMappings("https://other.example/api/v3", mapping.targetOrg)).toEqual([]);
});

test("saves imports atomically without overwriting existing decisions", () => {
  const url = "https://ghes.example/api/v3";
  const kind = "ghe-migrator:bitbucket-server";
  saveIdentityMappings(url, "target", kind, [
    { sourceIdentity: "https://source/users/a", targetLogin: "one" },
  ]);
  expect(() =>
    saveIdentityMappings(url, "target", kind, [
      { sourceIdentity: "https://source/users/b", targetLogin: "two" },
      { sourceIdentity: "https://source/users/a", targetLogin: "other" },
    ]),
  ).toThrow("different target");
  expect(listIdentityMappings(url, "target")).toMatchObject([
    { sourceIdentity: "https://source/users/a", targetLogin: "one" },
  ]);
});

test("prevents duplicate or uncertain invitation submissions", () => {
  const mapping = {
    targetApiUrl: "https://api.github.com",
    targetOrg: "target",
    sourceIdentity: "M1",
    targetLogin: "octocat",
  };
  expect(beginIdentityInvitation(mapping)).toBe(true);
  expect(beginIdentityInvitation(mapping)).toBe(false);
  expect(listIdentityMappings(mapping.targetApiUrl, mapping.targetOrg)).toMatchObject([
    { status: "invitation_pending" },
  ]);
  rejectIdentityInvitation(mapping);
  expect(beginIdentityInvitation(mapping)).toBe(true);
  markIdentityInvitationSent(mapping);
  expect(beginIdentityInvitation(mapping)).toBe(false);
});
