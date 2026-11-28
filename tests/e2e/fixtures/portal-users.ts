// Run in Bun after the isolated Playwright server has bootstrapped its admin.
import { createUser, findUserByUsername } from "../../../src/lib/server/core/auth/users";
import { DOMAIN_STORES } from "../../../src/lib/server/schemas";
import { closeStore, getDb, initStore } from "../../../src/lib/server/core/db";
import { settleProfileInventoryRun } from "../../../src/lib/server/profile/database/inventories";
import { createProfileRun } from "../../../src/lib/server/profile/database/runs";
import { assignGrant, configuredGrantSource } from "../../../src/lib/server/application/self-service/grants";

const suffix = process.argv[2];
const password = process.env.PORTAL_TEST_PASSWORD;
if (!suffix || !password) throw new Error("Missing test identity");
initStore(".e2e-data/gh-migrate.db", DOMAIN_STORES, { runStartupHooks: false });
const admin = findUserByUsername("e2e-admin");
if (!admin) throw new Error("Missing bootstrap administrator");
const sourceProvider = "bitbucket-server";
const sourceApiUrl = configuredGrantSource(sourceProvider);
const targetOrg = "test-target-org";
const timestamp = "2021-03-01T12:00:00.000Z";
const unavailable = { kind: "unavailable", reason: "not-reported" } as const;
for (const tag of ["a", "b"]) {
  const username = `portal-${tag}-${suffix}`;
  const namespace = `PORTAL${tag.toUpperCase()}${suffix}`;
  const repo = `private-${tag}`;
  const { user } = await createUser({ username, role: "operator", password });
  assignGrant(admin.id, user.id, {
    sourceProvider, sourceApiUrl, namespace, targetOrg, targetProfileId: "ghec", canMigrate: tag === "a",
  });
  createProfileRun({ id: username, sourceProvider, sourceApiUrl, org: namespace, nowMs: Date.parse(timestamp) });
  settleProfileInventoryRun(username, {
    version: 1, provider: sourceProvider, sourceApiUrl, namespace, projectCount: {kind: "exact", value: 1},
    projects: [{
      provider: sourceProvider, sourceId: "1", path: `${namespace}/${repo}`, name: repo, visibility: "private",
      archived: false, defaultBranch: "main", lastActivityAt: null, repositorySizeBytes: unavailable,
      storageSizeBytes: unavailable, lfsObjectsSizeBytes: unavailable, packagesSizeBytes: unavailable,
      wikiSizeBytes: unavailable, uploadsSizeBytes: unavailable,
    }],
  }, 0, Date.parse(timestamp));
  const db = getDb();
  db.query(`INSERT INTO migrations (id, owner_user_id, source_provider, source_api_url, source_org,
    source_repo, target_org, target_repo, state, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?)`)
    .run(username, admin.id, sourceProvider, sourceApiUrl, namespace, repo, targetOrg, repo, timestamp, timestamp);
  db.query(`INSERT INTO events (migration_id,event_type,phase,payload,created_at)
    VALUES (?, 'step','IMPORTING_GIT','{"message":"private-provider-diagnostic"}',?)`).run(username, timestamp);
}
closeStore();
