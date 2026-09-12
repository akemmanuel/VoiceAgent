# GPT-Live connection (carlosmintfan)

## Scope

Connect the extension to ChatGPT's GPT-Live voice model using the user's existing
ChatGPT subscription login. No OpenAI API key, no project key, no backend server.

This module owns the OAuth token lifecycle, session negotiation, the WebRTC audio
transport, the event channel, and the delegation contract that the agent consumes.
It does not own the sandboxed JavaScript tool (akemmanuel) or the browser tab layer
and UI (Pascal-Thommen); it only defines the events those modules receive.

## What the Codex client actually does

Verified against `openai/codex` at `ee6814b` (`codex-rs/`). Codex already ships
GPT-Live voice, so the wire protocol is observable rather than guessed.

### OAuth (subscription auth, not an API key)

- Issuer `https://auth.openai.com`, authorize at `/oauth/authorize`, tokens at
  `/oauth/token` (`login/src/server.rs`).
- Public client id `app_EMoamEEZ73f0CkXaXp7hrann`, PKCE `S256`
  (`login/src/auth/manager.rs`).
- Scope `openid profile email offline_access api.connectors.read api.connectors.invoke`,
  plus `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, and an
  `originator` parameter.
- Loopback redirect `http://localhost:1455/auth/callback`.
- Refresh: `POST https://auth.openai.com/oauth/token` with `grant_type=refresh_token`,
  `client_id`, `refresh_token`.
- On-disk credentials live in `~/.codex/auth.json` as
  `tokens.{id_token, access_token, refresh_token, account_id}`
  (`login/src/token_data.rs`).

### Device authorization (the flow to use)

Codex also implements a device-authorization flow for environments that cannot
receive a loopback redirect (`login/src/device_code_auth.rs`). It never contacts a
localhost listener, so it works unchanged from an extension:

1. `POST https://auth.openai.com/api/accounts/deviceauth/usercode` with
   `{ client_id }` returns `{ device_auth_id, user_code, interval }`. The interval
   arrives as a string.
2. Open `https://auth.openai.com/codex/device` and show the user `user_code`. It
   expires in 15 minutes.
3. Poll `POST https://auth.openai.com/api/accounts/deviceauth/token` with
   `{ device_auth_id, user_code }`. `403` and `404` mean keep waiting; `200` returns
   `{ authorization_code, code_challenge, code_verifier }`, where the server
   supplies the PKCE pair.
4. Exchange the code at `POST https://auth.openai.com/oauth/token` as
   `application/x-www-form-urlencoded` with `grant_type=authorization_code`,
   `code`, `client_id`, `code_verifier`, and
   `redirect_uri=https://auth.openai.com/deviceauth/callback`. That redirect belongs
   to the auth server and is never visited by us.
5. The response is `{ id_token, access_token, refresh_token }`.

This is the flow OpenAI provides for headless clients, so it stays inside the
supported path rather than misusing a loopback redirect for a client that was not
registered for it. Device auth is feature-gated: a `404` on step 1 means it is
disabled for that server or client.

### Voice session

- `POST https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`
  (`codex-api/src/endpoint/realtime_call.rs`).
- Request body is JSON `{ sdp, session }`. Codex strips `session.id` before sending.
- Response body is the SDP answer; the `Location` header carries the call id.
- Session object: `model: "gpt-live-1-codex"`, `instructions`,
  `audio.output.voice`, and `delegation: { type: "client" }`
  (`core/src/realtime_conversation.rs`, `methods_common.rs`).
- WebRTC: the client creates the offer, adds a microphone audio track, and opens an
  ordered data channel named `oai-events` (`voice-host/src/transport.rs`).
- Backend requests are authorized with `Authorization: Bearer <access_token>` and
  `chatgpt-account-id: <account_id>`.

`delegation: { type: "client" }` is the integration point: the model asks our
extension to do the backend work instead of OpenAI running a Responses model. That
makes the browser-control agent a first-class participant in the voice session.

## Structure

```text
src/live/
  auth/provider.ts     AuthProvider interface; the only thing callers import
  auth/codex-oauth.ts  Token refresh, expiry, JWT claim parsing
  auth/import.ts       Validate and store an imported ~/.codex/auth.json
  session/negotiate.ts SDP offer/answer against the ChatGPT backend
  session/events.ts    oai-events decode into typed events
  offscreen/audio.ts   RTCPeerConnection, microphone track, playback
  state.ts             idle -> connecting -> live -> closing state machine
src/background/live.ts Session lifecycle and message routing
```

