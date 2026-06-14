/**
 * Tests for the Profile SSE bus. A fake stream controller captures the encoded
 * frames so we can assert delivery, fan-out, unsubscribe cleanup, and that a
 * throwing controller is dropped without disrupting the others.
 */
import { describe, expect, test } from "bun:test";
import {
  type ProfileSseEvent,
  publishProfileEvent,
  sendProfileEvent,
  subscribeProfile,
} from "./events";

/** A stand-in for a ReadableStream controller that records enqueued frames. */
function fakeController(sink: string[]): ReadableStreamDefaultController<string> {
  return {
    enqueue: (chunk: string) => {
      sink.push(chunk);
    },
  } as unknown as ReadableStreamDefaultController<string>;
}

/** Parse the JSON payload out of an SSE `data:` frame. */
function parse(frame: string): ProfileSseEvent {
  return JSON.parse(frame.replace(/^data: /, "").trimEnd());
}

const progress = (over: Partial<{ profiled: number; total: number; repo: string }> = {}) =>
  ({ type: "progress", profiled: 1, total: 3, repo: "acme/widget", ...over }) as const;

describe("subscribeProfile / publishProfileEvent", () => {
  test("delivers published events to a subscriber as SSE frames", () => {
    const sink: string[] = [];
    subscribeProfile("run-1", fakeController(sink));

    publishProfileEvent("run-1", progress());

    expect(sink).toHaveLength(1);
    expect(sink[0]).toBe(
      'data: {"type":"progress","profiled":1,"total":3,"repo":"acme/widget"}\n\n',
    );
    expect(parse(sink[0] as string)).toEqual(progress());
  });

  test("fans out to every subscriber of the same run", () => {
    const a: string[] = [];
    const b: string[] = [];
    subscribeProfile("run-1", fakeController(a));
    subscribeProfile("run-1", fakeController(b));

    publishProfileEvent("run-1", { type: "done", state: "completed" });

    expect(parse(a[0] as string)).toEqual({ type: "done", state: "completed" });
    expect(parse(b[0] as string)).toEqual({ type: "done", state: "completed" });
  });

  test("isolates runs — a publish only reaches that run's subscribers", () => {
    const one: string[] = [];
    const two: string[] = [];
    subscribeProfile("run-1", fakeController(one));
    subscribeProfile("run-2", fakeController(two));

    publishProfileEvent("run-1", progress());

    expect(one).toHaveLength(1);
    expect(two).toHaveLength(0);
  });

  test("unsubscribe stops further delivery", () => {
    const sink: string[] = [];
    const unsubscribe = subscribeProfile("run-1", fakeController(sink));

    unsubscribe();
    publishProfileEvent("run-1", progress());

    expect(sink).toHaveLength(0);
  });

  test("publishing to a run with no subscribers is a no-op", () => {
    expect(() => publishProfileEvent("ghost", progress())).not.toThrow();
  });

  test("drops a controller that throws on enqueue but still reaches the others", () => {
    const good: string[] = [];
    const exploding = {
      enqueue: () => {
        throw new Error("client gone");
      },
    } as unknown as ReadableStreamDefaultController<string>;
    subscribeProfile("run-1", exploding);
    subscribeProfile("run-1", fakeController(good));

    publishProfileEvent("run-1", progress());

    expect(good).toHaveLength(1);

    // The dead controller was removed, so a second publish only has the good one.
    good.length = 0;
    publishProfileEvent("run-1", progress({ profiled: 2 }));
    expect(good).toHaveLength(1);
  });
});

describe("sendProfileEvent", () => {
  test("encodes a single event to one controller", () => {
    const sink: string[] = [];
    sendProfileEvent(fakeController(sink), { type: "done", state: "failed" });

    expect(parse(sink[0] as string)).toEqual({ type: "done", state: "failed" });
  });
});
