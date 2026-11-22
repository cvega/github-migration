import { validateProfileCredentialScope } from "$lib/server/core/credential-scope";
import { getDb } from "$lib/server/core/db";
import { SOURCE_PROVIDERS, type SourceProvider } from "$lib/source-provider";
import { BitbucketProfileCapacityError, GitLabProfileCapacityError } from "../service";
import { ProfileRunCapacityError } from "./runs";

export function enqueueProfiles(provider: SourceProvider, namespaces: string[]) {
  const db = getDb();
  const insert = db.prepare(`INSERT INTO profile_queue(provider,namespace)
    SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM profile_runs WHERE state='running'
    AND source_provider=? AND org=? COLLATE NOCASE)
    ON CONFLICT(provider,namespace) DO UPDATE SET failure=NULL WHERE failure IS NOT NULL`);
  return db.transaction(() =>
    namespaces.reduce((count, ns) => count + insert.run(provider, ns, provider, ns).changes, 0),
  )();
}

export function profileQueueStatus(provider: SourceProvider) {
  return getDb()
    .query<{ pending: number; failed: number }, [string]>(`SELECT
    count(*) FILTER(WHERE failure IS NULL) AS pending,
    count(*) FILTER(WHERE failure IS NOT NULL) AS failed FROM profile_queue WHERE provider=?`)
    .get(provider);
}

export function dispatchProfiles(start: (provider: SourceProvider, namespace: string) => void) {
  const db = getDb();
  for (const provider of SOURCE_PROVIDERS) {
    db.transaction(() => {
      const item = db
        .query<
          { id: number; namespace: string },
          [string, string]
        >(`SELECT id,namespace FROM profile_queue
      WHERE provider=? AND failure IS NULL AND NOT EXISTS
      (SELECT 1 FROM profile_runs WHERE state='running' AND source_provider=?) ORDER BY id LIMIT 1`)
        .get(provider, provider);
      if (!item) return;
      try {
        const denied = validateProfileCredentialScope(provider, item.namespace);
        if (denied) throw new Error("Profile scope no longer permits this namespace");
        start(provider, item.namespace);
      } catch (error) {
        if (
          error instanceof ProfileRunCapacityError ||
          error instanceof BitbucketProfileCapacityError ||
          error instanceof GitLabProfileCapacityError
        )
          return;
        console.warn(
          `[profile queue] Could not start ${provider}/${item.namespace}: ${error instanceof Error ? error.name : "unknown error"}`,
        );
        db.prepare("UPDATE profile_queue SET failure=? WHERE id=?").run(
          "Failed to start; check source configuration and permissions",
          item.id,
        );
        return;
      }
      db.prepare("DELETE FROM profile_queue WHERE id=?").run(item.id);
    })();
  }
}
