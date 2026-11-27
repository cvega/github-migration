import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { authStore } from "$lib/server/core/auth/schema";
import { verifyLoginAttempt } from "$lib/server/core/auth/throttle";
import { closeStore, initStore } from "$lib/server/core/db";
import { actions } from "./+page.server";

beforeEach(() => initStore(":memory:", [authStore]));
afterEach(() => closeStore());

async function signIn() {
  const setHeaders = mock();
  const action = actions.default;
  const response = await action({
    request: new Request("http://localhost/login", {
      method: "POST",
      body: new URLSearchParams({ username: "admin" }),
    }),
    locals: { authEnabled: true },
    getClientAddress: () => "192.0.2.1",
    setHeaders,
  } as unknown as Parameters<typeof action>[0]);
  return { response, setHeaders };
}

test("a full sign-in window returns 429 with Retry-After", async () => {
  for (let i = 0; i < 5; i++) await verifyLoginAttempt("admin", "192.0.2.1", async () => null);
  const { response, setHeaders } = await signIn();
  expect(response).toMatchObject({ status: 429, data: { username: "admin" } });
  expect(setHeaders).toHaveBeenCalledWith({ "Retry-After": "900" });
});

test("busy verification slots return 503 with a short Retry-After", async () => {
  const pending = Promise.withResolvers<null>();
  const attempts = Array.from({ length: 5 }, (_, i) =>
    verifyLoginAttempt("fixture", `192.0.2.${i + 2}`, () => pending.promise),
  );
  try {
    const { response, setHeaders } = await signIn();
    expect(response).toMatchObject({ status: 503, data: { username: "admin" } });
    expect(setHeaders).toHaveBeenCalledWith({ "Retry-After": "1" });
  } finally {
    pending.resolve(null);
    await Promise.all(attempts);
  }
});
