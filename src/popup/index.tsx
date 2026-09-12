import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { GearSixIcon, MicrophoneIcon, MicrophoneSlashIcon, WaveformIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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

function Popup() {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <main className="p-6">
      <header className="flex items-center gap-2.5">
        <WaveformIcon size={26} weight="bold" className="text-primary" aria-hidden="true" />
        <h1 className="text-lg font-semibold tracking-tight">VoiceAgent</h1>
        <Button variant="ghost" size="icon" className="ml-auto" onClick={openSettings} disabled={opening} aria-label={opening ? "Opening settings" : "Open settings"} title="Open settings">
          <GearSixIcon aria-hidden="true" />
        </Button>
      </header>
      {new URLSearchParams(location.search).has("microphone") && <p role="status" className="mt-4 text-sm leading-6">Click Start voice session below, then allow microphone access. Audio is sent to the selected voice provider while the session runs. You can close this tab after connecting.</p>}
      <Separator className="my-6" />
      <section aria-label="Voice session">
        <Button className="w-full" onClick={toggleVoice} disabled={busy}>
          {voice && isActive(voice.state) ? <MicrophoneSlashIcon aria-hidden="true" /> : <MicrophoneIcon aria-hidden="true" />}
          {busy ? "Working…" : voice && isActive(voice.state) ? "Stop voice session" : "Start voice session"}
        </Button>
        {voice && (
          <p role="status" className="mt-3 text-center text-base font-medium">
            {VOICE_LABELS[voice.state]}
          </p>
        )}
        {(!voice || !isActive(voice.state)) && <p className="mt-4 text-sm leading-6 text-muted-foreground">Try saying "Summarize this page" or "Show me where to click."</p>}
        {voice?.transcript && <p className="mt-3 text-xs leading-5"><span className="font-semibold">You:</span> {voice.transcript}</p>}
        {voice?.reply && <p className="mt-1 text-xs leading-5"><span className="font-semibold">Agent:</span> {voice.reply}</p>}
        {voice?.error && <p role="alert" className="mt-3 text-sm leading-5 text-destructive">{voice.error}</p>}
        {error && <p role="alert" className="mt-3 text-sm leading-5 text-destructive">{error}</p>}
      </section>
      <p className="mt-5 text-xs leading-5 text-muted-foreground">The microphone is used only while a voice session is running · Password fields are protected</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Popup /></StrictMode>);
