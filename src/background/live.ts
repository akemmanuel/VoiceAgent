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

import { log, errorDetails } from "@/lib/diagnostics";
import { getAccessToken } from "@/live/auth/credentials";
import { negotiateCall } from "@/live/chatgpt/call";
import { createLunaStream } from "@/live/chatgpt/responses";
import { DelegatedSession } from "@/live/agent/delegation";
import { AGENT_TOOLS, AgentTools } from "./agent-tools";
import type { ChatMessage } from "@/live/openrouter/client";
import { createChatCompletion, createSpeech, createTranscription } from "@/live/openrouter/client";
import { fetchSpeechModels, type CatalogModel } from "@/live/openrouter/catalog";
import { effectiveVoice, readOpenRouterSettings, reasoningOption } from "@/live/openrouter/settings";
import { readEngine, type VoiceEngine } from "@/live/settings";
import { bytesToBase64 } from "@/live/voice/audio-codec";
import { isActive, reduce, type ConversationState, type VoiceAction, type VoiceEvent } from "@/live/voice/conversation";
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
let sessionId: string | null = null;
let sessionAbort: AbortController | null = null;
let delegatedSession: DelegatedSession | null = null;
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
    const response = await chrome.runtime.sendMessage(command);
    if (!response?.ok) throw new Error(response?.error ?? "The audio document did not respond.");
  } catch (cause) {
    log("error", "voice", "offscreen-command-failed", { eventType: command.type, ...errorDetails(cause) });
    if (command.type !== "release") throw cause;
  }
}

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.IFRAME_SCRIPTING],
    justification: "Capture voice audio and host the sandboxed native JavaScript workspace iframe.",
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
          createChatCompletion({
            apiKey: settings.apiKey,
            model: settings.chatModel,
            messages,
            tools,
            reasoning: reasoningOption(settings),
            signal: controller.signal,
          }),
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
      // No-op: the offscreen document already stopped the recorder when it
      // detected speech-end, and the utterance blob is on its way. Sending
      // discard-recording here would drop the audio we want to transcribe.
      // Teardown still releases the microphone via `release`, which discards.
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
      sessionId = null;
      sessionAbort?.abort();
      sessionAbort = null;
      delegatedSession?.close();
      delegatedSession = null;
      await sendToOffscreen({ target: "offscreen", type: "release" });
      if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
      return;
  }
}

async function dispatch(event: VoiceEvent): Promise<void> {
  // Keep the popup's transcript visible: the reducer only decides state.
  if (event.type === "transcript") transcript = event.text.trim();
  if (event.type === "turn-complete") reply = event.reply.trim();
  log(event.type === "failed" ? "error" : "debug", "voice", "state-event", { sessionId, eventType: event.type, state });
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
      if (isActive(state)) return status();
      state = "connecting";
      error = null;
      const id = crypto.randomUUID();
      sessionId = id;
      sessionAbort = new AbortController();
      engine = await readEngine();
      log("info", "voice", "session-started", { sessionId: id, kind: engine });
      history = [];
      transcript = "";
      reply = "";
      await broadcast();
      try {
        if (engine === "chatgpt") {
          await getAccessToken();
          if (sessionId !== id) return status();
          const tools = new AgentTools();
          delegatedSession = new DelegatedSession(id, {
            tools: AGENT_TOOLS,
            stream: createLunaStream(getAccessToken),
            execute: (name, args, signal) => tools.execute(name, args, signal),
            publish: async update => {
              if (sessionId !== id) return;
              await sendToOffscreen({ target: "offscreen", type: "chatgpt-delegation", sessionId: id, ...update });
            },
            dispose: () => tools.close(),
          });
        }
        else if (!(await readOpenRouterSettings()).apiKey) throw new Error("Add an OpenRouter key in settings before starting a voice session.");
        if (sessionId !== id) return status();
        await ensureOffscreen();
        if (sessionId !== id) {
          if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
          return status();
        }
        await sendToOffscreen(engine === "chatgpt"
          ? { target: "offscreen", type: "chatgpt-start", sessionId: id }
          : { target: "offscreen", type: "listen" });
        if (sessionId === id) await dispatch({ type: "start" });
      } catch (cause) {
        log("error", "voice", "session-start-failed", { sessionId: id, ...errorDetails(cause) });
        if (sessionId === id) await dispatch({ type: "failed", message: messageOf(cause, "The microphone could not be opened.") });
      }
      return status();
    }

    case "voice-stop":
      log("info", "voice", "stop-requested", { sessionId });
      await dispatch({ type: "stop" });
      return status();
  }
}

/** Called only for messages from our own offscreen document. */
export async function handleChatGPTMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = sessionId;
  if (!id || message.sessionId !== id || engine !== "chatgpt") {
    log("warn", "voice", "stale-offscreen-message", { eventType: message.type, kind: message.kind });
    return { ok: false, error: "Voice session ended." };
  }
  try {
    if (message.type === "chatgpt-offer") {
      if (typeof message.sdp !== "string" || message.sdp.length > 100_000) throw new Error("Invalid voice offer.");
      const signal = AbortSignal.any([sessionAbort!.signal, AbortSignal.timeout(30_000)]);
      const credentials = await getAccessToken();
      signal.throwIfAborted();
      log("info", "voice", "negotiation-started", { sessionId: id });
      const answer = await negotiateCall(message.sdp, credentials, signal);
      log("info", "voice", "negotiation-completed", { sessionId: id });
      return sessionId === id ? { ok: true, answer } : { ok: false, error: "Voice session ended." };
    }
    if (message.kind === "delegation") {
      if (typeof message.id !== "string" || typeof message.prompt !== "string" || !delegatedSession) throw new Error("Invalid delegated request or no active agent.");
      delegatedSession.submit(message.id, message.prompt);
    } else if (message.kind === "failed") {
      await dispatch({ type: "failed", message: typeof message.message === "string" ? message.message : "ChatGPT voice disconnected." });
    } else if (message.kind === "transcript" && typeof message.text === "string") {
      if (message.role === "user") transcript = message.text;
      if (message.role === "assistant") reply = message.text;
      await broadcast();
    }
    return { ok: true };
  } catch (cause) {
    log("error", "voice", "offscreen-message-failed", { sessionId: id, eventType: message.type, kind: message.kind, ...errorDetails(cause) });
    return { ok: false, error: messageOf(cause, "ChatGPT voice negotiation failed.") };
  }
}

export async function handleOffscreenEvent(event: OffscreenEvent): Promise<void> {
  switch (event.type) {
    case "listening":
      return;
    case "speech-start":
      await dispatch({ type: "speech-start" });
      return;
    case "speech-end":
      await dispatch({ type: "speech-end" });
      return;
    case "utterance":
      try {
        // Defensive: the utterance blob resolves async after speech-end was
        // posted, but if the message was lost the state is still capturing
        // and the transcript would be dropped. Advance first.
        if (state === "capturing") await dispatch({ type: "speech-end" });
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
