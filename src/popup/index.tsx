import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CaretDownIcon, CaretUpIcon, CopyIcon, GearSixIcon, MicrophoneIcon, MicrophoneSlashIcon, WaveformIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { DEFAULT_DISPLAY_NAME, DISPLAY_NAME_STORAGE_KEY, readDisplayName } from "@/live/settings";
import { isActive, type ConversationState } from "@/live/voice/conversation";
import type { VoiceDebugReport, VoiceStatus, VoiceStatusMessage } from "@/live/voice/protocol";

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

function Popup() {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoice] = useState<VoiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState(DEFAULT_DISPLAY_NAME);
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const [debugCopied, setDebugCopied] = useState(false);

  useEffect(() => {
    void sendVoice({ type: "voice-status" }).then(setVoice);
    void readDisplayName().then(setDisplayName);
    const messageListener = (message: unknown) => {
      const update = message as VoiceStatusMessage;
      if (update?.type === "voice-status-changed") setVoice(update.status);
    };
    const storageListener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName === "local" && changes[DISPLAY_NAME_STORAGE_KEY]) void readDisplayName().then(setDisplayName);
    };
    chrome.runtime.onMessage.addListener(messageListener);
    chrome.storage.onChanged.addListener(storageListener);
    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      chrome.storage.onChanged.removeListener(storageListener);
    };
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
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(track => track.stop());
        }
      }
      const next = await sendVoice({ type: stopping ? "voice-stop" : "voice-start" });
      if (next) setVoice(next);
      else setError("The voice session could not be reached. Try reopening VoiceAgent.");
    } catch (cause) {
      setError(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "Microphone access is blocked. Allow it in this tab's site settings, then retry."
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
      setError("Settings couldn't open. Open extension options from your browser's Extensions page.");
    } finally {
      setOpening(false);
    }
  }

  const voiceActive = Boolean(voice && isActive(voice.state));
  const microphoneSetup = new URLSearchParams(location.search).has("microphone");

  async function copyDebugReport() {
    setError(null);
    try {
      const report = await chrome.runtime.sendMessage({ type: "voice-debug-report" }) as VoiceDebugReport;
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setDebugCopied(true);
      window.setTimeout(() => setDebugCopied(false), 2500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The debug report could not be copied.");
    }
  }

  return (
    <main className="popup-shell" data-voice-state={voice?.state ?? "idle"}>
      <header className="app-header flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="brand-mark flex size-9 shrink-0 items-center justify-center rounded-xl text-primary-foreground">
            <WaveformIcon size={21} weight="bold" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight">VoiceAgent</h1>
            <p className="truncate text-xs text-muted-foreground">Your browser, voice controlled</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" className="shrink-0" onClick={openSettings} disabled={opening} aria-label="Open settings" title="Open settings">
          <GearSixIcon className={opening ? "animate-spin" : ""} aria-hidden="true" />
        </Button>
      </header>

      {microphoneSetup && (
        <div role="status" className="notice-enter mt-4 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs leading-5 text-muted-foreground">
          Start the session and allow microphone access. You can close this tab after connecting.
        </div>
      )}

      <section aria-labelledby="voice-title" className="voice-card mt-4 rounded-2xl" aria-live="polite">
        <div className="voice-summary grid items-center gap-3">
          <span className={`voice-orb ${voiceActive ? "voice-orb-active" : ""}`} aria-hidden="true">
            <span className="voice-bars"><span /><span /><span /><span /><span /></span>
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="voice-title" className="text-lg font-semibold tracking-tight">{voice ? VOICE_LABELS[voice.state] : "Ready to listen"}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {voice ? `${voice.engine === "openrouter" ? "OpenRouter" : "ChatGPT"} voice engine` : "Start a hands-free browser session"}
            </p>
          </div>
          <span className={`status-chip ${voiceActive ? "status-chip-active" : ""}`}>
            <span aria-hidden="true" /><span className="status-text">{voiceActive ? "Live" : "Ready"}</span>
          </span>
        </div>

        <Button className={`mt-5 h-11 w-full rounded-xl ${voiceActive ? "bg-destructive hover:bg-destructive/90" : ""}`} onClick={toggleVoice} disabled={busy}>
          {voiceActive ? <MicrophoneSlashIcon aria-hidden="true" /> : <MicrophoneIcon weight="fill" aria-hidden="true" />}
          {busy ? "Working…" : voiceActive ? "Stop voice session" : "Start voice session"}
        </Button>

        {(voice?.transcript || voice?.reply) && (
          <div className="transcript-panel mt-4 overflow-hidden rounded-xl">
            <div className="flex items-center justify-between px-3 py-2">
              <p className="text-xs font-semibold">Live transcription</p>
              <Button variant="ghost" size="icon-xs" onClick={() => setTranscriptOpen(open => !open)} aria-expanded={transcriptOpen} aria-controls="transcript-content" aria-label={transcriptOpen ? "Minimize transcription" : "Expand transcription"} title={transcriptOpen ? "Minimize transcription" : "Expand transcription"}>
                {transcriptOpen ? <CaretUpIcon aria-hidden="true" /> : <CaretDownIcon aria-hidden="true" />}
              </Button>
            </div>
            {transcriptOpen && (
              <div id="transcript-content" className="conversation-feed max-h-48 space-y-3 overflow-y-auto border-t border-border p-3 text-xs leading-5">
                {voice.transcript && (
                  <div className="message-row message-user">
                    <div className="message-meta justify-end"><span>{displayName}</span><span className="message-avatar message-avatar-user" aria-hidden="true">{displayName.charAt(0).toUpperCase()}</span></div>
                    <p className="message-bubble message-bubble-user">{voice.transcript}</p>
                  </div>
                )}
                {voice.reply && (
                  <div className="message-row message-agent">
                    <div className="message-meta"><span className="message-avatar message-avatar-agent" aria-hidden="true"><WaveformIcon weight="bold" /></span><span>VoiceAgent</span></div>
                    <p className="message-bubble message-bubble-agent">{voice.reply}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {voice && <>
          <p className="mt-2 text-xs text-muted-foreground">Agent activity: {voice.activity.length} tool call{voice.activity.length === 1 ? "" : "s"}</p>
          <Button variant="secondary" className="mt-2 w-full" onClick={copyDebugReport}>
            <CopyIcon aria-hidden="true" />
            {debugCopied ? "Debug report copied" : "Copy debug report"}
          </Button>
        </>}
        {voice?.error && <p role="alert" className="notice-enter mt-3 text-sm leading-5 text-destructive">{voice.error}</p>}
        {error && <p role="alert" className="notice-enter mt-3 text-sm leading-5 text-destructive">{error}</p>}
      </section>

      <p className="mt-3 px-2 text-center text-[11px] leading-4 text-muted-foreground">Microphone active only during a session · Passwords protected</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Popup /></StrictMode>);
