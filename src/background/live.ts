/**
 * Voice session orchestration.
 *
 * The conversation state machine lives here, in the worker, because it spans both
 * the audio document and the network. The offscreen document is mechanical: it
 * reports speech boundaries and plays audio, and owns no conversation logic.
 *
 * MV3 may suspend this worker when idle. An active session keeps it alive through
 * message traffic. Active microphone state is intentionally in memory: a
 * suspended worker means the microphone is gone anyway. The completed OpenRouter
 * conversation itself is saved separately in extension-local storage.
 */

import { getAccessToken } from "@/live/auth/credentials";
import { negotiateCall } from "@/live/chatgpt/call";
import type { ChatMessage } from "@/live/openrouter/client";
import { createChatCompletion, createSpeech, createTranscription } from "@/live/openrouter/client";
import { fetchSpeechModels, type CatalogModel } from "@/live/openrouter/catalog";
import { effectiveVoice, readOpenRouterSettings, reasoningOption } from "@/live/openrouter/settings";
import { readChatGPTVoice, readEngine, type VoiceEngine } from "@/live/settings";
import { bytesToBase64 } from "@/live/voice/audio-codec";
import { isActive, reduce, type ConversationState, type VoiceAction, type VoiceEvent } from "@/live/voice/conversation";
import { readStoredConversation, storeConversation } from "@/live/voice/history";
import type { OffscreenCommand, OffscreenEvent, VoiceLevels, VoiceRequest, VoiceStatus } from "@/live/voice/protocol";
import { requestWithActivePage, runTurn, systemMessage } from "@/live/voice/turn";
import { BROWSER_TOOLS, executeBrowserTool } from "./tab-tools";

const OFFSCREEN_PATH = "offscreen/index.html";
const CONVERSATION_STORAGE_KEY = "voiceAgent.conversation.v1";

let state: ConversationState = "idle";
let engine: VoiceEngine = "chatgpt";
let error: string | null = null;
let transcript = "";
let reply = "";
let levels: VoiceLevels | null = null;
let history: ChatMessage[] = [];
let conversationLoaded = false;
let turnAbort: AbortController | null = null;
let sessionId: string | null = null;
let sessionAbort: AbortController | null = null;
/** The catalog is stable for a session and public, so it is fetched once. */
let speechModels: CatalogModel[] | null = null;

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function status(): VoiceStatus {
  return { state, engine, transcript, reply, error, levels };
}

async function loadConversation(): Promise<void> {
  if (conversationLoaded) return;
  conversationLoaded = true;
  try {
    const stored = readStoredConversation((await chrome.storage.local.get(CONVERSATION_STORAGE_KEY))[CONVERSATION_STORAGE_KEY]);
    if (!stored) return;
    history = stored.history;
    transcript = stored.transcript;
    reply = stored.reply;
  } catch {
    // Storage is an enhancement. A new in-memory conversation is still usable.
  }
}

async function saveConversation(): Promise<void> {
  const stored = storeConversation(history, transcript, reply);
  history = stored.history;
  try {
    await chrome.storage.local.set({ [CONVERSATION_STORAGE_KEY]: stored });
  } catch {
    // Do not make an otherwise successful agent turn fail because storage is full.
  }
}

async function resetConversation(): Promise<VoiceStatus> {
  if (isActive(state)) await dispatch({ type: "stop" });
  history = [];
  transcript = "";
  reply = "";
  error = null;
  state = "idle";
  conversationLoaded = true;
  try {
    await chrome.storage.local.remove(CONVERSATION_STORAGE_KEY);
  } catch {
    // The visible session is still reset even if the browser declines storage access.
  }
  await broadcast();
  return status();
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
    if (command.type !== "release") throw cause;
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
/** Run the browser-agent loop used by both typed turns and OpenRouter voice turns. */
async function runAgentTurn(userText: string): Promise<string> {
  await loadConversation();
  const settings = await readOpenRouterSettings();
  if (!settings.apiKey) throw new Error("Add an OpenRouter key in settings before using the browser agent.");

  // Page awareness must not depend on a model voluntarily deciding to call an
  // observation tool. This also lets it act on the open admin page in its first
  // tool round. The snapshot is intentionally not retained as user text.
  let pageSnapshot: string;
  try {
    pageSnapshot = await executeBrowserTool("inspect-active-tab", "{}");
  } catch (cause) {
    pageSnapshot = `The active page could not be inspected: ${messageOf(cause, "unknown browser error")}`;
  }
  const modelRequest = requestWithActivePage(userText, pageSnapshot);

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
      // Refresh the system instruction on every turn. This lets a stored
      // conversation safely adopt new browser-agent safeguards after an update.
      [systemMessage(BROWSER_TOOLS), ...history.filter(message => message.role !== "system")],
      modelRequest,
      BROWSER_TOOLS,
    );
    // Do not store a stale page snapshot as if the user had written it. The next
    // turn obtains a new one after navigation or reload.
    const latestUser = result.history.map((message, index) => ({ message, index })).reverse().find(({ message }) => message.role === "user" && message.content === modelRequest);
    history = latestUser
      ? result.history.map((message, index) => index === latestUser.index ? { role: "user" as const, content: userText } : message)
      : result.history;
    return result.reply || (result.truncated
      ? `I reached the browser action limit after ${result.toolCallCount} tool calls before completing this task. Ask me to continue and I will resume from the current page.`
      : "");
  } finally {
    turnAbort = null;
  }
}

