# VoiceAgent

Manifest V3 browser extension starter for Chrome and Edge. Uses React, TypeScript, Tailwind CSS, shadcn/ui, and Phosphor icons. Bun bundles all code locally.

## Build and load

```bash
bun install
bun run dev
```

`bun run dev` builds the extension and launches a separate Chrome/Edge development profile with `dist/` loaded. Use `bun run open` to reopen the existing build without rebuilding. Set `BROWSER_PATH` if the browser executable is not detected automatically.

To load it manually, run `bun run build`, then:

1. Open `chrome://extensions` or `edge://extensions`.
2. Turn on Developer mode.
3. Click **Load unpacked** and select this project's `dist/` directory.
4. Pin VoiceAgent and click its icon to open its side panel. The browser lets you place the panel on the left or right.
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
  popup/          Popup HTML and React entry point, including voice controls
  options/        Settings HTML and React entry points, plus the engine and account panels
  offscreen/      Audio document: microphone capture, voice detection, playback
  background/     MV3 service worker, tab tools, and voice session orchestration
  live/auth/      ChatGPT sign-in, token storage, and token refresh
  live/openrouter/ Chained engine: model catalog, chat, speech, transcription, settings
  live/voice/     Voice loop: detection, turn-taking, the agent turn, audio helpers
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

VoiceAgent requests persistent access to all ordinary websites through `<all_urls>`, plus `tabs` permission to inspect tab metadata. No popup click is needed to grant temporary access, although users can still restrict site access in browser settings. The **Read active tab** control extracts its visible text and a bounded list of interactive controls, including bounds, visibility, overlay detection, disabled/checked/expanded state, and native dropdown options; **Capture visible tab** returns a PNG screenshot of the visible viewport. The popup also exposes basic click, text-entry, scroll, and visual highlight actions through CSS selectors. The agent tools additionally support waiting for dynamic DOM text or selectors, keyboard input, native dropdown selection, and checkbox/radio selection. A highlight scrolls the target into view, draws an amber outline, can display a short explanation label, and disappears automatically after the agent-provided duration (1–60 seconds; 8 seconds by default). The `request-user-action` tool uses the same visual guidance for final steps, such as sending a message or completing a payment: it highlights and explains the control, but leaves the click to the user. As a fallback, obvious final-action labels are also never clicked automatically. This is useful when the agent teaches a user how to work in apps such as Odoo or Excel Online. The existing tools still target the active tab; explicit tab-ID targeting is not implemented yet. Browser-owned pages (for example `chrome://`) and other protected pages cannot be scripted. Local file access requires enabling the browser's file-URL access setting, and incognito access requires a separate opt-in. Password fields are never filled.

ChatGPT should use these tools through the message types in `src/lib/tab-tools.ts` (`inspect-active-tab`, `capture-active-tab`, `wait-for-active-tab`, `run-automation`, and `act-on-active-tab`), rather than receiving direct browser API access.

For repetitive work, `run-automation` accepts a small declarative program with `click`, `type`, `select`, `check`, `scroll`, `wait`, `read`, and `for-each` steps. It runs only in the active tab, has no network or extension API access, is limited to 25 declared steps, 100 actions, 50 loop items, and 30 seconds, then returns a fresh page snapshot for the agent to verify. Buttons that look like final external actions are skipped rather than clicked.

`parse-csv` reads pasted CSV or TSV text locally with Papa Parse. It preserves all values as text, so identifiers with leading zeroes and currency values are not silently converted. File selection and upload remain separate document tools.

`read-pdf` fetches an http(s) PDF and extracts its text locally with PDF.js (up to 20 MB, 40 pages, and 100,000 characters). `download-file` saves an http(s) URL with a safe relative path such as `Classroom/Math/week-03/worksheet.pdf`; Chrome never overwrites an existing file.

Tab inspection traverses open Shadow DOM trees and emits selectors using `>>>` for shadow boundaries. It also inspects scriptable iframes and returns their `frameId`; pass that frame ID to tab actions, waiting, or automation when a control belongs to an iframe. Closed Shadow DOMs and frames that Chrome does not permit the extension to script remain unavailable.

For general research, `search-web` opens a normal Google results tab instead of calling a hidden search service. The agent can inspect those results, use `list-tabs` to retain the user's original context, and `activate-tab` to return to it after research.

