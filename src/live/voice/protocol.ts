/**
 * Messages passed between the popup, the service worker, and the offscreen audio
 * document. The `target`/`source` fields keep the three apart on the single
 * `runtime.onMessage` channel that the tab tools already use.
 */

import type { VoiceEngine } from "@/live/settings";
import type { ConversationState } from "@/live/voice/conversation";

/** Worker to offscreen document. */
export type OffscreenCommand =
  | { target: "offscreen"; type: "listen" }
  /** Abandon the recording in progress without transcribing it. */
  | { target: "offscreen"; type: "discard-recording" }
  | { target: "offscreen"; type: "play"; audioBase64: string; mimeType: string }
  | { target: "offscreen"; type: "stop-playback" }
  /** Close the microphone and the audio graph. */
  | { target: "offscreen"; type: "release" };

/** Offscreen document to worker. */
export type OffscreenEvent =
  | { source: "offscreen"; type: "listening" }
  | { source: "offscreen"; type: "speech-start" }
  | { source: "offscreen"; type: "utterance"; audioBase64: string; mimeType: string }
  | { source: "offscreen"; type: "playback-end" }
  | { source: "offscreen"; type: "failed"; message: string };

export type VoiceRequest = { type: "voice-start" } | { type: "voice-stop" } | { type: "voice-status" };

export type VoiceStatus = {
  state: ConversationState;
  /** Which engine the session is running, or would run. */
  engine: VoiceEngine;
  /** Most recent thing the user said, for the popup transcript. */
  transcript: string;
  /** Most recent reply, so the user can read what was spoken. */
  reply: string;
  error: string | null;
};

export type VoiceStatusMessage = { type: "voice-status-changed"; status: VoiceStatus };

export function isOffscreenCommand(message: unknown): message is OffscreenCommand {
  return typeof message === "object" && message !== null && (message as { target?: unknown }).target === "offscreen";
}

export function isOffscreenEvent(message: unknown): message is OffscreenEvent {
  return typeof message === "object" && message !== null && (message as { source?: unknown }).source === "offscreen";
}

export function isVoiceRequest(message: unknown): message is VoiceRequest {
  const type = (message as { type?: unknown } | null)?.type;
  return type === "voice-start" || type === "voice-stop" || type === "voice-status";
}
