import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { authStore } from "$lib/server/core/auth/schema";
import { verifyLoginAttempt } from "$lib/server/core/auth/throttle";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { actions } from "./+page.server";

beforeEach(() => initStore(":memory:", [authStore]));
afterEach(() => closeStore());

async function signIn(username = "admin") {
  const setHeaders = mock();
  const action = actions.default;
  const response = await action({
    request: new Request("http://localhost/login", {
      method: "POST",
      body: new URLSearchParams({ username }),
    }),
    locals: { authEnabled: true },
    getClientAddress: () => "192.0.2.1",
    setHeaders,
  } as unknown as Parameters<typeof action>[0]);
  return { response, setHeaders };
}

test("oversized usernames are rejected before writing sign-in records", async () => {
  const { response } = await signIn("a".repeat(33));

  expect(response).toMatchObject({ status: 401, data: { username: "" } });
  expect(getDb().query("SELECT username FROM auth_login_attempts").all()).toEqual([]);
  expect(getDb().query("SELECT metadata FROM audit_events").all()).toEqual([]);
});

test("password-like usernames are stored and audited as a bounded digest", async () => {
  const fixture = "Fixture!For Testing";
  const { response } = await signIn(fixture);
  await signIn(`  ${fixture.toUpperCase()}  `);

  expect(response).toMatchObject({ status: 401, data: { username: "" } });
  const attempts = getDb()
    .query<{ username: string }, []>("SELECT username FROM auth_login_attempts")
    .all();
  const key = attempts[0]?.username ?? "";
  expect(key).toMatch(/^![a-f0-9]{31}$/);
  expect(attempts).toEqual([{ username: key }, { username: key }]);
  expect(getDb().query("SELECT action, metadata FROM audit_events").all()).toEqual(
    Array.from({ length: 2 }, () => ({
      action: "auth.login.failed",
      metadata: JSON.stringify({ username: key }),
    })),
  );
});

test("a full sign-in window returns 429 with Retry-After", async () => {
  for (let i = 0; i < 5; i++) await verifyLoginAttempt(" AdMiN ", "192.0.2.1", async () => null);
  expect(getDb().query("SELECT DISTINCT username FROM auth_login_attempts").all()).toEqual([
    { username: "admin" },
  ]);
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
