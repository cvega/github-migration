import { appendFileSync } from "node:fs";
import { initStore } from "../../src/lib/server/core/db";
import { createTargetClients } from "../../src/lib/server/core/github";
import { getMigration } from "../../src/lib/server/migrate/database/migrations";
import {
  __setArchiveToGhecDependenciesForTests,
  executeArchiveToGhec,
} from "../../src/lib/server/migrate/executors/archive-to-ghec";

const [database, ledger, id] = process.argv.slice(2);
if (!database || !ledger || !id) throw new Error("Missing crash fixture arguments");
initStore(database, []);
const migration = getMigration(id);
if (!migration) throw new Error("Missing fixture migration");
__setArchiveToGhecDependenciesForTests({
  getOrgId: async () => "org",
  createMigrationSource: async () => "source",
  startMigration: async () => {
    appendFileSync(ledger, `${id}\n`);
    process.kill(process.pid, "SIGKILL");
    throw new Error("Worker survived SIGKILL");
  },
});
await executeArchiveToGhec({
  migration,
  clients: createTargetClients({token:"fixture"}, migration.targetApiUrl),
  request: {},
  sourceRepoUrl: "https://fixture.invalid/source/repo",
  sourceToken: "fixture",
  targetToken: "fixture",
  gitArchiveUrl: "gei://archive/fixture",
  metadataArchiveUrl: "",
  emit: () => {},
});
