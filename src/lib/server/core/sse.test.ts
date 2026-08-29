import { afterEach, describe, expect, test } from "bun:test";
import { createBufferedSseController, parseSseLastEventId, sseResponse } from "./sse";

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

describe("sseResponse", () => {
  test("does not create a keepalive when setup closes the stream", async () => {
    let intervals = 0;
    globalThis.setInterval = (() => {
      intervals++;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;

    const response = sseResponse((controller) => {
      controller.enqueue("data: done\n\n");
      controller.close();
      return null;
    });

    expect(await response.text()).toBe("data: done\n\n");
    expect(intervals).toBe(0);
  });

  test("cleans up an open stream when the reader cancels", async () => {
    let cleanedUp = false;
    let cleared = false;
    globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {
      cleared = true;
    }) as typeof clearInterval;

    const response = sseResponse(() => () => {
      cleanedUp = true;
    });
    await response.body?.cancel();

    expect(cleanedUp).toBe(true);
    expect(cleared).toBe(true);
  });
});

describe("parseSseLastEventId", () => {
  test("accepts an absent cursor and non-negative safe integers", () => {
    expect(parseSseLastEventId(null)).toBeUndefined();
    expect(parseSseLastEventId("0")).toBe(0);
    expect(parseSseLastEventId("42")).toBe(42);
  });

  test("rejects partial, negative, decimal, and unsafe cursors", () => {
    for (const value of ["", "-1", "1.5", "12junk", "9007199254740992"]) {
      expect(() => parseSseLastEventId(value)).toThrow();
    }
  });
});

describe("createBufferedSseController", () => {
  test("drains only live frames newer than the replay high-water mark", () => {
    const frames: string[] = [];
    const target = {
      enqueue: (frame: string) => frames.push(frame),
      close: () => {},
    } as unknown as ReadableStreamDefaultController<string>;
    const handoff = createBufferedSseController(target);

    handoff.controller.enqueue("id: 2\ndata: duplicate\n\n");
    handoff.controller.enqueue("id: 3\ndata: live\n\n");
    expect(frames).toEqual([]);

    expect(handoff.activate(2)).toBe(false);
    expect(frames).toEqual(["id: 3\ndata: live\n\n"]);
  });

  test("defers close until buffered frames are activated", () => {
    const calls: string[] = [];
    const target = {
      enqueue: (frame: string) => calls.push(frame),
      close: () => calls.push("closed"),
    } as unknown as ReadableStreamDefaultController<string>;
    const handoff = createBufferedSseController(target);

    handoff.controller.enqueue('data: {"type":"done"}\n\n');
    handoff.controller.close();
    expect(handoff.activate(10)).toBe(true);
    expect(calls).toEqual(['data: {"type":"done"}\n\n', "closed"]);
  });
});
