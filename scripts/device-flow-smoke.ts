/**
 * Verifies the ChatGPT device sign-in flow against the live auth server.
 *
 * Run with `bun run scripts/device-flow-smoke.ts`. It prints a one-time code and
 * waits for approval, then reports the account the tokens belong to. Tokens are
 * deliberately not printed or saved; this only proves the flow works end to end.
 *
 * A plain script is not subject to CORS, so this checks the protocol rather than
 * the extension's fetch permissions.
 */

import { awaitDeviceAuthorization, requestDeviceAuthorization } from "../src/live/auth/device";
import { DEVICE_VERIFICATION_URL, readClaims } from "../src/live/auth/oauth";

const authorization = await requestDeviceAuthorization();
console.log(`\n1. Open ${DEVICE_VERIFICATION_URL}`);
console.log(`2. Enter this code: ${authorization.userCode}`);
console.log(`\nWaiting for approval (expires ${new Date(authorization.expiresAt).toLocaleTimeString()})…\n`);

const startedAt = Date.now();
const tokens = await awaitDeviceAuthorization(authorization, {
  sleep: async ms => {
    process.stdout.write(".");
    await new Promise(resolve => setTimeout(resolve, ms));
  },
});

const claims = tokens.idToken ? readClaims(tokens.idToken) : null;
console.log(`\n\nSigned in after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`  email:      ${claims?.email ?? "(none)"}`);
console.log(`  plan:       ${claims?.planType ?? "(none)"}`);
console.log(`  account id: ${claims?.accountId ?? "(none)"}`);
console.log(`  user id:    ${claims?.userId ?? "(none)"}`);
console.log(`  tokens:     access ${tokens.accessToken.length}B, refresh ${tokens.refreshToken ? `${tokens.refreshToken.length}B` : "(none)"}`);
