/**
 * OpenRouter client for the chained voice engine.
 *
 * OpenAI-compatible request shapes across three endpoints: chat completions for
 * the reasoning step, audio speech for text-to-speech, and audio transcriptions
 * for speech-to-text. One key covers all three, which is the point of the engine.
 */

import { OPENROUTER_BASE_URL } from "./catalog";

const CHAT_ENDPOINT = `${OPENROUTER_BASE_URL}/chat/completions`;
const SPEECH_ENDPOINT = `${OPENROUTER_BASE_URL}/audio/speech`;
const TRANSCRIPTION_ENDPOINT = `${OPENROUTER_BASE_URL}/audio/transcriptions`;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Audio container the speech endpoint should return. */
export type SpeechFormat = "mp3" | "pcm" | "wav";

export type ToolCall = {
  id: string;
  name: string;
  /** Raw JSON arguments as the model emitted them. */
  arguments: string;
};

export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

/** Provider-neutral tool description, matching the OpenAI function-calling shape. */
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/**
 * OpenRouter's reasoning control.
 *
 * A voice turn disables reasoning. Measured against the live API, a reasoning model
 * sometimes answers in 1.3s and sometimes thinks for 8.3s first, and the user hears
 * that as a hang. Disabling it removes the tail: every measured reply began speaking
 * inside a second. It is a latency setting, not a quality one, so it is configurable.
 */
export type ReasoningOptions = { enabled: boolean };

export type ChatResult = {
  /** Spoken text, which is the assistant message content. */
  content: string;
  toolCalls: ToolCall[];
};

export class OpenRouterError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

/**
 * Reads OpenRouter's error envelope. It nests the provider's message under `error`,
 * which is far more useful than the bare status (401 vs 402 in particular: a bad key
 * and an empty balance both surface as failures worth telling apart).
 */
async function readError(response: Response): Promise<OpenRouterError> {
  let message = `OpenRouter returned ${response.status}.`;
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // Keep the status-based message.
  }
  return new OpenRouterError(message, response.status);
}

export type ChatRequest = {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Omitted entirely when unset, so a provider default is left alone. */
  reasoning?: ReasoningOptions;
  signal?: AbortSignal;
};

type WireMessage = {
  role: string;
  content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

function toWireMessage(message: ChatMessage): WireMessage {
  if (message.role === "assistant" && "toolCalls" in message) {
    return {
      role: "assistant",
      content: message.content,
      // The assistant turn that requested tools must echo them back verbatim,
      // otherwise the following tool results have nothing to attach to.
      tool_calls: message.toolCalls.map(call => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  if (message.role === "tool") return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  return { role: message.role, content: message.content };
}

/**
 * One chat completion. Tools are declared when the agent needs to act on the
 * browser; the model then answers with tool calls instead of speech.
 */
export async function createChatCompletion(request: ChatRequest, fetchImpl: FetchLike = fetch): Promise<ChatResult> {
  const response = await fetchImpl(CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      "Content-Type": "application/json",
      // OpenRouter uses these for attribution on its dashboard.
      "X-Title": "VoiceAgent",
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages.map(toWireMessage),
      ...(request.reasoning ? { reasoning: request.reasoning } : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map(tool => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
          }
        : {}),
    }),
    signal: request.signal,
  });
  if (!response.ok) throw await readError(response);

  const body = (await response.json()) as {
    choices?: { message?: { content?: unknown; tool_calls?: unknown } }[];
  };
  const message = body.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : "";
  const toolCalls: ToolCall[] = Array.isArray(message?.tool_calls)
    ? message.tool_calls.flatMap(call => {
        const typed = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
        if (typeof typed.id !== "string" || typeof typed.function?.name !== "string") return [];
        return [
          {
            id: typed.id,
            name: typed.function.name,
            arguments: typeof typed.function.arguments === "string" ? typed.function.arguments : "{}",
          },
        ];
      })
    : [];

  return { content, toolCalls };
}

export type SpeechRequest = {
  apiKey: string;
  model: string;
  /** Text to speak. */
  input: string;
  voice: string;
  format?: SpeechFormat;
  signal?: AbortSignal;
};

/**
 * Synthesizes speech and returns the raw audio bytes. The caller decodes them; PCM
 * is the useful format for streaming playback, mp3 is smaller to buffer.
 */
export async function createSpeech(request: SpeechRequest, fetchImpl: FetchLike = fetch): Promise<ArrayBuffer> {
  const response = await fetchImpl(SPEECH_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "VoiceAgent",
    },
    body: JSON.stringify({
      model: request.model,
      input: request.input,
      voice: request.voice,
      response_format: request.format ?? "mp3",
    }),
    signal: request.signal,
  });
  if (!response.ok) throw await readError(response);
  return response.arrayBuffer();
}

export type TranscriptionRequest = {
  apiKey: string;
  model: string;
  /** Recorded audio, base64-encoded. */
  audioBase64: string;
  /** Audio container of `audioBase64`, for example `webm`. */
  format: string;
  language?: string;
  signal?: AbortSignal;
};

/**
 * Transcribes recorded audio. Sends base64 JSON rather than multipart, because the
 * extension records in the browser and never has a file to upload.
 */
export async function createTranscription(
  request: TranscriptionRequest,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const response = await fetchImpl(TRANSCRIPTION_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "VoiceAgent",
    },
    body: JSON.stringify({
      model: request.model,
      input_audio: { data: request.audioBase64, format: request.format },
      ...(request.language ? { language: request.language } : {}),
    }),
    signal: request.signal,
  });
  if (!response.ok) throw await readError(response);

  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === "string" ? body.text : "";
}