The audio session must run in an offscreen document: MV3 service workers cannot call
`getUserMedia`, and the session must survive the popup closing. The service worker
orchestrates; the offscreen document owns media and the peer connection.

Manifest additions: `offscreen`, `storage`, `identity` permissions and host
permissions for `https://chatgpt.com/*` and `https://auth.openai.com/*`. Host
permissions are what allow the extension to read the `Location` response header
cross-origin.

## Behavior

Starting a session refreshes the access token if it is near expiry, opens the
offscreen document, negotiates the call, and moves to `live` on `session.started`.
Closing the session tears down the peer connection and the offscreen document.
Failures surface as a typed error with a retry action; no partial state is left
behind.

Delegation events are forwarded to the agent layer as requests with an id, and the
result is posted back on the same `oai-events` channel. Backend work continues when
the user interrupts speech, so the agent layer must keep its own task state.

## Decisions

### Token acquisition: device authorization, with fallbacks

A browser extension cannot complete Codex's interactive browser login: the client
id is registered for `http://localhost:1455/auth/callback`, while
`chrome.identity.launchWebAuthFlow` can only resolve on
`https://<extension-id>.chromiumapp.org/`.

Use device authorization. It needs no localhost listener, no companion process and
no copy-paste, and the user sees one short code on a real sign-in page instead of a
connection error. The remaining fallbacks, in order:

- **Manual redirect paste.** Open the authorize URL in a tab; the browser fails to
  reach port 1455 and shows `ERR_CONNECTION_REFUSED`, but the address bar still holds
  `http://localhost:1455/auth/callback?code=...&state=...`. The options page accepts
  that pasted URL, checks `state`, and exchanges the code using the `code_verifier`
  it generated at the start. Workable, but it asks the user to ignore a scary error
  page and to move fast, because authorization codes are short-lived and single-use.
- **Import `~/.codex/auth.json`.** The user runs `codex login` once and imports the
  file. The extension keeps the refresh token in `chrome.storage.local` and refreshes
  itself. Fine as a developer path; it makes the extension a passenger on another
  tool's login.
- **Local companion.** A loopback process owns login and tokens. Only worth it if
  neither above survives testing, and it is a second install.

`AuthProvider` hides the choice so the others can be swapped in without touching
session or audio code. No native component is otherwise required: microphone
capture, WebRTC and playback all run in the extension's offscreen document.

Device auth is the least grey path because OpenAI designed it for clients that
cannot receive a redirect. Even so, it is being driven by a third-party extension
against Codex's client id, which is worth stating plainly in the README.

### Inherited client id needs a decision too

Reusing Codex's public client id from a third-party extension is outside the flow
Codex intends, and voice sessions bill to the user's plan against per-tier
concurrent-session limits. Registering our own OAuth client would be the clean path
if OpenAI grants one. This is a product decision, not a technical blocker, and should
be recorded in the README before release.

## Verification

Unit tests cover request URLs, the session JSON shape, token refresh, and event
decoding, using recorded fixtures rather than live network calls. The negotiation
step is tested against a stub that returns a canned SDP answer and a `Location`
header.

Two spikes, in order, so the cheap one fails first:

1. **Device auth from an extension context.** Confirm the endpoints are reachable
   and that extension fetch is not rejected by CORS or an `Origin` check, then
   confirm the poll returns an authorization code. This costs nothing, needs no
   audio, and decides whether the fallbacks above are needed at all.
2. **Realtime call from a scratch page.** Create a WebRTC offer, post it to the
   `realtime/calls` endpoint with a real access token, and confirm an SDP answer and
   a call id come back. This proves the subscription path works from a browser. It
   uses a real account and microphone and consumes billed session minutes.

### Spike 1 result: passed

The endpoints answer for Codex's client id, and `auth.openai.com` sends
`access-control-allow-origin: *` on the user-code, poll, and token endpoints, with a
preflight that allows `POST` and `content-type`. Extension fetch therefore needs no
`declarativeNetRequest` rule. The poll returns `403` with
`deviceauth_authorization_pending` while waiting, and the interval arrives as a
string of seconds.

`bun run scripts/device-flow-smoke.ts` runs the whole flow against the live server
without loading the extension. It completed a real sign-in and returned a token set
whose id token carried the account id, user id, email, and plan type, which confirms
the nested `https://api.openai.com/auth` claim shape the parser expects. The script
prints claims only, never tokens.

That sign-in reported the `free` plan. GPT-Live is not available on free accounts, so
spike 2 needs a paid plan signed in; otherwise it will fail for billing reasons
rather than protocol ones.
