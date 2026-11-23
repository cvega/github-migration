import { expect, test } from "bun:test";
import {
  bitbucketGroupIdentity,
  bitbucketUserIdentity,
  parseIdentityCsv,
  sourceIdentityLabel,
  validateIdentityInput,
} from "./identity-input";

test("Bitbucket group mappings display distinct project keys for the same group", () => {
  const kind = "ghe-migrator:bitbucket-server:team";
  for (const key of ["TEST", "PROF01"]) {
    const id = bitbucketGroupIdentity("https://bb.example/context/rest/api/1.0", key, "group&a");
    expect(id).toBe(`https://bb.example/context/admin/groups/view?name=group%26a#${key}`);
    expect(sourceIdentityLabel(kind, id)).toBe(key);
    expect(sourceIdentityLabel(kind, id.split("#")[0]!)).toBe("group&a");
    expect(sourceIdentityLabel("ghe-migrator:gitlab:team", id)).toBe(id);
  }
  expect(() => bitbucketGroupIdentity("https://bb.example", "invalid/key", "group")).toThrow(
    "project key",
  );
});

test("manual Bitbucket user mappings keep the archive URL but display the source username", () => {
  const base = "https://bb.example/context/rest/api/1.0";
  const kind = "ghe-migrator:bitbucket-server";
  const identity = bitbucketUserIdentity(base, "source user");
  expect(identity).toBe("https://bb.example/context/users/source%20user");
  expect(sourceIdentityLabel(kind, identity)).toBe("source user");
  expect(sourceIdentityLabel(kind, "http://bitbucket:7990/users/admin")).toBe("admin");
  expect(() => bitbucketUserIdentity(base, "../alice")).toThrow("username");
});

test("preserves an exact project-scoped Bitbucket group URL from a team CSV", () => {
  const source = "http://bitbucket/admin/groups/view?name=project_admin_access#TEST";
  expect(
    parseIdentityCsv(
      "ghe-migrator:bitbucket-server:team",
      `source_identity,target_team_slug\n${source},project_admin_access`,
    ),
  ).toEqual([{ sourceIdentity: source, targetLogin: "project_admin_access" }]);
  expect(() =>
    validateIdentityInput("ghe-migrator:bitbucket-server:team", {
      sourceIdentity: source,
      targetLogin: "other-org/team",
    }),
  ).toThrow("slug");
});

test("parses identity CSV without requiring the target user to exist", () => {
  expect(
    parseIdentityCsv(
      "ghe-migrator:bitbucket-server",
      "source_identity,target_username\nhttp://source/users/alice,alice-target\n",
    ),
  ).toEqual([{ sourceIdentity: "http://source/users/alice", targetLogin: "alice-target" }]);
});

test("rejects malformed, ambiguous, or unsafe input", () => {
  expect(() =>
    parseIdentityCsv("mannequin-login", "source_identity,target_username\nAlice,one\nalice,two\n"),
  ).toThrow("duplicate");
  expect(() => parseIdentityCsv("mannequin-login", "source,target\nalice,one")).toThrow("headers");
  expect(() =>
    validateIdentityInput("ghe-migrator:bitbucket-server", {
      sourceIdentity: "https://user:secret@source/users/a",
      targetLogin: "alice",
    }),
  ).toThrow("without credentials");
});
