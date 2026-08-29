import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const LOCK_DATABASE = ".gh-migrate-instance-lock.sqlite";

export interface InstanceLock {
  readonly path: string;
  release(): void;
}

export function acquireInstanceLock(dataDirectory: string): InstanceLock {
  mkdirSync(dataDirectory, { recursive: true });
  const path = join(dataDirectory, LOCK_DATABASE);
  const database = new Database(path, { create: true });

  try {
    database.run("PRAGMA busy_timeout = 0");
    database.run("BEGIN EXCLUSIVE");
  } catch (cause) {
    database.close();
    throw new Error(
      `Another GitHub Migration Toolkit process is already using data directory '${dataDirectory}'. Only one process may use a data directory.`,
      { cause },
    );
  }

  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      try {
        database.run("ROLLBACK");
      } finally {
        database.close();
      }
    },
  };
}
