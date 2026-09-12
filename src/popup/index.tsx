import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { ArrowCounterClockwiseIcon, CaretDownIcon, DownloadSimpleIcon, GearSixIcon, MicrophoneIcon, MicrophoneSlashIcon, PaperPlaneTiltIcon, WaveformIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { PageSnapshot, TabAction, TabToolRequest, TabToolResponse } from "@/lib/tab-tools";
import { isActive, type ConversationState } from "@/live/voice/conversation";
import type { VoiceDebugReport, VoiceRequest, VoiceStatus, VoiceStatusMessage } from "@/live/voice/protocol";

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

async function sendVoice(message: VoiceRequest): Promise<VoiceStatus | null> {
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
  const [writtenMessage, setWrittenMessage] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [resettingConversation, setResettingConversation] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [exportingDebug, setExportingDebug] = useState(false);

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

  async function sendWrittenMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = writtenMessage.trim();
    if (!message) return;

    setSendingMessage(true);
    setError(null);
    try {
      const next = await sendVoice({ type: "text-send", text: message });
      if (next) {
        setVoice(next);
        setWrittenMessage("");
      } else {
        setError("The agent could not be reached. Try reopening the popup.");
      }
    } finally {
      setSendingMessage(false);
    }
  }

  async function startNewConversation() {
    setResettingConversation(true);
    setError(null);
    try {
      const next = await sendVoice({ type: "conversation-reset" });
      if (next) setVoice(next);
      else setError("The conversation could not be reset. Try reopening the side panel.");
    } finally {
      setResettingConversation(false);
    }
  }

  async function downloadDebugReport() {
    setExportingDebug(true);
    setError(null);
    try {
      const report = await chrome.runtime.sendMessage({ type: "voice-debug-report" }) as VoiceDebugReport | { error?: string };
      if ("error" in report) throw new Error(report.error || "Debug report could not be created.");
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `voiceagent-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Debug report could not be downloaded.");
    } finally {
      setExportingDebug(false);
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

  const voiceActive = Boolean(voice && isActive(voice.state));
  const microphoneSetup = new URLSearchParams(location.search).has("microphone");

  return (
    <main className="popup-shell p-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <WaveformIcon size={21} weight="bold" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-base font-semibold tracking-tight">VoiceAgent</h1>
            <p className="text-xs text-muted-foreground">Your browser, voice controlled</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={openSettings} disabled={opening} aria-label="Open settings" title="Open settings">
          <GearSixIcon className={opening ? "animate-spin" : ""} aria-hidden="true" />
        </Button>
      </header>

      {microphoneSetup && (
        <div role="status" className="mt-4 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs leading-5 text-muted-foreground">
          Start the session and allow microphone access. You can close this tab after connecting.
        </div>
      )}

      <section aria-labelledby="voice-title" className="voice-card mt-4 rounded-2xl border border-border/80 bg-background/90 p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <span className={`voice-indicator ${voiceActive ? "voice-indicator-active" : ""}`} aria-hidden="true">
            <span />
          </span>
          <div>
            <h2 id="voice-title" className="text-lg font-semibold tracking-tight">
              {voice ? VOICE_LABELS[voice.state] : "Ready to listen"}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {voice ? `${voice.engine === "openrouter" ? "OpenRouter" : "ChatGPT"} voice engine` : "Start a hands-free browser session"}
            </p>
          </div>
        </div>

        <Button className={`mt-5 h-11 w-full rounded-xl ${voiceActive ? "bg-destructive hover:bg-destructive/90" : ""}`} onClick={toggleVoice} disabled={busy || sendingMessage}>
          {voiceActive ? <MicrophoneSlashIcon aria-hidden="true" /> : <MicrophoneIcon weight="fill" aria-hidden="true" />}
          {busy ? "Working…" : voiceActive ? "Stop voice session" : "Start voice session"}
        </Button>

        <form className="mt-3 flex gap-2" onSubmit={sendWrittenMessage}>
          <input
            className="h-10 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm"
            value={writtenMessage}
            onChange={event => setWrittenMessage(event.target.value)}
            placeholder="Write to the agent"
            aria-label="Write to the agent"
            disabled={busy || sendingMessage}
          />
          <Button type="submit" size="icon" className="size-10 rounded-lg" aria-label="Send message" disabled={!writtenMessage.trim() || busy || sendingMessage}>
            <PaperPlaneTiltIcon aria-hidden="true" />
          </Button>
        </form>
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-[11px] leading-4 text-muted-foreground">Speak or write in the same conversation.</p>
          <Button variant="ghost" size="sm" className="shrink-0" onClick={startNewConversation} disabled={busy || sendingMessage || resettingConversation}>
            <ArrowCounterClockwiseIcon aria-hidden="true" />
            {resettingConversation ? "Resetting…" : "New chat"}
          </Button>
        </div>

        {(voice?.transcript || voice?.reply) && (
          <div className="mt-4 max-h-28 space-y-2 overflow-y-auto rounded-lg bg-secondary/60 p-3 text-xs leading-5">
            {voice.transcript && <p><span className="font-semibold">You:</span> {voice.transcript}</p>}
            {voice.reply && <p><span className="font-semibold">Agent:</span> {voice.reply}</p>}
          </div>
        )}
        {voice?.levels && (
          <p className="mt-2 font-mono text-[10px] leading-4 text-muted-foreground">
            mic {voice.levels.rms.toFixed(4)} · room {voice.levels.floor.toFixed(4)} · needs {voice.levels.onsetRms.toFixed(4)}
          </p>
        )}
        {voice?.activity.length ? (
          <details className="mt-3 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs" open={voice.activity.some(entry => entry.failed)}>
            <summary className="cursor-pointer font-medium">Agent activity ({voice.activity.length})</summary>
            <ol className="mt-2 space-y-2 border-t border-border pt-2 text-muted-foreground">
              {voice.activity.map((entry, index) => (
                <li key={`${entry.tool}-${index}`}>
                  <span className={entry.failed ? "font-medium text-destructive" : "font-medium text-foreground"}>{entry.tool}</span>
                  <span>: {entry.outcome}</span>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
        <Button variant="secondary" size="sm" className="mt-3 w-full" onClick={downloadDebugReport} disabled={exportingDebug}>
          <DownloadSimpleIcon aria-hidden="true" />
          {exportingDebug ? "Preparing debug report…" : "Download debug report"}
        </Button>
        <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">Includes local page and conversation data; review it before sharing.</p>
        {voice?.error && <p role="alert" className="mt-3 text-sm leading-5 text-destructive">{voice.error}</p>}
        {error && <p role="alert" className="mt-3 text-sm leading-5 text-destructive">{error}</p>}
      </section>

      <section className="mt-3 overflow-hidden rounded-xl border border-border/80 bg-background/75">
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium hover:bg-secondary/60"
          onClick={() => setToolsOpen(open => !open)}
          aria-expanded={toolsOpen}
          aria-controls="browser-tools"
        >
          Browser tools
          <CaretDownIcon className={`transition-transform ${toolsOpen ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
        {toolsOpen && (
          <div id="browser-tools" className="border-t border-border px-4 pb-4 pt-3">
            <p className="text-xs leading-5 text-muted-foreground">
              Inspect the active page or test a browser action.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button size="sm" onClick={inspectActiveTab} disabled={loadingPage}>
                {loadingPage ? "Reading…" : "Read active tab"}
              </Button>
              <Button size="sm" variant="secondary" onClick={captureActiveTab} disabled={capturing}>
                {capturing ? "Capturing…" : "Capture tab"}
              </Button>
            </div>
            {snapshot && <div className="mt-3 rounded-md border border-border p-3 text-xs leading-5">
              <p className="font-semibold">{snapshot.title || "Untitled page"}</p>
              <p className="truncate text-muted-foreground">{snapshot.url}</p>
              <p className="mt-2 text-muted-foreground">{snapshot.text.slice(0, 360) || "No visible text"}</p>
              <p className="mt-2 text-muted-foreground">{snapshot.interactiveElements.length} interactive elements found</p>
            </div>}
            {screenshot && <img className="mt-3 max-h-48 w-full rounded-md border border-border object-contain" src={screenshot} alt="Screenshot of the active browser tab" />}
            <Separator className="my-3" />
            <div className="grid gap-2">
              <input className="h-9 rounded-md border bg-background px-3 text-sm" value={selector} onChange={event => setSelector(event.target.value)} placeholder="CSS selector" aria-label="CSS selector" />
              <input className="h-9 rounded-md border bg-background px-3 text-sm" value={text} onChange={event => setText(event.target.value)} placeholder="Text to enter" aria-label="Text to enter" />
              <input className="h-9 rounded-md border bg-background px-3 text-sm" type="number" min="1" max="60" value={highlightSeconds} onChange={event => setHighlightSeconds(Number(event.target.value))} aria-label="Highlight duration in seconds" title="Highlight duration in seconds" />
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant="secondary" onClick={() => act({ kind: "click", selector })} disabled={!selector}>Click</Button>
                <Button size="sm" variant="secondary" onClick={() => act({ kind: "type", selector, text })} disabled={!selector}>Type</Button>
                <Button size="sm" variant="secondary" onClick={() => act({ kind: "highlight", selector, label: text || undefined, durationSeconds: highlightSeconds })} disabled={!selector}>Highlight</Button>
                <Button size="sm" variant="secondary" onClick={() => act({ kind: "request-user-action", selector, message: text || "Bitte selbst klicken", durationSeconds: highlightSeconds })} disabled={!selector}>Ask user</Button>
                <Button size="sm" variant="secondary" onClick={() => act({ kind: "scroll", deltaY: 600 })}>Scroll</Button>
              </div>
            </div>
          </div>
        )}
      </section>

      <p className="mt-3 px-2 text-center text-[11px] leading-4 text-muted-foreground">
        Microphone active only during a session · Passwords protected
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Popup /></StrictMode>);
