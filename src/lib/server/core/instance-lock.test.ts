import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock } from "./instance-lock";

function temporaryDataDirectory(): string {
  return mkdtempSync(join(tmpdir(), "gh-migrate-instance-lock-"));
}

describe("instance lock", () => {
  test("rejects a second owner and permits a replacement after release", () => {
    const dataDirectory = temporaryDataDirectory();
    try {
      const first = acquireInstanceLock(dataDirectory);
      expect(() => acquireInstanceLock(dataDirectory)).toThrow("already using data directory");
      first.release();

      const replacement = acquireInstanceLock(dataDirectory);
      replacement.release();
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  test("releases ownership automatically after the owner process crashes", async () => {
    const dataDirectory = temporaryDataDirectory();
    const moduleUrl = new URL("./instance-lock.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `const { acquireInstanceLock } = await import(${JSON.stringify(moduleUrl)}); globalThis.instanceLock = acquireInstanceLock(${JSON.stringify(dataDirectory)}); console.log("LOCKED"); setInterval(() => {}, 1000);`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      const reader = child.stdout.getReader();
      const ready = (async () => {
        let output = "";
        while (!output.includes("LOCKED")) {
          const { done, value } = await reader.read();
          if (done) throw new Error("Lock holder exited before acquiring the lock");
          output += new TextDecoder().decode(value);
        }
        reader.releaseLock();
      })();
      await Promise.race([
        ready,
        Bun.sleep(5000).then(() => {
          throw new Error("Timed out waiting for the lock holder");
        }),
      ]);

      expect(() => acquireInstanceLock(dataDirectory)).toThrow("already using data directory");
      child.kill("SIGKILL");
      await child.exited;

      const replacement = acquireInstanceLock(dataDirectory);
      replacement.release();
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });
});
