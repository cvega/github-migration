/**
 * Tests for the profile events SSE endpoint. The streaming branches are covered
 * by the bus unit tests + runtime smoke; here we pin the cheap, deterministic
 * guard: an unknown run is a 404 (and never opens a stream).
 */
import { beforeEach, expect, test } from "bun:test";
import { initStore } from "$lib/server/core/db";
import { DOMAIN_STORES } from "$lib/server/registry";
import { GET } from "./+server";

beforeEach(() => {
  initStore(":memory:", DOMAIN_STORES);
});

type GetArgs = Parameters<typeof GET>[0];

test("returns 404 for an unknown run", async () => {
  const res = await GET({ params: { id: "missing" } } as unknown as GetArgs);
  expect(res.status).toBe(404);
});
