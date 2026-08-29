import { describe, expect, test } from "bun:test";
import { sleep } from "./polling";

describe("sleep", () => {
  test("resolves after the requested delay", async () => {
    const startedAt = Date.now();
    await sleep(20);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });

  test("rejects immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1000, controller.signal)).rejects.toThrow("Aborted");
  });

  test("rejects when aborted during the wait", async () => {
    const controller = new AbortController();
    const waiting = sleep(1000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow("Aborted");
  });
});