### Browser-agent roadmap

Implemented model tools are: inspection, visible-tab capture, dynamic waiting, bounded repetitive automation, and direct tab actions. The remaining capabilities are document download/parse/upload, full-page capture, open Shadow DOM and same-origin iframe traversal, cookie-banner guidance, structured extraction, and cross-tab workflows. Full Chrome Debugger accessibility/network inspection is intentionally deferred because it carries substantially broader page-debugging access than the current tools.

## ChatGPT sign-in

The settings page signs in to ChatGPT with a device code, so VoiceAgent needs no API key. Open settings, choose **Sign in with ChatGPT**, and a sign-in page opens with a one-time code shown in the panel. Approving it stores the tokens in `chrome.storage.local` and the panel switches to the signed-in account.

No OAuth flow is needed either: the same panel accepts pasted tokens. Paste the tokens object (for example the contents of a Codex `auth.json`) or just the access token itself into **Or paste tokens manually** and save. Only the access token is required — without an id token the account display stays blank, and without a refresh token the session works until the access token expires, then you paste fresh tokens.

This uses OpenAI's device authorization flow, which exists for clients that cannot receive a browser redirect. The alternative for third-party clients would be a localhost callback, which an extension cannot host. The manifest's broad host access includes `auth.openai.com`; the `storage` permission supports token persistence.

Sign-in, pasting (`parsePastedTokens`), and refresh live in `src/live/auth/`. The access token is refreshed shortly before it expires when a refresh token exists; refresh-less credentials are used as-is and report `token_expired_no_refresh` once stale. Because the extension drives Codex's public OAuth client from outside Codex, voice sessions bill to the signed-in account and count against its concurrent-session limit.

## OpenRouter engine

The settings page also offers a second engine that runs on your own OpenRouter key, for accounts that cannot use GPT-Live. The two are different engines, not two routes to one: GPT-Live is a single speech-to-speech session, while this one is a chain this code owns, `speech-to-text -> reasoning -> text-to-speech`. That adds latency and puts voice-activity detection on the extension, but every stage is swappable.

Defaults are `deepseek/deepseek-v4.1-flash` for reasoning, `x-ai/grok-stt-1.0` for listening, and `x-ai/grok-voice-tts-1.0` for speaking. Any model in those three categories can be chosen instead, and voices are listed from the catalog, so switching the speech model selects one of its own voices rather than carrying over an invalid one.

Two details worth knowing before changing this code. The catalog at `/api/v1/models` reports 445 models and no audio models at all; speech and transcription models appear only through `?output_modalities=speech` and `?output_modalities=transcription`, which is why `src/live/openrouter/catalog.ts` always uses the filtered endpoints. And OpenRouter answers a `chrome-extension://` preflight with `access-control-allow-origin: *`, so the extension calls it directly with no proxy.

The key is entered on the settings page and stored in `chrome.storage.local`. It is never written to source, logged, or committed. Rotate any key that has been pasted into a chat or a file. `OPENROUTER_API_KEY=... bun run scripts/openrouter-smoke.ts` walks all three stages against the live API without a microphone.

## Voice sessions

**Start voice session** in the popup opens the microphone and runs the loop: detect speech, transcribe it, let the model decide whether to use a browser tool, then speak the reply. **Stop voice session** closes the microphone. The popup also has a written-message field beside the larger microphone control. With the OpenRouter engine, speech and writing use the same browser-agent loop and one retained conversation history; changing input method never starts a new conversation. The context and the most recent exchange are stored locally by the extension, so they survive a side-panel reload, navigation, and an MV3 worker restart. **New conversation** stops active audio, permanently removes that local context, and starts an empty session. Sending a written message while the microphone is active stops audio capture first, while retaining that history. Typed replies stay written and are not played aloud.

Written browser-agent chat currently requires the OpenRouter engine and its API key. The separate ChatGPT engine is a realtime speech session and does not expose the tool-capable chat API used by the extension, so the popup explains how to switch rather than silently creating a different conversation.

Microphone capture and playback live in an offscreen document, because an MV3 service worker cannot call `getUserMedia`. That document stays mechanical: it reports speech boundaries and plays audio, and owns no conversation logic. The worker decides what any of it means.

