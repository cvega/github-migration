import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { authStore } from "$lib/server/core/auth/schema";
import { resolveSession, SESSION_COOKIE } from "$lib/server/core/auth/sessions";
import { verifyLoginAttempt } from "$lib/server/core/auth/throttle";
import { createUser } from "$lib/server/core/auth/users";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { actions } from "./+page.server";

beforeEach(() => initStore(":memory:", [authStore]));
afterEach(() => closeStore());

function loginEvent(username = "admin", password = "") {
  const setHeaders = mock();
  const setCookie = mock((_name: string, _value: string) => {});
  const url = new URL("https://dashboard.invalid/login");
  const event = {
    url,
    cookies: { set: setCookie },
    request: new Request(url, {
      method: "POST",
      body: new URLSearchParams({ username, password }),
    }),
    locals: { authEnabled: true },
    getClientAddress: () => "192.0.2.1",
    setHeaders,
  } as unknown as Parameters<typeof actions.default>[0];
  return { event, setHeaders, setCookie };
}

async function signIn(username = "admin") {
  const { event, setHeaders } = loginEvent(username);
  const response = await actions.default(event);
  return { response, setHeaders };
}

test("oversized usernames are rejected before writing sign-in records", async () => {
  const { response } = await signIn("a".repeat(33));

  expect(response).toMatchObject({ status: 401, data: { username: "" } });
  expect(getDb().query("SELECT username FROM auth_login_attempts").all()).toEqual([]);
  expect(getDb().query("SELECT metadata FROM audit_events").all()).toEqual([]);
});

test.each(["Fixture!For Testing", "FixtureForTesting"])(
  "stores a bounded throttle key and omits submitted usernames from failed audits (%s)",
  async (fixture) => {
    const { response } = await signIn(fixture);
    await signIn(`  ${fixture.toUpperCase()}  `);

    expect(response).toMatchObject({ status: 401 });
    const attempts = getDb()
      .query<{ username: string }, []>("SELECT username FROM auth_login_attempts")
      .all();
    const key = attempts[0]?.username ?? "";
    expect(key).toMatch(/^![a-f0-9]{31}$/);
    expect(attempts).toEqual([{ username: key }, { username: key }]);
    expect(getDb().query("SELECT action, metadata FROM audit_events").all()).toEqual(
      Array.from({ length: 2 }, () => ({
        action: "auth.login.failed",
        metadata: "{}",
      })),
    );
  },
);

test("a full sign-in window returns 429 with Retry-After", async () => {
  for (let i = 0; i < 5; i++) await verifyLoginAttempt(" AdMiN ", "192.0.2.1", async () => null);
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

test("successful sign-in issues an audited session and releases its throttle reservation", async () => {
  const password = "fixture current password";
  const { user } = await createUser({
    username: "fixture-operator",
    password,
    role: "operator",
    mustChangePassword: true,
  });
  await verifyLoginAttempt(user.username, "192.0.2.1", async () => null);
  const previousAttempts = getDb().query("SELECT id FROM auth_login_attempts").all();
  const { event, setCookie } = loginEvent(user.username, password);

  await expect(actions.default(event)).rejects.toMatchObject({
    status: 302,
    location: "/account/password",
  });
  const [name, token] = setCookie.mock.calls[0] ?? [];
  expect(name).toBe(SESSION_COOKIE);
  expect(resolveSession(token ?? "")?.user).toEqual(user);
  expect(getDb().query("SELECT id FROM auth_login_attempts").all()).toEqual(previousAttempts);
  expect(getDb().query("SELECT actor_user_id, action FROM audit_events").all()).toEqual([
    { actor_user_id: user.id, action: "auth.login.succeeded" },
  ]);
});
