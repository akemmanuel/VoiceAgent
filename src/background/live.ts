/**
 * Voice session orchestration.
 *
 * The conversation state machine lives here, in the worker, because it spans both
 * the audio document and the network. The offscreen document is mechanical: it
 * reports speech boundaries and plays audio, and owns no conversation logic.
 *
 * MV3 may suspend this worker when idle. An active session keeps it alive through
 * message traffic, and the session state is intentionally in memory: a suspended
 * worker means the microphone is gone anyway, so the session is over.
 */

import type { ChatMessage } from "@/live/openrouter/client";
import { createChatCompletion, createSpeech, createTranscription } from "@/live/openrouter/client";
import { fetchSpeechModels, type CatalogModel } from "@/live/openrouter/catalog";
import { effectiveVoice, readOpenRouterSettings } from "@/live/openrouter/settings";
import { readEngine, type VoiceEngine } from "@/live/settings";
import { bytesToBase64 } from "@/live/voice/audio-codec";
import { reduce, type ConversationState, type VoiceAction, type VoiceEvent } from "@/live/voice/conversation";
import type { OffscreenCommand, OffscreenEvent, VoiceRequest, VoiceStatus } from "@/live/voice/protocol";
import { runTurn, systemMessage } from "@/live/voice/turn";
import { BROWSER_TOOLS, executeBrowserTool } from "./tab-tools";

const OFFSCREEN_PATH = "offscreen/index.html";

let state: ConversationState = "idle";
let engine: VoiceEngine = "chatgpt";
let error: string | null = null;
let transcript = "";
let reply = "";
let history: ChatMessage[] = [];
let turnAbort: AbortController | null = null;
/** The catalog is stable for a session and public, so it is fetched once. */
let speechModels: CatalogModel[] | null = null;

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function status(): VoiceStatus {
  return { state, engine, transcript, reply, error };
}

async function broadcast(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "voice-status-changed", status: status() });
  } catch {
    // No popup is open, which is the normal case during a session.
  }
}

async function sendToOffscreen(command: OffscreenCommand): Promise<void> {
  try {
    await chrome.runtime.sendMessage(command);
  } catch {
    // The document is closed or closing; the session ends either way.
  }
}

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: "Capture the microphone and play the spoken reply during a voice session.",
  });
}

/** Audio containers the transcription endpoint accepts, derived from the recorder's type. */
function audioFormatFor(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg")) return "mp3";
  return "wav";
}

async function loadSpeechModels(): Promise<CatalogModel[]> {
  speechModels ??= await fetchSpeechModels();
  return speechModels;
}

/**
 * Speech to text, then the agent turn, then text to speech. Each stage reports its
 * own failure so the user hears which part broke rather than a generic error.
 */
async function runVoiceTurn(userText: string): Promise<void> {
  const settings = await readOpenRouterSettings();
  if (!settings.apiKey) throw new Error("Add an OpenRouter key in settings before starting a voice session.");

  const controller = new AbortController();
  turnAbort = controller;
  try {
    const result = await runTurn(
      {
        chat: (messages, tools) =>
          createChatCompletion({ apiKey: settings.apiKey, model: settings.chatModel, messages, tools, signal: controller.signal }),
        executeTool: executeBrowserTool,
      },
      // The system prompt is seeded once and stays at the head of the history.
      history.length > 0 ? history : [systemMessage(BROWSER_TOOLS)],
      userText,
      BROWSER_TOOLS,
    );
    history = result.history;
    await dispatch({
      type: "turn-complete",
      reply: result.reply || (result.truncated ? "I could not finish that in a reasonable number of steps." : ""),
    });
  } finally {
    turnAbort = null;
  }
}

async function speak(text: string): Promise<void> {
  const settings = await readOpenRouterSettings();
  const models = await loadSpeechModels();
  const audio = await createSpeech({
    apiKey: settings.apiKey,
    model: settings.speechModel,
    input: text,
    voice: effectiveVoice(settings, models),
    format: "mp3",
  });
  await sendToOffscreen({
    target: "offscreen",
    type: "play",
    audioBase64: bytesToBase64(new Uint8Array(audio)),
    mimeType: "audio/mpeg",
  });
}

async function transcribeUtterance(audioBase64: string, mimeType: string): Promise<void> {
  const settings = await readOpenRouterSettings();
  const text = await createTranscription({
    apiKey: settings.apiKey,
    model: settings.transcriptionModel,
    audioBase64,
    format: audioFormatFor(mimeType),
  });
  await dispatch({ type: "transcript", text });
}

async function applyAction(action: VoiceAction): Promise<void> {
  switch (action.type) {
    case "capture-start":
      // Recording follows the detector inside the audio document, so there is
      // nothing to command here; this action marks intent in the transcript.
      return;
    case "capture-stop":
      await sendToOffscreen({ target: "offscreen", type: "discard-recording" });
      return;
    case "run-turn":
      // Not awaited: the reducer must stay responsive so barge-in can cancel it.
      void runVoiceTurn(action.transcript).catch(cause => {
        void dispatch({ type: "failed", message: messageOf(cause, "That turn failed.") });
      });
      return;
    case "speak":
      void speak(action.text).catch(cause => {
        void dispatch({ type: "failed", message: messageOf(cause, "The reply could not be spoken.") });
      });
      return;
    case "stop-playback":
      await sendToOffscreen({ target: "offscreen", type: "stop-playback" });
      return;
    case "cancel-turn":
      turnAbort?.abort();
      return;
    case "release":
      await sendToOffscreen({ target: "offscreen", type: "release" });
      if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
      return;
  }
}

async function dispatch(event: VoiceEvent): Promise<void> {
  const transition = reduce(state, event);
  state = transition.state;
  error = transition.error;
  for (const action of transition.actions) await applyAction(action);
  await broadcast();
}

export async function handleVoiceRequest(request: VoiceRequest): Promise<VoiceStatus> {
  switch (request.type) {
    case "voice-status":
      return status();

    case "voice-start": {
      engine = await readEngine();
      history = [];
      transcript = "";
      reply = "";
      if (engine === "chatgpt") {
        // Honest failure rather than a silent no-op: this engine has no audio path yet.
        await dispatch({ type: "start" });
        await dispatch({ type: "failed", message: "The ChatGPT engine cannot hold a spoken conversation yet. Choose the OpenRouter engine in settings." });
        return status();
      }
      try {
        await ensureOffscreen();
        await sendToOffscreen({ target: "offscreen", type: "listen" });
        await dispatch({ type: "start" });
      } catch (cause) {
        await dispatch({ type: "failed", message: messageOf(cause, "The microphone could not be opened.") });
      }
      return status();
    }

    case "voice-stop":
      await dispatch({ type: "stop" });
      return status();
  }
}

export async function handleOffscreenEvent(event: OffscreenEvent): Promise<void> {
  switch (event.type) {
    case "listening":
      return;
    case "speech-start":
      await dispatch({ type: "speech-start" });
      return;
    case "utterance":
      try {
        await transcribeUtterance(event.audioBase64, event.mimeType);
      } catch (cause) {
        await dispatch({ type: "failed", message: messageOf(cause, "The recording could not be transcribed.") });
      }
      return;
    case "playback-end":
      await dispatch({ type: "playback-end" });
      return;
    case "failed":
      await dispatch({ type: "failed", message: event.message });
      return;
  }
}
