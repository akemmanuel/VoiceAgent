import { describe, expect, test } from "bun:test";

import { awaitDeviceAuthorization, requestDeviceAuthorization, type DeviceAuthorization } from "./device";
import { AuthError, CODEX_CLIENT_ID, DEVICE_REDIRECT_URI } from "./oauth";

const USERS_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function pending(): Response {
  return jsonResponse({ error: { message: "Device authorization is pending. Please try again.", code: "deviceauth_authorization_pending" } }, 403);
}

/** A device code that stays valid for the whole test, plus a sleep that never really waits. */
function device(overrides: Partial<DeviceAuthorization> = {}): DeviceAuthorization {
  return { deviceAuthId: "deviceauth_1", userCode: "9C2R-GOT0M", intervalMs: 5_000, expiresAt: 1_000_000 + 15 * 60_000, ...overrides };
}

describe("requestDeviceAuthorization", () => {
  test("parses the string interval and the ISO expiry the server actually sends", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const authorization = await requestDeviceAuthorization(async (url, init) => {
      seen = { url, init };
      return jsonResponse({
        device_auth_id: "deviceauth_1",
        user_code: "9C2R-GOT0M",
        interval: "5",
        expires_at: "2026-09-12T15:38:15.124871+00:00",
      });
    });

    expect(seen!.url).toBe(USERS_CODE_URL);
    expect(JSON.parse(String(seen!.init!.body))).toEqual({ client_id: CODEX_CLIENT_ID });
    expect(authorization.deviceAuthId).toBe("deviceauth_1");
    expect(authorization.userCode).toBe("9C2R-GOT0M");
    expect(authorization.intervalMs).toBe(5_000);
    expect(authorization.expiresAt).toBe(Date.parse("2026-09-12T15:38:15.124871+00:00"));
  });

  test("substitutes defaults when interval and expiry are missing", async () => {
    const authorization = await requestDeviceAuthorization(async () =>
      jsonResponse({ device_auth_id: "deviceauth_1", user_code: "ABC" }),
    );
    expect(authorization.intervalMs).toBe(5_000);
    expect(authorization.expiresAt).toBeGreaterThan(Date.now());
  });

  test("reports a disabled device flow distinctly on 404", async () => {
    const request = requestDeviceAuthorization(async () => new Response("not found", { status: 404 }));
    await expect(request).rejects.toHaveProperty("code", "device_auth_unavailable");
  });

  test("rejects an incomplete device code", async () => {
    const request = requestDeviceAuthorization(async () => jsonResponse({ user_code: "ABC" }));
    await expect(request).rejects.toHaveProperty("code", "malformed_device_code");
  });
});

describe("awaitDeviceAuthorization", () => {
  test("polls while pending, then exchanges with the server-supplied verifier", async () => {
    const calls: string[] = [];
    let polls = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url === DEVICE_TOKEN_URL) {
        polls += 1;
        return polls < 3
          ? pending()
          : jsonResponse({ authorization_code: "the-code", code_challenge: "challenge", code_verifier: "server-verifier" });
      }
      if (url === TOKEN_URL) {
        expect(new URLSearchParams(String(init!.body)).get("code_verifier")).toBe("server-verifier");
        expect(new URLSearchParams(String(init!.body)).get("redirect_uri")).toBe(DEVICE_REDIRECT_URI);
        return jsonResponse({ id_token: "id", access_token: "access", refresh_token: "refresh" });
      }
      throw new Error(`unexpected request to ${url}`);
    };

    const tokens = await awaitDeviceAuthorization(device(), {
      fetchImpl,
      now: () => 1_000_000,
      sleep: async () => {},
    });

    expect(polls).toBe(3);
    expect(tokens).toEqual({ idToken: "id", accessToken: "access", refreshToken: "refresh" });
    expect(calls).toEqual([DEVICE_TOKEN_URL, DEVICE_TOKEN_URL, DEVICE_TOKEN_URL, TOKEN_URL]);
  });

  test("keeps polling on a 404 or an unrecognized 403, which is how Codex behaves", async () => {
    let polls = 0;
    const fetchImpl = async (url: string) => {
      if (url !== DEVICE_TOKEN_URL) return jsonResponse({ id_token: "id", access_token: "access", refresh_token: "refresh" });
      polls += 1;
      if (polls === 1) return new Response("not found", { status: 404 });
      if (polls === 2) return jsonResponse({ error: { code: "something_new" } }, 403);
      return jsonResponse({ authorization_code: "c", code_verifier: "v" });
    };

    await awaitDeviceAuthorization(device(), { fetchImpl, now: () => 1_000_000, sleep: async () => {} });
    expect(polls).toBe(3);
  });

  test("stops early when the code is rejected", async () => {
    const fetchImpl = async () =>
      jsonResponse({ error: { message: "Denied.", code: "deviceauth_authorization_denied" } }, 403);
    const attempt = awaitDeviceAuthorization(device(), { fetchImpl, now: () => 1_000_000, sleep: async () => {} });
    await expect(attempt).rejects.toHaveProperty("code", "deviceauth_authorization_denied");
  });

  test("gives up once the code expires instead of polling forever", async () => {
    let polls = 0;
    const fetchImpl = async () => {
      polls += 1;
      return pending();
    };
    const attempt = awaitDeviceAuthorization(device({ expiresAt: 1_000_000 }), {
      fetchImpl,
      now: () => 1_000_000,
      sleep: async () => {},
    });
    await expect(attempt).rejects.toHaveProperty("code", "device_code_expired");
    expect(polls).toBe(1);
  });

  test("reports a cancelled sign-in rather than a request failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const attempt = awaitDeviceAuthorization(device(), { fetchImpl: fetch, signal: controller.signal, sleep: async () => {} });
    await expect(attempt).rejects.toThrow(AuthError);
    await expect(attempt).rejects.toHaveProperty("code", "cancelled");
  });

  test("surfaces a non-pending server failure", async () => {
    const attempt = awaitDeviceAuthorization(device(), {
      fetchImpl: async () => new Response("boom", { status: 500 }),
      now: () => 1_000_000,
      sleep: async () => {},
    });
    await expect(attempt).rejects.toHaveProperty("code", "http_500");
  });
});
