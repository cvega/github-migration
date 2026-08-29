import { afterEach, expect, test } from "bun:test";
import { __setProfileEventDependenciesForTests, GET } from "./+server";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

test("returns 404 for unknown profile runs", async () => {
  restore = __setProfileEventDependenciesForTests({ getProfileRun: () => null });
  const response = await GET({ params: { id: "missing" } } as never);
  expect(response.status).toBe(404);
});

test("immediately emits done for terminal runs", async () => {
  restore = __setProfileEventDependenciesForTests({
    getProfileRun: () => ({ state: "completed" }) as never,
    subscribeProfile: () => () => {},
  });
  const response = await GET({ params: { id: "run" } } as never);
  expect(await response.text()).toBe('data: {"type":"done","state":"completed"}\n\n');
});
