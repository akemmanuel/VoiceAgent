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
  options/        Settings HTML and React entry point
  background/     MV3 service worker
  components/ui/  shadcn/ui button and separator
  lib/            Shared class-name utility
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

## Responsibilities

- **akemmanuel** — Builds the tool that lets the agent run arbitrary sandboxed JavaScript.
- **carlosmintfan** — Builds the connection to ChatGPT for using GPT Live.
- **Pascal-Thommen** — Builds the UI and the connection to the browser tabs.

## Scope

The popup opens settings and displays an error if that action fails. The settings page is an empty state, not a working voice configuration form. The worker is an entry point for future event listeners.

No voice recording, content scripts, storage, network calls, or browser permissions are included. Register future worker listeners at module scope; MV3 workers can stop when idle, so globals are not durable storage.

## Verification

The initial build loaded in Chromium. Both pages passed axe with zero violations, and the settings API resolved successfully. The popup was visually checked. Settings-page screenshots were blank or timed out, so its visual review remains incomplete. Edge has not been tested.

## License

MIT No Attribution. See [LICENSE](LICENSE).
