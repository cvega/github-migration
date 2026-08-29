import { expect, test } from "bun:test";
import { getMigrationReadiness, getMigrationReadinessReport } from "./readiness";

test("reports request-auth GitHub readiness through the authoritative capability owner", () => {
  expect(
    getMigrationReadiness("github", "ghec", {
      sourceAuthProvided: true,
      targetAuthProvided: true,
    }),
  ).toMatchObject({
    sourceProvider: "github",
    targetProfileId: "ghec",
    targetPlatform: "ghec",
    status: "ready",
    reasons: [],
  });
});

test("reports missing target profiles and includes every configured route", () => {
  expect(getMigrationReadiness("github", "missing")).toMatchObject({
    targetPlatform: null,
    status: "blocked",
    reasons: [{ code: "target-profile-not-configured" }],
  });
  expect(getMigrationReadinessReport().migrations.map((route) => route.sourceProvider)).toEqual([
    "github",
    "gitlab",
    "bitbucket-server",
  ]);
});
