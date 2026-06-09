import { describe, expect, test } from "bun:test";
import { extractOrg, extractRepo, sleep } from "./util";

describe("extractOrg", () => {
  test("returns the org portion of an org/repo slug", () => {
    expect(extractOrg("acme/widget")).toBe("acme");
  });

  test("returns the segment before the first slash for nested paths", () => {
    expect(extractOrg("acme/team/widget")).toBe("acme");
  });

  test("returns the whole string when there is no slash", () => {
    expect(extractOrg("widget")).toBe("widget");
  });

  test("returns an empty string when the slug starts with a slash", () => {
    expect(extractOrg("/widget")).toBe("");
  });
});

describe("extractRepo", () => {
  test("returns the repo portion of an org/repo slug", () => {
    expect(extractRepo("acme/widget")).toBe("widget");
  });

  test("returns everything after the first slash for nested paths", () => {
    expect(extractRepo("acme/team/widget")).toBe("team/widget");
  });

  test("returns the whole string when there is no slash", () => {
    expect(extractRepo("widget")).toBe("widget");
  });

  test("strips a leading slash", () => {
    expect(extractRepo("/widget")).toBe("widget");
  });
});

describe("sleep", () => {
  test("resolves after the given delay", async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  test("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1000, controller.signal)).rejects.toThrow("Aborted");
  });

  test("rejects when aborted during the wait", async () => {
    const controller = new AbortController();
    const promise = sleep(1000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow("Aborted");
  });
});
