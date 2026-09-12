/**
 * ChatGPT subscription auth: endpoints, JWT claims, and token-endpoint calls.
 *
 * The extension authenticates as Codex's public OAuth client. Public clients hold
 * no secret, so the device flow (or PKCE) is what authorizes a request; there is
 * no API key anywhere in this module.
 */

export const AUTH_ISSUER = "https://auth.openai.com";

/** Codex's public OAuth client id. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Where the user types the device code. */
export const DEVICE_VERIFICATION_URL = `${AUTH_ISSUER}/codex/device`;

/**
 * Device-flow redirect. It belongs to the auth server and is never visited by the
 * client, which is what lets this flow work without a localhost listener.
 */
export const DEVICE_REDIRECT_URI = `${AUTH_ISSUER}/deviceauth/callback`;

const TOKEN_ENDPOINT = `${AUTH_ISSUER}/oauth/token`;

/** Injected so tests and callers can supply their own transport. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type TokenSet = {
  idToken: string;
  accessToken: string;
  refreshToken: string;
};

/**
 * A failed auth request. `code` carries the server's own error code when it sends
 * one, because the status alone cannot distinguish "pending" from "denied" or
 * "expired" once the status is 403.
 */
export class AuthError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/**
 * Reads the auth server's `{ error: { message, code } }` shape. The body carries
 * better detail than the status line, but a non-JSON body is not fatal.
 */
export async function readAuthError(response: Response, fallback?: string): Promise<AuthError> {
  let code = `http_${response.status}`;
  let message = fallback ?? `Sign-in failed (${response.status}).`;
  try {
    const body = (await response.json()) as { error?: { message?: unknown; code?: unknown } };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // Keep the status-based message.
  }
  return new AuthError(message, code);
}

type AuthObject = {
  chatgpt_plan_type?: unknown;
  chatgpt_user_id?: unknown;
  user_id?: unknown;
  chatgpt_account_id?: unknown;
};

type JwtPayload = {
  exp?: unknown;
  email?: unknown;
  profile?: { email?: unknown };
  "https://api.openai.com/auth"?: AuthObject;
};

export type ChatGptClaims = {
  email: string | null;
  planType: string | null;
  /** Sent as `chatgpt-account-id` on ChatGPT backend requests. */
  accountId: string | null;
  userId: string | null;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function decodeJwtPayload(jwt: string): JwtPayload {
  const segment = jwt.split(".")[1];
  if (!segment) throw new AuthError("The sign-in response contained a malformed token.", "malformed_token");
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as JwtPayload;
  } catch {
    throw new AuthError("The sign-in response contained an unreadable token.", "malformed_token");
  }
}

/**
 * Mirrors Codex's claim parsing: the account fields live under the
 * `https://api.openai.com/auth` object rather than at the top level, with
 * `user_id` as a fallback for `chatgpt_user_id` and `profile.email` for `email`.
 */
export function readClaims(idToken: string): ChatGptClaims {
  const payload = decodeJwtPayload(idToken);
  const auth = payload["https://api.openai.com/auth"];
  return {
    email: asString(payload.email) ?? asString(payload.profile?.email),
    planType: asString(auth?.chatgpt_plan_type),
    accountId: asString(auth?.chatgpt_account_id),
    userId: asString(auth?.chatgpt_user_id) ?? asString(auth?.user_id),
  };
}

/** Milliseconds since the epoch, or null when the token carries no numeric `exp`. */
export function readAccessTokenExpiry(accessToken: string): number | null {
  try {
    const exp = decodeJwtPayload(accessToken).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Refresh slightly early so a session never starts with a token that dies mid-request. */
export const REFRESH_SKEW_MS = 5 * 60_000;

export function isAccessTokenFresh(accessToken: string, now: number = Date.now()): boolean {
  const expiry = readAccessTokenExpiry(accessToken);
  return expiry !== null && expiry - REFRESH_SKEW_MS > now;
}

/** `refreshToken` stays nullable because a refresh response may legitimately omit it. */
type TokenResponse = {
  idToken: string;
  accessToken: string;
  refreshToken: string | null;
};

async function postTokenRequest(body: Record<string, string>, fetchImpl: FetchLike): Promise<TokenResponse> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!response.ok) throw await readAuthError(response);
  const tokens = (await response.json()) as {
    id_token?: unknown;
    access_token?: unknown;
    refresh_token?: unknown;
  };
  const idToken = asString(tokens.id_token);
  const accessToken = asString(tokens.access_token);
  if (!idToken || !accessToken) {
    throw new AuthError("The sign-in response did not include usable tokens.", "incomplete_token_response");
  }
  return { idToken, accessToken, refreshToken: asString(tokens.refresh_token) };
}

/** Exchanges the device flow's authorization code, which arrives with its own PKCE verifier. */
export async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenSet> {
  const tokens = await postTokenRequest(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: DEVICE_REDIRECT_URI,
      client_id: CODEX_CLIENT_ID,
      code_verifier: codeVerifier,
    },
    fetchImpl,
  );
  if (!tokens.refreshToken) {
    throw new AuthError("The sign-in response did not include a refresh token.", "incomplete_token_response");
  }
  return { idToken: tokens.idToken, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

/**
 * Refreshes an access token. The server rotates the refresh token, but the previous
 * one is reused if a response omits it rather than failing the whole refresh.
 */
export async function refreshTokenSet(refreshToken: string, fetchImpl: FetchLike = fetch): Promise<TokenSet> {
  const tokens = await postTokenRequest(
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CODEX_CLIENT_ID },
    fetchImpl,
  );
  return {
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? refreshToken,
  };
}
