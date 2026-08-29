import { describe, expect, test } from "bun:test";
import { publishProfileEvent, sendProfileEvent, subscribeProfile } from "./events";

function controller(frames: string[], fail = false): ReadableStreamDefaultController<string> {
  return {
    enqueue(frame: string) {
      if (fail) throw new Error("closed");
      frames.push(frame);
    },
  } as ReadableStreamDefaultController<string>;
}

describe("profile events", () => {
  test("encodes direct and run-scoped events", () => {
    const direct: string[] = [];
    sendProfileEvent(controller(direct), { type: "done", state: "completed" });
    expect(direct).toEqual(['data: {"type":"done","state":"completed"}\n\n']);

    const first: string[] = [];
    const other: string[] = [];
    const unsubscribe = subscribeProfile("run-1", controller(first));
    const unsubscribeOther = subscribeProfile("run-2", controller(other));
    publishProfileEvent("run-1", {
      type: "progress",
      profiled: 1,
      total: 2,
      repo: "acme/repo",
      phase: "counting",
    });
    expect(first).toHaveLength(1);
    expect(other).toEqual([]);
    unsubscribe();
    unsubscribeOther();
  });

  test("drops closed and explicitly unsubscribed controllers", () => {
    const frames: string[] = [];
    subscribeProfile("closed", controller([], true));
    publishProfileEvent("closed", { type: "done", state: "failed" });

    const unsubscribe = subscribeProfile("run", controller(frames));
    unsubscribe();
    publishProfileEvent("run", { type: "done", state: "completed" });
    expect(frames).toEqual([]);
  });
});