Turn-taking is an explicit state machine in `src/live/voice/conversation.ts`, kept pure so it can be tested without a microphone: `listening -> capturing -> transcribing -> thinking -> speaking -> listening`. Speaking over the agent counts as a barge-in, which cuts playback, cancels the turn in flight, and starts listening again without releasing the microphone. A late reply from a cancelled turn is discarded rather than spoken.

Speech detection in `src/live/voice/vad.ts` is energy-based with two thresholds, so speech has to be loud to start an utterance but only needs to stay above a lower bar to continue. A pause mid-sentence therefore does not split one sentence into two turns.

The thresholds are relative to an ambient floor tracked continuously, not fixed levels. Fixed levels cannot work across devices: a laptop microphone with gain applied can idle above the level a quiet headset reaches while someone is talking, which reads as permanent speech. The floor falls quickly toward any quieter frame and rises slowly, so a transient noise does not leave the detector deaf while one long sentence cannot teach it that talking is the baseline. Onset is a multiple of the floor, and the stop level is clamped so it can never exceed the onset.

This follows the silence detector already running in production in `dezarpa/runtime/browser.ts`. The earlier version here had a real bug that only appeared on a real microphone: its onset window accumulated on frames that cleared the stop level rather than the onset, and the counter it did keep was never read. A room whose noise sat between the two levels therefore produced an endless stream of false onsets, each opening a capture nothing could close, which the popup showed as permanently hearing you. An onset now requires `minSpeechMs` of frames above the onset, a stalled onset returns to idle so the floor keeps tracking, and `maxUtteranceMs` cuts a monologue so capture can never be left open.

Two more details matter for correctness rather than tuning. Levels are measured with the frame's mean removed: an analyzer frame rests near 128 rather than 0, and a constant bias of only three counts reads as 0.023 RMS, above a typical onset, so without this a silent microphone with a small offset looks like continuous speech. And the detector is fed nothing while the agent is speaking, plus a short tail, because the agent's own voice reaches the microphone through the speakers and would otherwise interrupt itself in a loop. The popup shows the live level, the tracked floor, and the level speech must reach, which is what tells a muted microphone apart from a noisy room.

Automatic gain control is deliberately disabled on the microphone, because it amplifies exactly the quiet conditions where the floor should read as silence.

The agent turn in `src/live/voice/turn.ts` receives a fresh active-tab snapshot before every OpenRouter request, then runs a bounded tool loop over the tools in `src/background/tab-tools.ts`. This means that a request such as “enable this app in the open Nextcloud administration page” starts with the actual page and its controls, rather than relying on the model to choose an initial read operation. Page text is explicitly treated as untrusted data, never as instructions. Repeated user-authorized work, such as updating all visible apps, should use bounded `run-automation`/`for-each` rather than stopping after one routine click. A tool failure is reported back to the model rather than ending the turn. The loop allows 16 model rounds, enough for ordinary multi-page admin work while still preventing an unlimited spend.

## Responsibilities

- **akemmanuel** — Builds the tool that lets the agent run arbitrary sandboxed JavaScript.
- **carlosmintfan** — Builds the connection to ChatGPT for using GPT Live.
- **Pascal-Thommen** — Builds the UI and the connection to the browser tabs.

## Scope

VoiceAgent opens as a browser side panel rather than a transient toolbar popup. The panel stays open while normal webpages reload and while the user moves between tabs, so it is the persistent surface for tab tools, voice controls, written chat, and settings. The browser owns its left/right placement and the user may close it at any time. The settings page signs in to ChatGPT, stores those tokens, and holds OpenRouter settings. The OpenRouter engine can hold a spoken conversation; the ChatGPT engine still cannot, and says so rather than failing silently when selected.

The extension requests `tabs`, `scripting`, and `storage`, with persistent `<all_urls>` host access for browser tools and network requests, and `offscreen` for microphone capture and playback. This includes both engine hosts. Broad host access does not bypass browser security restrictions or change the privileged pages' content security policy. There are no content scripts. Register future worker listeners at module scope; MV3 workers can stop when idle, so globals are not durable storage.

## Verification

