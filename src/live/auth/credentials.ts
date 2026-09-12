/**
 * Credential storage and access-token freshness.
 *
 * Tokens live in `chrome.storage.local`, which is extension-private. The service
 * worker can be suspended at any time, so nothing here is cached in module state.
 */

import {
  AuthError,
  type FetchLike,
  type TokenSet,
  isAccessTokenFresh,
  readClaims,
  refreshTokenSet,
} from "./oauth";

const STORAGE_KEY = "chatgpt-credentials";

export type Credentials = TokenSet & {
  accountId: string | null;
  email: string | null;
  planType: string | null;
};

/** Refresh failures that cannot be retried; the stored credentials are unusable. */
const FATAL_REFRESH_CODES = ["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"];

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function readCredentials(): Promise<Credentials | null> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as Record<string, unknown> | undefined;
  const idToken = asString(stored?.idToken);
  const accessToken = asString(stored?.accessToken);
  const refreshToken = asString(stored?.refreshToken);
  if (!idToken || !accessToken || !refreshToken) return null;
  return {
    idToken,
    accessToken,
    refreshToken,
    accountId: asString(stored?.accountId),
    email: asString(stored?.email),
    planType: asString(stored?.planType),
  };
}

/** Stores a token set and derives the display claims from its id token. */
export async function saveCredentials(tokens: TokenSet): Promise<Credentials> {
  const claims = readClaims(tokens.idToken);
  const credentials: Credentials = {
    ...tokens,
    accountId: claims.accountId,
    email: claims.email,
    planType: claims.planType,
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: credentials });
  return credentials;
}

export async function clearCredentials(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

/** Reads a usable access token, refreshing it first when it is close to expiry. */
export async function getAccessToken(fetchImpl: FetchLike = fetch): Promise<{ accessToken: string; accountId: string | null }> {
  const credentials = await readCredentials();
  if (!credentials) throw new AuthError("Not signed in to ChatGPT.", "not_signed_in");
  if (isAccessTokenFresh(credentials.accessToken)) {
    return { accessToken: credentials.accessToken, accountId: credentials.accountId };
  }

  try {
    const refreshed = await saveCredentials(await refreshTokenSet(credentials.refreshToken, fetchImpl));
    return { accessToken: refreshed.accessToken, accountId: refreshed.accountId };
  } catch (cause) {
    // A rejected refresh token never recovers, so drop it instead of retrying forever.
    if (cause instanceof AuthError && FATAL_REFRESH_CODES.includes(cause.code)) await clearCredentials();
    throw cause;
  }
}
