import { describe, expect, test } from "bun:test";
import { type ProfileRun, type RepoSignals, UNKNOWN_ORG_RESOURCES } from "./types";

describe("profile contracts", () => {
  test("provides an unavailable organization resource baseline", () => {
    expect(UNKNOWN_ORG_RESOURCES).toEqual({
      actionsSecrets: null,
      actionsVariables: null,
      dependabotSecrets: null,
      codespacesSecrets: null,
      selfHostedRunners: null,
      customProperties: null,
      teams: null,
      appInstallations: null,
    });
  });

  test("keeps run and repository identities explicit", () => {
    const run = { sourceProvider: "github", state: "running" } as ProfileRun;
    const repo = { nameWithOwner: "acme/widget", visibility: "PRIVATE" } as RepoSignals;
    expect(run.sourceProvider).toBe("github");
    expect(repo.nameWithOwner).toBe("acme/widget");
  });
});
