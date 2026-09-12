import { describe, expect, test } from "bun:test";

import {
  AuthError,
  CODEX_CLIENT_ID,
  DEVICE_REDIRECT_URI,
  decodeJwtPayload,
  exchangeAuthorizationCode,
  isAccessTokenFresh,
  parsePastedTokens,
  readAccessTokenExpiry,
  readAuthError,
  readClaims,
  refreshTokenSet,
} from "./oauth";

/** Builds an unsigned JWT with the given payload, since only the payload is read. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256" })}.${encode(payload)}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("readClaims", () => {
  test("reads account fields from the nested auth object", () => {
    const claims = readClaims(
      jwt({
        email: "person@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "account-1",
          chatgpt_plan_type: "plus",
          chatgpt_user_id: "user-1",
        },
      }),
    );
    expect(claims).toEqual({ email: "person@example.com", planType: "plus", accountId: "account-1", userId: "user-1" });
  });

  test("falls back to auth.user_id and profile.email", () => {
    const claims = readClaims(
      jwt({ profile: { email: "profile@example.com" }, "https://api.openai.com/auth": { user_id: "user-2" } }),
    );
    expect(claims.email).toBe("profile@example.com");
    expect(claims.userId).toBe("user-2");
    expect(claims.accountId).toBeNull();
  });

  test("reports non-string claims as absent", () => {
    const claims = readClaims(jwt({ email: 42, "https://api.openai.com/auth": { chatgpt_plan_type: null } }));
    expect(claims).toEqual({ email: null, planType: null, accountId: null, userId: null });
  });

  test("rejects a malformed token", () => {
    expect(() => decodeJwtPayload("not-a-jwt")).toThrow(AuthError);
  });
});

describe("access token freshness", () => {
  test("treats a token expiring inside the skew window as stale", () => {
    const now = 1_000_000;
    const token = jwt({ exp: (now + 60_000) / 1000 });
    expect(readAccessTokenExpiry(token)).toBe(now + 60_000);
    expect(isAccessTokenFresh(token, now)).toBe(false);
  });

  test("treats a comfortably valid token as fresh", () => {
    const now = 1_000_000;
    expect(isAccessTokenFresh(jwt({ exp: (now + 30 * 60_000) / 1000 }), now)).toBe(true);
  });

  test("treats a token without an exp claim as stale rather than valid", () => {
    expect(isAccessTokenFresh(jwt({ sub: "someone" }), 1_000_000)).toBe(false);
  });
});

describe("readAuthError", () => {
  test("prefers the server's code and message", async () => {
    const error = await readAuthError(
      jsonResponse({ error: { message: "Device authorization is pending. Please try again.", code: "deviceauth_authorization_pending" } }, 403),
    );
    expect(error.code).toBe("deviceauth_authorization_pending");
    expect(error.message).toBe("Device authorization is pending. Please try again.");
  });

  test("falls back to the status for a non-JSON body", async () => {
    const error = await readAuthError(new Response("gateway blew up", { status: 502 }));
    expect(error.code).toBe("http_502");
    expect(error.message).toContain("502");
  });
});

describe("token endpoint calls", () => {
  test("exchanges a code with the device redirect and the supplied verifier", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return jsonResponse({ id_token: "id", access_token: "access", refresh_token: "refresh" });
    };

    const tokens = await exchangeAuthorizationCode("the-code", "the-verifier", fetchImpl);

    expect(tokens).toEqual({ idToken: "id", accessToken: "access", refreshToken: "refresh" });
    expect(seen!.url).toBe("https://auth.openai.com/oauth/token");
    expect(seen!.init!.method).toBe("POST");
    const body = new URLSearchParams(String(seen!.init!.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("the-verifier");
    expect(body.get("redirect_uri")).toBe(DEVICE_REDIRECT_URI);
    expect(body.get("client_id")).toBe(CODEX_CLIENT_ID);
  });

  test("keeps the previous refresh token when a refresh response omits a new one", async () => {
    const tokens = await refreshTokenSet("original-refresh", async () =>
      jsonResponse({ id_token: "id", access_token: "access" }),
    );
    expect(tokens.refreshToken).toBe("original-refresh");
  });

  test("surfaces the server's error code on a rejected refresh", async () => {
    const attempt = refreshTokenSet("stale", async () =>
      jsonResponse({ error: { message: "Could not validate your token.", code: "refresh_token_expired" } }, 401),
    );
    await expect(attempt).rejects.toThrow(AuthError);
    await expect(attempt).rejects.toHaveProperty("code", "refresh_token_expired");
  });

  test("rejects a response that omits required tokens", async () => {
    await expect(exchangeAuthorizationCode("code", "verifier", async () => jsonResponse({ access_token: "access" }))).rejects.toHaveProperty(
      "code",
      "incomplete_token_response",
    );
  });

  test("succeeds without a refresh token, keeping it null", async () => {
    const tokens = await exchangeAuthorizationCode("code", "verifier", async () =>
      jsonResponse({ id_token: "id", access_token: "access" }),
    );
    expect(tokens).toEqual({ idToken: "id", accessToken: "access", refreshToken: null });
  });
});

describe("parsePastedTokens", () => {
  test("reads a Codex-style auth file with a nested tokens object", () => {
    expect(
      parsePastedTokens(JSON.stringify({ tokens: { id_token: "id", access_token: "access", refresh_token: "refresh" } })),
    ).toEqual({ idToken: "id", accessToken: "access", refreshToken: "refresh" });
  });

  test("reads a bare token object and tolerates camelCase and whitespace", () => {
    expect(parsePastedTokens(`  { "idToken": "  id  ", "accessToken": "access" }  `)).toEqual({
      idToken: "id",
      accessToken: "access",
      refreshToken: null,
    });
  });

  test("works without a refresh token", () => {
    expect(parsePastedTokens(JSON.stringify({ id_token: "id", access_token: "access" }))).toEqual({
      idToken: "id",
      accessToken: "access",
      refreshToken: null,
    });
  });

  test("treats a raw token on its own as the access token", () => {
    expect(parsePastedTokens("  eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjF9.c2ln  ")).toEqual({
      idToken: null,
      accessToken: "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjF9.c2ln",
      refreshToken: null,
    });
  });

  test("rejects empty input, invalid JSON, and JSON without an access token", () => {
    expect(() => parsePastedTokens("   ")).toThrow(expect.objectContaining({ code: "empty_paste" }));
    expect(() => parsePastedTokens("{nope")).toThrow(expect.objectContaining({ code: "malformed_paste" }));
    expect(() => parsePastedTokens(JSON.stringify({ id_token: "id" }))).toThrow(
      expect.objectContaining({ code: "incomplete_paste" }),
    );
  });
});
