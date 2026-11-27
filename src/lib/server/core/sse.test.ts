import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { authStore } from "./auth/schema";
import { createSession, hashSessionToken, revokeSession } from "./auth/sessions";
import { resetUserPassword, setUserActive, setUserRole } from "./auth/users";
import { closeStore, getDb, initStore } from "./db";
import { createBufferedSseController, parseSseLastEventId, sseResponse } from "./sse";

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

describe("sseResponse", () => {
  test("encodes terminal frames as bytes for the HTTP adapter", async () => {
    const response = sseResponse(undefined, (controller) => {
      controller.enqueue('data: {"type":"done"}\n\n');
      controller.close();
      return null;
    });
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(value).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(value)).toBe('data: {"type":"done"}\n\n');
    expect((await reader.read()).done).toBe(true);
  });

  test("propagates source errors through the byte stream", async () => {
    const response = sseResponse(undefined, (controller) => {
      controller.error(new Error("event source failed"));
      return null;
    });
    await expect(response.text()).rejects.toThrow("event source failed");
  });

  test("does not create a keepalive when setup closes the stream", async () => {
    let intervals = 0;
    globalThis.setInterval = (() => {
      intervals++;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;

    const response = sseResponse(undefined, (controller) => {
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

    const response = sseResponse(undefined, () => () => {
      cleanedUp = true;
    });
    await response.body?.cancel();

    expect(cleanedUp).toBe(true);
    expect(cleared).toBe(true);
  });
});

describe("authenticated stream keepalives", () => {
  beforeEach(() => {
    initStore(":memory:", [authStore]);
    for (const id of ["viewer", "other-admin"]) {
      getDb().run(
        `INSERT INTO app_users (id, username, password_hash, role, created_at, updated_at)
         VALUES (?, ?, 'fixture', 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, id],
      );
    }
  });
  afterEach(closeStore);

  const endSession = {
    logout: (token: string) => revokeSession(token),
    disable: () => setUserActive("other-admin", "viewer", false),
    "password reset": () => resetUserPassword("viewer"),
    "role change": () => setUserRole("other-admin", "viewer", "operator"),
    expiry: () => getDb().run("UPDATE app_sessions SET expires_at = '2000-01-01'"),
  };
  for (const [reason, invalidate] of Object.entries(endSession)) {
    test(`closes and unsubscribes on the first keepalive after ${reason}`, async () => {
      const token = createSession("viewer");
      let tick!: () => void;
      globalThis.setInterval = ((callback: () => void, ms: number) => {
        expect(ms).toBe(30_000);
        tick = callback;
        return 1;
      }) as unknown as typeof setInterval;
      const clear = mock(() => {});
      globalThis.clearInterval = clear;
      const unsubscribe = mock(() => {});
      const reader = sseResponse(
        { authEnabled: true, sessionTokenHash: hashSessionToken(token) },
        () => unsubscribe,
      ).body!.getReader();
      const decoder = new TextDecoder();
      tick();
      expect(decoder.decode((await reader.read()).value)).toBe(": keepalive\n\n");
      await invalidate(token);
      tick();
      expect(decoder.decode((await reader.read()).value)).toBe(
        "event: session-ended\ndata: {}\n\n",
      );
      expect((await reader.read()).done).toBe(true);
      expect(clear).toHaveBeenCalledTimes(1);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  }
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
