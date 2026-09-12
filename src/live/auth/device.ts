/**
 * Device authorization flow.
 *
 * This is the flow OpenAI provides for clients that cannot receive a redirect, so
 * it needs no localhost listener: the user types a short code on a real sign-in
 * page, and the auth server hands back an authorization code together with the
 * PKCE verifier that belongs to it.
 */

import {
  AUTH_ISSUER,
  AuthError,
  CODEX_CLIENT_ID,
  type FetchLike,
  type TokenSet,
  exchangeAuthorizationCode,
  readAuthError,
} from "./oauth";

const USER_CODE_ENDPOINT = `${AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_ENDPOINT = `${AUTH_ISSUER}/api/accounts/deviceauth/token`;

const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 1_000;

/** The server expires device codes after 15 minutes. */
const MAX_WAIT_MS = 15 * 60_000;

/**
 * Codes that mean the attempt is over rather than still pending. Codex polls on any
 * 403 or 404, which is why the deadline below is the real backstop; this list only
 * avoids spinning for fifteen minutes after the user cancels.
 */
const TERMINAL_CODES = /denied|expired|consumed|not_found|invalid/i;

export type DeviceAuthorization = {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
};

export type DeviceFlowOptions = {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The server sends the polling interval as a string of seconds. */
function parseInterval(value: unknown): number {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, seconds * 1000);
}

function parseExpiry(value: unknown, now: number): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return now + MAX_WAIT_MS;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AuthError("Sign-in cancelled.", "cancelled"));
      },
      { once: true },
    );
  });
}

/** Requests a user code. A 404 means device auth is disabled for this client or server. */
export async function requestDeviceAuthorization(fetchImpl: FetchLike = fetch): Promise<DeviceAuthorization> {
  const response = await fetchImpl(USER_CODE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new AuthError(
        "Device sign-in is not available for this account. Use the manual sign-in fallback instead.",
        "device_auth_unavailable",
      );
    }
    throw await readAuthError(response);
  }

  const body = (await response.json()) as {
    device_auth_id?: unknown;
    user_code?: unknown;
    interval?: unknown;
    expires_at?: unknown;
  };
  const deviceAuthId = asString(body.device_auth_id);
  const userCode = asString(body.user_code);
  if (!deviceAuthId || !userCode) {
    throw new AuthError("The sign-in server returned an incomplete device code.", "malformed_device_code");
  }
  return {
    deviceAuthId,
    userCode,
    intervalMs: parseInterval(body.interval),
    expiresAt: parseExpiry(body.expires_at, Date.now()),
  };
}

/**
 * Polls until the user approves the code, then exchanges it for tokens. Resolves
 * with a token set; the caller persists it.
 */
export async function awaitDeviceAuthorization(
  device: DeviceAuthorization,
  options: DeviceFlowOptions = {},
): Promise<TokenSet> {
  const { fetchImpl = fetch, signal, now = Date.now, sleep = defaultSleep } = options;
  const deadline = Math.min(device.expiresAt, now() + MAX_WAIT_MS);

  for (;;) {
    if (signal?.aborted) throw new AuthError("Sign-in cancelled.", "cancelled");

    const response = await fetchImpl(DEVICE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
    });

    if (response.ok) {
      const body = (await response.json()) as { authorization_code?: unknown; code_verifier?: unknown };
      const code = asString(body.authorization_code);
      const codeVerifier = asString(body.code_verifier);
      if (!code || !codeVerifier) {
        throw new AuthError("The sign-in server returned an incomplete authorization.", "malformed_authorization");
      }
      return exchangeAuthorizationCode(code, codeVerifier, fetchImpl);
    }

    // 403 and 404 both mean "not approved yet" while the code is still alive.
    if (response.status !== 403 && response.status !== 404) throw await readAuthError(response);
    const error = await readAuthError(response);
    if (TERMINAL_CODES.test(error.code)) throw error;

    if (now() + device.intervalMs > deadline) {
      throw new AuthError("The sign-in code expired. Start again to get a new one.", "device_code_expired");
    }
    await sleep(device.intervalMs, signal);
  }
}
