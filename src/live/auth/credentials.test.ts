import { beforeEach, describe, expect, test } from "bun:test";

import { getAccessToken, readCredentials, saveCredentials } from "./credentials";
import { AuthError } from "./oauth";

/** Builds an unsigned JWT with the given payload, since only the payload is read. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256" })}.${encode(payload)}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const store: Record<string, unknown> = {};

function installChromeStub() {
  (globalThis as unknown as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        },
        remove: async (key: string) => {
          delete store[key];
        },
      },
    },
  };
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  installChromeStub();
});

function idToken(): string {
  return jwt({
    email: "person@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-1",
      chatgpt_plan_type: "plus",
      chatgpt_user_id: "user-1",
    },
  });
}

describe("credentials without a refresh token", () => {
  test("readCredentials keeps access-only credentials instead of dropping them", async () => {
    store["chatgpt-credentials"] = { accessToken: "access" };
    const credentials = await readCredentials();
    expect(credentials).toMatchObject({ accessToken: "access", idToken: null, refreshToken: null });
  });

  test("readCredentials still returns null with no access token", async () => {
    expect(await readCredentials()).toBeNull();
    store["chatgpt-credentials"] = { idToken: "id", refreshToken: "refresh" };
    expect(await readCredentials()).toBeNull();
  });

  test("saveCredentials stores pasted tokens with no id or refresh token", async () => {
    const credentials = await saveCredentials({ idToken: null, accessToken: "access", refreshToken: null });
    expect(credentials).toMatchObject({ accessToken: "access", email: null, accountId: null, planType: null });
    expect(await readCredentials()).toMatchObject({ accessToken: "access", refreshToken: null });
  });

  test("getAccessToken uses a fresh access token without touching the network", async () => {
    const accessToken = jwt({ exp: Date.now() / 1000 + 3600 });
    await saveCredentials({ idToken: idToken(), accessToken, refreshToken: null });
    let called = false;
    const result = await getAccessToken(async () => {
      called = true;
      return jsonResponse({});
    });
    expect(result.accessToken).toBe(accessToken);
    expect(result.accountId).toBe("account-1");
    expect(called).toBe(false);
  });

  test("getAccessToken asks for fresh tokens when a refresh-less token expires", async () => {
    const accessToken = jwt({ exp: Date.now() / 1000 - 3600 });
    await saveCredentials({ idToken: idToken(), accessToken, refreshToken: null });
    const attempt = getAccessToken(async () => jsonResponse({}));
    await expect(attempt).rejects.toThrow(AuthError);
    await expect(attempt).rejects.toHaveProperty("code", "token_expired_no_refresh");
  });

  test("getAccessToken still refreshes when a refresh token exists", async () => {
    const stale = jwt({ exp: Date.now() / 1000 - 3600 });
    const fresh = jwt({ exp: Date.now() / 1000 + 3600 });
    const id = idToken();
    await saveCredentials({ idToken: id, accessToken: stale, refreshToken: "refresh" });
    const result = await getAccessToken(async () =>
      jsonResponse({ id_token: id, access_token: fresh, refresh_token: "refresh-2" }),
    );
    expect(result.accessToken).toBe(fresh);
    expect((await readCredentials())?.refreshToken).toBe("refresh-2");
  });
});
