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

### Browser-agent roadmap

Implemented model tools are: inspection, visible-tab capture, dynamic waiting, bounded repetitive automation, and direct tab actions. The remaining capabilities are document download/parse/upload, full-page capture, open Shadow DOM and same-origin iframe traversal, cookie-banner guidance, structured extraction, and cross-tab workflows. Full Chrome Debugger accessibility/network inspection is intentionally deferred because it carries substantially broader page-debugging access than the current tools.

## ChatGPT sign-in

The settings page signs in to ChatGPT with a device code, so VoiceAgent needs no API key. Open settings, choose **Sign in with ChatGPT**, and a sign-in page opens with a one-time code shown in the panel. Approving it stores the tokens in `chrome.storage.local` and the panel switches to the signed-in account.

This uses OpenAI's device authorization flow, which exists for clients that cannot receive a browser redirect. The alternative for third-party clients would be a localhost callback, which an extension cannot host. The manifest's broad host access includes `auth.openai.com`; the `storage` permission supports token persistence.

Sign-in and refresh live in `src/live/auth/`. The access token is refreshed shortly before it expires. Because the extension drives Codex's public OAuth client from outside Codex, voice sessions bill to the signed-in account and count against its concurrent-session limit.

## OpenRouter engine

The settings page also offers a second engine that runs on your own OpenRouter key, for accounts that cannot use GPT-Live. The two are different engines, not two routes to one: GPT-Live is a single speech-to-speech session, while this one is a chain this code owns, `speech-to-text -> reasoning -> text-to-speech`. That adds latency and puts voice-activity detection on the extension, but every stage is swappable.

Defaults are `deepseek/deepseek-v4.1-flash` for reasoning, `x-ai/grok-stt-1.0` for listening, and `x-ai/grok-voice-tts-1.0` for speaking. Any model in those three categories can be chosen instead, and voices are listed from the catalog, so switching the speech model selects one of its own voices rather than carrying over an invalid one.

Two details worth knowing before changing this code. The catalog at `/api/v1/models` reports 445 models and no audio models at all; speech and transcription models appear only through `?output_modalities=speech` and `?output_modalities=transcription`, which is why `src/live/openrouter/catalog.ts` always uses the filtered endpoints. And OpenRouter answers a `chrome-extension://` preflight with `access-control-allow-origin: *`, so the extension calls it directly with no proxy.

The key is entered on the settings page and stored in `chrome.storage.local`. It is never written to source, logged, or committed. Rotate any key that has been pasted into a chat or a file. `OPENROUTER_API_KEY=... bun run scripts/openrouter-smoke.ts` walks all three stages against the live API without a microphone.

## Voice sessions

**Start voice session** in the popup opens the microphone and runs the loop: detect speech, transcribe it, let the model decide whether to use a browser tool, then speak the reply. **Stop voice session** closes the microphone. The popup shows the live state, the last thing it heard, and the last reply.

Microphone capture and playback live in an offscreen document, because an MV3 service worker cannot call `getUserMedia`. That document stays mechanical: it reports speech boundaries and plays audio, and owns no conversation logic. The worker decides what any of it means.

Turn-taking is an explicit state machine in `src/live/voice/conversation.ts`, kept pure so it can be tested without a microphone: `listening -> capturing -> transcribing -> thinking -> speaking -> listening`. Speaking over the agent counts as a barge-in, which cuts playback, cancels the turn in flight, and starts listening again without releasing the microphone. A late reply from a cancelled turn is discarded rather than spoken.

Speech detection in `src/live/voice/vad.ts` is energy-based with two thresholds, so speech has to be loud to start an utterance but only needs to stay above a lower bar to continue. A pause mid-sentence therefore does not split one sentence into two turns. It is not a learned VAD, so steady background noise needs its thresholds raised.

The agent turn in `src/live/voice/turn.ts` runs a bounded tool loop over the tools in `src/background/tab-tools.ts`. A tool failure is reported back to the model rather than ending the turn, and the loop stops after `DEFAULT_MAX_TOOL_STEPS` rounds so a model that keeps calling tools cannot spend the user's balance indefinitely.

## Responsibilities

- **akemmanuel** — Builds the tool that lets the agent run arbitrary sandboxed JavaScript.
- **carlosmintfan** — Builds the connection to ChatGPT for using GPT Live.
- **Pascal-Thommen** — Builds the UI and the connection to the browser tabs.

## Scope

The popup exposes tab tools, voice controls, and opens settings. The settings page signs in to ChatGPT, stores those tokens, and holds OpenRouter settings. The OpenRouter engine can hold a spoken conversation; the ChatGPT engine still cannot, and says so rather than failing silently when selected.

The extension requests `tabs`, `scripting`, and `storage`, with persistent `<all_urls>` host access for browser tools and network requests, and `offscreen` for microphone capture and playback. This includes both engine hosts. Broad host access does not bypass browser security restrictions or change the privileged pages' content security policy. There are no content scripts. Register future worker listeners at module scope; MV3 workers can stop when idle, so globals are not durable storage.

## Verification

The initial build loaded in Chromium. Both pages passed axe with zero violations, and the settings API resolved successfully. The popup was visually checked. Settings-page screenshots were blank or timed out, so its visual review remains incomplete. Edge has not been tested.

The device sign-in flow was verified against the live auth server with `bun run scripts/device-flow-smoke.ts`, which completed a real sign-in and read the account id, user id, email, and plan type from the returned id token. The auth endpoints send `access-control-allow-origin: *`, so extension fetch needs no `declarativeNetRequest` rule. The account panel itself has not been exercised in a loaded extension yet, and no voice session has been opened.

The OpenRouter model catalog was checked against the live API: 18 text-to-speech models, 21 speech-to-text models, and the deepseek reasoning default are all present, and the audio endpoints allow a `chrome-extension://` origin. The client is covered by tests against fixtures rather than live calls, so `scripts/openrouter-smoke.ts` still has to be run once with a funded key to confirm the real request shapes.

The voice loop's logic is covered by 25 unit tests: detector thresholds and hysteresis, every state transition including barge-in and late replies, the tool loop and its step limit, and the audio helpers.

The whole loop was then run end to end without a microphone, using `OPENROUTER_API_KEY=... bun run scripts/voice-loop-smoke.ts`. That harness replaces the microphone with a TTS to STT round trip and stubs only the browser tools, so the catalog, both audio endpoints, and the real agent loop all execute. On this machine: the detector followed a synthetic envelope exactly (`speech-end@1200ms` for a 1.2s tone), the transcribed question came back with 6 of 6 key words, the model called `inspect-active-tab` and summarised the fixture correctly, and `ffprobe` confirmed both synthesized files are valid mp3.

The same run exposed the open problem. Per-turn latency was 0.7s to transcribe, 5.1s to answer, and 2.6s to synthesize, and the spoken reply ran **15.4 seconds**. A voice assistant needs to start speaking within about a second and finish quickly, so the reply length and the reasoning model choice both need work before this feels conversational. Speech recognition, synthesis and tool calling are all confirmed working; the pacing is not.

Microphone permission, MediaRecorder's real output format, and playback still have never executed outside a test double, because the harness deliberately bypasses them.

## License

MIT No Attribution. See [LICENSE](LICENSE).
