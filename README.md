# VoiceAgent

Manifest V3 browser extension starter for Chrome and Edge. Uses React, TypeScript, Tailwind CSS, shadcn/ui, and Phosphor icons. Bun bundles all code locally.

## Build and load

```bash
bun install
bun run build
```

1. Open `chrome://extensions` or `edge://extensions`.
2. Turn on Developer mode.
3. Click **Load unpacked** and select this project's `dist/` directory.
4. Pin VoiceAgent and click its icon to open the popup.
5. Click **Open settings** to open the options page.

After editing, run `bun run build`, reload the extension on the Extensions page, and reopen the popup or refresh settings. There is no development server or hot reload.

## Checks

```bash
bun run typecheck
bun run test
# Run both:
bun run check
```

`bun run test` builds first, then runs Bun tests against the generated manifest, entry points, HTML asset references, and PNG icon dimensions. Run it rather than bare `bun test` when the build may be stale.

## Structure

```text
src/
  popup/          Popup HTML and React entry point
  options/        Settings HTML and React entry point, plus the ChatGPT account panel
  background/     MV3 service worker
  live/auth/      ChatGPT sign-in, token storage, and token refresh
  components/ui/  shadcn/ui button and separator
  lib/            Shared utilities, including the tab-tool message types
  styles/         Tailwind stylesheet and theme tokens
public/
  manifest.json
  icons/          Phosphor waveform SVG and PNG variants
scripts/
  build.ts
  build.test.ts
```

`components.json` configures shadcn/ui. Add components with `bunx shadcn@latest add <component>`. Shared utilities live at `@/lib/utils`; keep generated imports pointed there. Use `@phosphor-icons/react` for UI icons.

The build copies HTML templates and public files into `dist/`, bundles JavaScript with Bun, and compiles Tailwind separately. HTML templates reference the resulting JavaScript and CSS files. The build deletes and recreates only `dist/`.

## Browser tab tools

Opening the popup grants VoiceAgent temporary access to the active tab. The **Read active tab** control extracts its visible text and a bounded list of interactive controls; **Capture visible tab** returns a PNG screenshot of the visible viewport. The popup also exposes basic click, text-entry, and scroll actions through CSS selectors. The service worker injects these tools only into the tab the user activates; no sites have permanent host access. Browser-owned pages (for example `chrome://`) cannot be accessed, and password fields are never filled.

ChatGPT should use these tools through the message types in `src/lib/tab-tools.ts` (`inspect-active-tab`, `capture-active-tab`, and `act-on-active-tab`), rather than receiving direct browser API access.

## ChatGPT sign-in

The settings page signs in to ChatGPT with a device code, so VoiceAgent needs no API key. Open settings, choose **Sign in with ChatGPT**, and a sign-in page opens with a one-time code shown in the panel. Approving it stores the tokens in `chrome.storage.local` and the panel switches to the signed-in account.

This uses OpenAI's device authorization flow, which exists for clients that cannot receive a browser redirect. The alternative for third-party clients would be a localhost callback, which an extension cannot host. The only host access the manifest requests is `auth.openai.com`, alongside the `storage` permission.

Sign-in and refresh live in `src/live/auth/`. The access token is refreshed shortly before it expires. Because the extension drives Codex's public OAuth client from outside Codex, voice sessions bill to the signed-in account and count against its concurrent-session limit.

## Responsibilities

- **akemmanuel** — Builds the tool that lets the agent run arbitrary sandboxed JavaScript.
- **carlosmintfan** — Builds the connection to ChatGPT for using GPT Live.
- **Pascal-Thommen** — Builds the UI and the connection to the browser tabs.

## Scope

The popup exposes tab tools and opens settings. The settings page signs in to ChatGPT and stores the resulting tokens; voice preferences and the voice session itself are not implemented yet. The worker holds the tab tools and is an entry point for future live-session work.

There is no voice recording or live audio yet, and no content scripts. The extension requests `activeTab` and `scripting` for the popup's tab tools, and `storage` plus host access to `auth.openai.com` for sign-in. Register future worker listeners at module scope; MV3 workers can stop when idle, so globals are not durable storage.

## Verification

The initial build loaded in Chromium. Both pages passed axe with zero violations, and the settings API resolved successfully. The popup was visually checked. Settings-page screenshots were blank or timed out, so its visual review remains incomplete. Edge has not been tested.

The device sign-in flow was verified against the live auth server with `bun run scripts/device-flow-smoke.ts`, which completed a real sign-in and read the account id, user id, email, and plan type from the returned id token. The auth endpoints send `access-control-allow-origin: *`, so extension fetch needs no `declarativeNetRequest` rule. The account panel itself has not been exercised in a loaded extension yet, and no voice session has been opened.

## License

MIT No Attribution. See [LICENSE](LICENSE).