async function runVoiceTurn(userText: string): Promise<void> {
  await dispatch({ type: "turn-complete", reply: await runAgentTurn(userText) });
  await saveConversation();
}

/**
 * A typed message is an agent turn, not a synthetic voice turn: it never starts
 * text-to-speech, but it deliberately retains the same message history.
 */
async function runTextTurn(text: string): Promise<VoiceStatus> {
  const userText = text.trim();
  if (!userText) return status();

  // A microphone session and a text turn must not race for the same state
  // machine. Stopping audio keeps `history`, so the next modality continues the
  // same conversation.
  if (isActive(state)) await dispatch({ type: "stop" });

  engine = await readEngine();
  transcript = userText;
  reply = "";
  error = null;
  state = "thinking";
  await broadcast();
  try {
    if (engine !== "openrouter") {
      throw new Error("Written browser-agent chat uses OpenRouter. Select OpenRouter and add its API key in settings.");
    }
    reply = (await runAgentTurn(userText)).trim();
    state = "idle";
    await saveConversation();
  } catch (cause) {
    state = "failed";
    error = messageOf(cause, "That message could not be processed.");
  }
  await broadcast();
  return status();
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
      await sendToOffscreen({ target: "offscreen", type: "release" });
      if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
      return;
  }
}

async function dispatch(event: VoiceEvent): Promise<void> {
  // Keep the popup's transcript visible: the reducer only decides state.
  if (event.type === "transcript") transcript = event.text.trim();
  if (event.type === "turn-complete") reply = event.reply.trim();
  const transition = reduce(state, event);
  state = transition.state;
  error = transition.error;
  for (const action of transition.actions) await applyAction(action);
  await broadcast();
}

export async function handleVoiceSettingsChanged(): Promise<void> {
  engine = await readEngine();
  if (engine === "chatgpt" && isActive(state) && await chrome.offscreen.hasDocument()) {
    await sendToOffscreen({ target: "offscreen", type: "chatgpt-voice", voice: await readChatGPTVoice() });
  }
  await broadcast();
}

export async function handleVoiceRequest(request: VoiceRequest): Promise<VoiceStatus> {
  switch (request.type) {
    case "voice-status":
      await loadConversation();
      return status();

    case "voice-start": {
      if (isActive(state)) return status();
      state = "connecting";
      error = null;
      const id = crypto.randomUUID();
      sessionId = id;
      sessionAbort = new AbortController();
      engine = await readEngine();
      await loadConversation();
      // Telemetry only. The conversation itself is restored above, not reset, so
      // starting a session continues the stored conversation.
      levels = null;
      await broadcast();
      try {
        if (engine === "chatgpt") await getAccessToken();
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
        if (sessionId === id) await dispatch({ type: "failed", message: messageOf(cause, "The microphone could not be opened.") });
      }
      return status();
    }

    case "voice-stop":
      await dispatch({ type: "stop" });
      return status();

    case "text-send":
      return runTextTurn(request.text);

    case "conversation-reset":
      return resetConversation();
  }
}

/** Called only for messages from our own offscreen document. */
export async function handleChatGPTMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = sessionId;
  if (!id || message.sessionId !== id || engine !== "chatgpt") return { ok: false, error: "Voice session ended." };
  try {
    if (message.type === "chatgpt-offer") {
      if (typeof message.sdp !== "string" || message.sdp.length > 100_000) throw new Error("Invalid voice offer.");
      const signal = AbortSignal.any([sessionAbort!.signal, AbortSignal.timeout(30_000)]);
      const [credentials, voice] = await Promise.all([getAccessToken(), readChatGPTVoice()]);
      signal.throwIfAborted();
      const answer = await negotiateCall(message.sdp, credentials, signal, voice);
      return sessionId === id ? { ok: true, answer } : { ok: false, error: "Voice session ended." };
    }
    if (message.kind === "failed") {
      await dispatch({ type: "failed", message: typeof message.message === "string" ? message.message : "ChatGPT voice disconnected." });
    } else if (message.kind === "transcript" && typeof message.text === "string") {
      if (message.role === "user") transcript = message.text;
      if (message.role === "assistant") reply = message.text;
      await broadcast();
    }
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: messageOf(cause, "ChatGPT voice negotiation failed.") };
  }
}

export async function handleOffscreenEvent(event: OffscreenEvent): Promise<void> {
  switch (event.type) {
    case "listening":
      return;
    case "levels":
      // Deliberately not routed through the state machine: this is telemetry, not a
      // conversation event, and it must not disturb turn-taking.
      levels = { rms: event.rms, floor: event.floor, onsetRms: event.onsetRms };
      await broadcast();
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