The initial build loaded in Chromium. Both pages passed axe with zero violations, and the settings API resolved successfully. The popup was visually checked. Settings-page screenshots were blank or timed out, so its visual review remains incomplete. Edge has not been tested.

The device sign-in flow was verified against the live auth server with `bun run scripts/device-flow-smoke.ts`, which completed a real sign-in and read the account id, user id, email, and plan type from the returned id token. The auth endpoints send `access-control-allow-origin: *`, so extension fetch needs no `declarativeNetRequest` rule. The account panel itself has not been exercised in a loaded extension yet, and no voice session has been opened.

The OpenRouter model catalog was checked against the live API: 18 text-to-speech models, 21 speech-to-text models, and the deepseek reasoning default are all present, and the audio endpoints allow a `chrome-extension://` origin. The client is covered by tests against fixtures rather than live calls, so `scripts/openrouter-smoke.ts` still has to be run once with a funded key to confirm the real request shapes.

The voice loop's logic is covered by 25 unit tests: detector thresholds and hysteresis, every state transition including barge-in and late replies, the tool loop and its step limit, and the audio helpers.

The whole loop was then run end to end without a microphone, using `OPENROUTER_API_KEY=... bun run scripts/voice-loop-smoke.ts`. That harness replaces the microphone with a TTS to STT round trip and stubs only the browser tools, so the catalog, both audio endpoints, and the real agent loop all execute. On this machine: the detector followed a synthetic envelope exactly (`speech-end@1200ms` for a 1.2s tone), the transcribed question came back with 6 of 6 key words, the model called `inspect-active-tab` and summarised the fixture correctly, and `ffprobe` confirmed both synthesized files are valid mp3.

The same run exposed the open problem. Per-turn latency was 0.7s to transcribe, 5.1s to answer, and 2.6s to synthesize, and the spoken reply ran **15.4 seconds**. A voice assistant needs to start speaking within about a second, so the reply length and the model choice still need work before this feels conversational. Speech recognition, synthesis and tool calling are all confirmed working; the pacing is not.

### Where the latency actually is

Measured separately against the live API, because the first reading blamed the wrong stage:

| Measurement | Cold connection | Warm connection |
| --- | --- | --- |
| TTS, first byte | 5.8s | **0.65s** |
| TTS, long text (608 chars) | — | 0.65s first byte, 5.3s complete |
| Chat, first token with `stream: true` | 26.8s | **0.72s** |
| Chat, complete bounded reply | — | 5.3s |

Two conclusions that change the design. First, the ~5.8s that appears on every audio request is a **one-time cold-connection cost**, not synthesis: a second request on the same connection takes 0.65s. It is already paid by the catalog fetch at session start, and a warm-up request would guarantee it. Second, the audio body arrives progressively — first byte at 0.65s against a 5.3s total — so TTS is streamable, and `stream: true` is accepted on the speech endpoint too.

The remaining problem is not the transport. Of 119 streamed deltas in a bounded reply, **114 were reasoning tokens and 5 were content**. The answer only begins around 4.5s in because the model thinks first. Streaming cannot fix that; the reasoning settings or the model choice have to. PCM is the right format for playback because it can be scheduled without frame alignment, unlike mp3.

### Reasoning off, and why it is the default

Sending `reasoning: { enabled: false }` removes the thinking pause, and the settings page exposes it as **Answer immediately**, on by default. Measured on one warm connection, four consecutive replies:

| | First speakable word | Complete | Reasoning deltas |
| --- | --- | --- | --- |
| default | 1.09s | 1.27s | 17 |
| reasoning off | 0.86s | 1.59s | 0 |
| default again | **8.22s** | 8.29s | 38 |
| reasoning off again | **0.77s** | **1.09s** | 0 |

The mean improves, but the variance is the real win. Reasoning decides per turn how long to think, so the same question can answer in 1.3s or hang for 8.3s, and a user hears that as a fault. With it off, every measured turn began speaking inside a second. End to end, an agent turn that calls a tool fell from 5.1s to 3.4s, which is two model round-trips.

The cost is real reasoning quality, so the setting stays available: leave it on for conversation, turn it off when a question deserves thinking time.

Microphone permission, MediaRecorder's real output format, and playback still have never executed outside a test double, because the harness deliberately bypasses them.

## License

MIT No Attribution. See [LICENSE](LICENSE).
