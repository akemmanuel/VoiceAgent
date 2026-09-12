import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUpRightIcon, GearSixIcon, MicrophoneIcon, MicrophoneSlashIcon, WaveformIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { PageSnapshot, TabAction, TabToolRequest, TabToolResponse } from "@/lib/tab-tools";
import { isActive, type ConversationState } from "@/live/voice/conversation";
import type { VoiceStatus, VoiceStatusMessage } from "@/live/voice/protocol";

const VOICE_LABELS: Record<ConversationState, string> = {
  idle: "Not listening",
  connecting: "Connecting…",
  listening: "Listening…",
  capturing: "Hearing you…",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking",
  failed: "Stopped",
};

async function sendVoice(message: { type: "voice-start" | "voice-stop" | "voice-status" }): Promise<VoiceStatus | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as VoiceStatus;
  } catch {
    return null;
  }
}

async function sendTabTool(request: TabToolRequest): Promise<TabToolResponse> {
  try {
    return await chrome.runtime.sendMessage(request);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "The browser tool is unavailable." };
  }
}

function Popup() {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PageSnapshot | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [selector, setSelector] = useState("");
  const [text, setText] = useState("");
  const [highlightSeconds, setHighlightSeconds] = useState(8);
  const [voice, setVoice] = useState<VoiceStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void sendVoice({ type: "voice-status" }).then(setVoice);
    const listener = (message: unknown) => {
      const update = message as VoiceStatusMessage;
      if (update?.type === "voice-status-changed") setVoice(update.status);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  async function toggleVoice() {
    setBusy(true);
    setError(null);
    try {
      const stopping = voice && isActive(voice.state);
      if (!stopping) {
        const permission = await navigator.permissions.query({ name: "microphone" as PermissionName });
        if (permission.state !== "granted") {
          if (!new URLSearchParams(location.search).has("microphone")) {
            await chrome.tabs.create({ url: chrome.runtime.getURL("popup/index.html?microphone=1") });
            return;
          }
          // Offscreen documents cannot show permission prompts. Request once in
          // this visible extension tab, then let the audio document own capture.
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(track => track.stop());
        }
      }
      const next = await sendVoice({ type: stopping ? "voice-stop" : "voice-start" });
      if (next) setVoice(next);
      else setError("The voice session could not be reached. Try reopening the popup.");
    } catch (cause) {
      setError(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "Microphone access is blocked. Allow the microphone in this tab's site settings, then retry."
        : cause instanceof Error ? cause.message : "The voice session could not start.");
    } finally {
      setBusy(false);
    }
  }

  async function openSettings() {
    setOpening(true);
    setError(null);
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      setError("Settings couldn't open. Try again, or open extension options from your browser's Extensions page.");
    } finally {
      setOpening(false);
    }
  }

  async function inspectActiveTab() {
    setLoadingPage(true);
    setError(null);
    const response = await sendTabTool({ type: "inspect-active-tab" });
    setLoadingPage(false);
    if (response.ok && response.snapshot) setSnapshot(response.snapshot);
    else setError(response.ok ? "No page content was returned." : response.error);
  }

  async function act(action: TabAction) {
    setError(null);
    const response = await sendTabTool({ type: "act-on-active-tab", action });
    if (!response.ok) setError(response.error);
  }

  async function captureActiveTab() {
    setCapturing(true);
    setError(null);
    const response = await sendTabTool({ type: "capture-active-tab" });
    setCapturing(false);
    if (response.ok && response.screenshot) setScreenshot(response.screenshot);
    else setError(response.ok ? "No screenshot was returned." : response.error);
  }

  return (
    <main className="p-6">
      <header className="flex items-center gap-2.5">
        <WaveformIcon size={26} weight="bold" className="text-primary" aria-hidden="true" />
        <h1 className="text-lg font-semibold tracking-tight">VoiceAgent</h1>
      </header>
      {new URLSearchParams(location.search).has("microphone") && <p role="status" className="mt-4 text-sm leading-6">Click Start voice session below, then allow microphone access. Audio is sent to the selected voice provider while the session runs. You can close this tab after connecting.</p>}
      <Separator className="my-6" />
      <section aria-labelledby="starter-title">
        <h2 id="starter-title" className="text-2xl font-semibold tracking-tight">Browser tools</h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Read the current page or test a page action. Access is granted only to the active tab when you open this popup.
        </p>
        <Button className="mt-5 w-full" onClick={inspectActiveTab} disabled={loadingPage}>
          {loadingPage ? "Reading page…" : "Read active tab"}
        </Button>
        <Button variant="secondary" className="mt-2 w-full" onClick={captureActiveTab} disabled={capturing}>
          {capturing ? "Capturing screenshot…" : "Capture visible tab"}
        </Button>
        {snapshot && <div className="mt-4 rounded-md border border-border p-3 text-xs leading-5">
          <p className="font-semibold">{snapshot.title || "Untitled page"}</p>
          <p className="truncate text-muted-foreground">{snapshot.url}</p>
          <p className="mt-2 text-muted-foreground">{snapshot.text.slice(0, 360) || "No visible text"}</p>
          <p className="mt-2 text-muted-foreground">{snapshot.interactiveElements.length} interactive elements found</p>
        </div>}
        {screenshot && <img className="mt-4 max-h-48 w-full rounded-md border border-border object-contain" src={screenshot} alt="Screenshot of the active browser tab" />}
        <div className="mt-4 grid gap-2">
          <input className="h-9 rounded-md border bg-background px-3 text-sm" value={selector} onChange={event => setSelector(event.target.value)} placeholder="CSS selector, e.g. button[type=submit]" aria-label="CSS selector" />
          <input className="h-9 rounded-md border bg-background px-3 text-sm" value={text} onChange={event => setText(event.target.value)} placeholder="Text to enter" aria-label="Text to enter" />
          <input className="h-9 rounded-md border bg-background px-3 text-sm" type="number" min="1" max="60" value={highlightSeconds} onChange={event => setHighlightSeconds(Number(event.target.value))} aria-label="Highlight duration in seconds" title="Highlight duration in seconds" />
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => act({ kind: "click", selector })} disabled={!selector}>Click</Button>
            <Button variant="secondary" onClick={() => act({ kind: "type", selector, text })} disabled={!selector}>Type</Button>
            <Button variant="secondary" onClick={() => act({ kind: "highlight", selector, label: text || undefined, durationSeconds: highlightSeconds })} disabled={!selector}>Highlight</Button>
            <Button variant="secondary" onClick={() => act({ kind: "request-user-action", selector, message: text || "Bitte selbst klicken", durationSeconds: highlightSeconds })} disabled={!selector}>Ask user</Button>
            <Button variant="secondary" onClick={() => act({ kind: "scroll", deltaY: 600 })}>Scroll</Button>
          </div>
        </div>
        <Button className="mt-6 w-full" onClick={toggleVoice} disabled={busy}>
          {voice && isActive(voice.state) ? <MicrophoneSlashIcon aria-hidden="true" /> : <MicrophoneIcon aria-hidden="true" />}
          {busy ? "Working…" : voice && isActive(voice.state) ? "Stop voice session" : "Start voice session"}
        </Button>
        {voice && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {VOICE_LABELS[voice.state]} · {voice.engine === "openrouter" ? "OpenRouter" : "ChatGPT"} engine
          </p>
        )}
        {voice?.transcript && <p className="mt-3 text-xs leading-5"><span className="font-semibold">You:</span> {voice.transcript}</p>}
        {voice?.reply && <p className="mt-1 text-xs leading-5"><span className="font-semibold">Agent:</span> {voice.reply}</p>}
        {voice?.error && <p role="alert" className="mt-3 text-sm leading-5 text-destructive">{voice.error}</p>}
        <Button className="mt-6 w-full" onClick={openSettings} disabled={opening}>
          <GearSixIcon aria-hidden="true" />
          {opening ? "Opening settings…" : "Open settings"}
          <ArrowUpRightIcon className="ml-auto" aria-hidden="true" />
        </Button>
        {error && <p role="alert" className="mt-3 text-sm leading-5 text-destructive">{error}</p>}
      </section>
      <p className="mt-5 text-xs leading-5 text-muted-foreground">The microphone is used only while a voice session is running · Password fields are protected</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Popup /></StrictMode>);
