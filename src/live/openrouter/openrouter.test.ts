import { beforeEach, describe, expect, test } from "bun:test";

import { fetchChatModels, fetchSpeechModels, fetchTranscriptionModels, resolveVoice } from "./catalog";
import {
  OpenRouterError,
  createChatCompletion,
  createSpeech,
  createTranscription,
  type ChatMessage,
} from "./client";
import {
  DEFAULT_OPENROUTER_SETTINGS,
  effectiveVoice,
  isOpenRouterConfigured,
  readOpenRouterSettings,
  reasoningOption,
  writeOpenRouterSettings,
} from "./settings";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("model catalog", () => {
  test("asks for audio models through the filtered endpoint", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      return jsonResponse({ data: [] });
    };

    await fetchSpeechModels(fetchImpl);
    await fetchTranscriptionModels(fetchImpl);
    await fetchChatModels(fetchImpl);

    // The unfiltered list reports no audio models at all, so these paths matter.
    expect(urls[0]).toBe("https://openrouter.ai/api/v1/models?output_modalities=speech");
    expect(urls[1]).toBe("https://openrouter.ai/api/v1/models?output_modalities=transcription");
    expect(urls[2]).toBe("https://openrouter.ai/api/v1/models");
  });

  test("reads supported voices and falls back to the id for a missing name", async () => {
    const models = await fetchSpeechModels(async () =>
      jsonResponse({
        data: [
          { id: "x-ai/grok-voice-tts-1.0", name: "Grok Voice TTS 1.0", supported_voices: ["eve", "ara", 7, null] },
          { id: "no-name/model", context_length: 4096 },
        ],
      }),
    );

    expect(models[0]).toEqual({
      id: "x-ai/grok-voice-tts-1.0",
      name: "Grok Voice TTS 1.0",
      contextLength: null,
      voices: ["eve", "ara"],
    });
    expect(models[1]?.name).toBe("no-name/model");
    expect(models[1]?.voices).toEqual([]);
  });

  test("skips entries without a usable id", async () => {
    const models = await fetchSpeechModels(async () => jsonResponse({ data: [{ name: "orphan" }, "nonsense"] }));
    expect(models).toEqual([]);
  });

  test("reports a catalog failure instead of returning nothing", async () => {
    await expect(fetchSpeechModels(async () => new Response("nope", { status: 503 }))).rejects.toThrow("503");
  });

  test("resolveVoice keeps a supported voice and otherwise takes the model's first", () => {
    const grok = { id: "x-ai/grok-voice-tts-1.0", name: "Grok", contextLength: null, voices: ["eve", "ara"] };
    expect(resolveVoice(grok, "ara")).toBe("ara");
    expect(resolveVoice(grok, "Zephyr")).toBe("eve");
    expect(resolveVoice(grok, "")).toBe("eve");
    expect(resolveVoice(undefined, "eve")).toBe("eve");
  });
});

describe("chat completions", () => {
  test("sends tools and reads back content with tool calls", async () => {
    let body: Record<string, unknown> = {};
    const result = await createChatCompletion(
      {
        apiKey: "key",
        model: "deepseek/deepseek-v4.1-flash",
        messages: [{ role: "user", content: "open the docs" }],
        tools: [{ name: "inspect-active-tab", description: "Read the page", parameters: { type: "object" } }],
      },
      async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          choices: [
            {
              message: {
                content: "Looking at it now.",
                tool_calls: [{ id: "call_1", type: "function", function: { name: "inspect-active-tab", arguments: "{}" } }],
              },
            },
          ],
        });
      },
    );

    expect(body.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "inspect-active-tab", description: "Read the page", parameters: { type: "object" } },
      },
    ]);
    expect(result).toEqual({ content: "Looking at it now.", toolCalls: [{ id: "call_1", name: "inspect-active-tab", arguments: "{}" }] });
  });

  test("echoes assistant tool calls and attaches results by id", async () => {
    let sent: { messages: unknown[] } = { messages: [] };
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "inspect-active-tab", arguments: "{}" }] },
      { role: "tool", content: "page text", toolCallId: "call_1" },
    ];

    await createChatCompletion({ apiKey: "key", model: "m", messages }, async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as { messages: unknown[] };
      return jsonResponse({ choices: [{ message: { content: "done" } }] });
    });

    expect(sent.messages[0]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "inspect-active-tab", arguments: "{}" } }],
    });
    expect(sent.messages[1]).toEqual({ role: "tool", content: "page text", tool_call_id: "call_1" });
  });

  test("sends a reasoning control only when one is asked for", async () => {
    let withReasoning: Record<string, unknown> = {};
    await createChatCompletion({ apiKey: "key", model: "m", messages: [], reasoning: { enabled: false } }, async (_url, init) => {
      withReasoning = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });
    expect(withReasoning.reasoning).toEqual({ enabled: false });

    // Absent means the provider default is left alone, so the key must not appear at all.
    let without: Record<string, unknown> = {};
    await createChatCompletion({ apiKey: "key", model: "m", messages: [] }, async (_url, init) => {
      without = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });
    expect("reasoning" in without).toBe(false);
  });

  test("surfaces the provider's message and status", async () => {
    const attempt = createChatCompletion({ apiKey: "bad", model: "m", messages: [] }, async () =>
      jsonResponse({ error: { message: "Insufficient credits." } }, 402),
    );
    await expect(attempt).rejects.toThrow(OpenRouterError);
    await expect(attempt).rejects.toHaveProperty("status", 402);
    await expect(attempt).rejects.toThrow("Insufficient credits.");
  });

  test("tolerates a response with no choices", async () => {
    const result = await createChatCompletion({ apiKey: "key", model: "m", messages: [] }, async () => jsonResponse({}));
    expect(result).toEqual({ content: "", toolCalls: [] });
  });
});

