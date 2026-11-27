import { expect, mock, test } from "bun:test";
import { authStore } from "$lib/server/core/auth/schema";
import { verifyLoginAttempt } from "$lib/server/core/auth/throttle";
import { closeStore, initStore } from "$lib/server/core/db";
import { actions } from "./+page.server";

test("a full sign-in window returns 429 with Retry-After", async () => {
  initStore(":memory:", [authStore]);
  try {
    const ip = "192.0.2.1";
    for (let i = 0; i < 5; i++) await verifyLoginAttempt("admin", ip, async () => null);
    const setHeaders = mock();
    const action = actions.default;
    const response = await action({
      request: new Request("http://localhost/login", {
        method: "POST",
        body: new URLSearchParams({ username: "admin" }),
      }),
      locals: { authEnabled: true },
      getClientAddress: () => ip,
      setHeaders,
    } as unknown as Parameters<typeof action>[0]);
    expect(response).toMatchObject({ status: 429, data: { username: "admin" } });
    expect(setHeaders).toHaveBeenCalledWith({ "Retry-After": "900" });
  } finally {
    closeStore();
  }
});