describe("speech and transcription", () => {
  test("requests audio in the chosen format and returns raw bytes", async () => {
    let body: Record<string, unknown> = {};
    const audio = await createSpeech(
      { apiKey: "key", model: "x-ai/grok-voice-tts-1.0", input: "hello", voice: "eve", format: "pcm" },
      async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
    );

    expect(body).toEqual({ model: "x-ai/grok-voice-tts-1.0", input: "hello", voice: "eve", response_format: "pcm" });
    expect(new Uint8Array(audio)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("defaults speech to mp3", async () => {
    let body: Record<string, unknown> = {};
    await createSpeech({ apiKey: "key", model: "m", input: "hi", voice: "eve" }, async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(new Uint8Array(), { status: 200 });
    });
    expect(body.response_format).toBe("mp3");
  });

  test("sends recorded audio as base64 and returns the transcript", async () => {
    let body: Record<string, unknown> = {};
    const text = await createTranscription(
      { apiKey: "key", model: "x-ai/grok-stt-1.0", audioBase64: "QUJD", format: "webm", language: "en" },
      async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ text: "hello there" });
      },
    );

    expect(body).toEqual({
      model: "x-ai/grok-stt-1.0",
      input_audio: { data: "QUJD", format: "webm" },
      language: "en",
    });
    expect(text).toBe("hello there");
  });

  test("returns an empty transcript rather than undefined", async () => {
    const text = await createTranscription(
      { apiKey: "key", model: "m", audioBase64: "QUJD", format: "webm" },
      async () => jsonResponse({}),
    );
    expect(text).toBe("");
  });

  test("reports a failed synthesis", async () => {
    const attempt = createSpeech({ apiKey: "key", model: "m", input: "hi", voice: "eve" }, async () =>
      jsonResponse({ error: { message: "No such voice." } }, 400),
    );
    await expect(attempt).rejects.toThrow("No such voice.");
  });
});

describe("openrouter settings", () => {
  const store = new Map<string, unknown>();

  beforeEach(() => {
    store.clear();
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
          set: async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) store.set(key, value);
          },
          remove: async (key: string) => store.delete(key),
        },
      },
    };
  });

  test("falls back to the documented defaults", async () => {
    expect(await readOpenRouterSettings()).toEqual(DEFAULT_OPENROUTER_SETTINGS);
    expect(DEFAULT_OPENROUTER_SETTINGS.chatModel).toBe("deepseek/deepseek-v4.1-flash");
    expect(DEFAULT_OPENROUTER_SETTINGS.transcriptionModel).toBe("x-ai/grok-stt-1.0");
    expect(DEFAULT_OPENROUTER_SETTINGS.speechModel).toBe("x-ai/grok-voice-tts-1.0");
  });

  test("round-trips saved choices", async () => {
    await writeOpenRouterSettings({
      apiKey: "sk-or-v1-secret",
      chatModel: "deepseek/deepseek-v4.1-flash",
      speechModel: "qwen/qwen-audio-3.0-tts-flash",
      transcriptionModel: "openai/gpt-transcribe",
      voice: "loongjohn",
      disableReasoning: false,
    });
    expect(await readOpenRouterSettings()).toEqual({
      apiKey: "sk-or-v1-secret",
      chatModel: "deepseek/deepseek-v4.1-flash",
      speechModel: "qwen/qwen-audio-3.0-tts-flash",
      transcriptionModel: "openai/gpt-transcribe",
      voice: "loongjohn",
      disableReasoning: false,
    });
  });

  test("enables the immediate-answer default for settings saved before the option existed", async () => {
    store.set("openrouter-settings", { apiKey: "sk-or-v1-secret", chatModel: "m", speechModel: "s", transcriptionModel: "t", voice: "v" });
    expect((await readOpenRouterSettings()).disableReasoning).toBe(true);
    expect(reasoningOption(DEFAULT_OPENROUTER_SETTINGS)).toEqual({ enabled: false });
    expect(reasoningOption({ ...DEFAULT_OPENROUTER_SETTINGS, disableReasoning: false })).toEqual({ enabled: true });
  });

  test("requires a key before the engine counts as configured", async () => {
    expect(isOpenRouterConfigured(await readOpenRouterSettings())).toBe(false);
    expect(isOpenRouterConfigured({ ...DEFAULT_OPENROUTER_SETTINGS, apiKey: "sk-or-v1-secret" })).toBe(true);
  });

  test("resolves the voice against the live catalog", () => {
    const speechModels = [
      { id: "x-ai/grok-voice-tts-1.0", name: "Grok", contextLength: null, voices: ["eve", "ara"] },
      { id: "qwen/qwen-audio-3.0-tts-flash", name: "Qwen", contextLength: null, voices: ["loongjohn"] },
    ];
    expect(effectiveVoice({ ...DEFAULT_OPENROUTER_SETTINGS, voice: "ara" }, speechModels)).toBe("ara");
    // Switching the speech model invalidates the previous voice instead of failing.
    expect(effectiveVoice({ ...DEFAULT_OPENROUTER_SETTINGS, voice: "ara", speechModel: "qwen/qwen-audio-3.0-tts-flash" }, speechModels)).toBe("loongjohn");
  });
});
