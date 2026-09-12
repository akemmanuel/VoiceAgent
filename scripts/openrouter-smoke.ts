/**
 * Exercises the chained OpenRouter engine against the live API.
 *
 * Run with `OPENROUTER_API_KEY=... bun run scripts/openrouter-smoke.ts`. The key is
 * read from the environment on purpose: it must never be written into source, and a
 * key pasted into a file or a chat has to be rotated.
 *
 * This walks the same three calls the voice loop makes, without a microphone:
 * catalog lookup, transcription of a synthesized sample, a chat turn with a tool,
 * and speech synthesis.
 */

import { createChatCompletion, createSpeech, createTranscription } from "../src/live/openrouter/client";
import { fetchSpeechModels, fetchTranscriptionModels, resolveVoice } from "../src/live/openrouter/catalog";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY before running this script.");
  process.exit(1);
}

const chatModel = process.env.OPENROUTER_CHAT_MODEL ?? "deepseek/deepseek-v4.1-flash";
const speechModelId = process.env.OPENROUTER_SPEECH_MODEL ?? "x-ai/grok-voice-tts-1.0";
const transcriptionModel = process.env.OPENROUTER_TRANSCRIPTION_MODEL ?? "x-ai/grok-stt-1.0";

console.log("1. Catalog");
const speechModels = await fetchSpeechModels();
const transcriptionModels = await fetchTranscriptionModels();
const speechModel = speechModels.find(model => model.id === speechModelId);
const voice = resolveVoice(speechModel, "");
console.log(`   speech models:        ${speechModels.length}`);
console.log(`   transcription models: ${transcriptionModels.length}`);
console.log(`   ${speechModelId} voices: ${speechModel?.voices.slice(0, 8).join(", ") || "(none listed)"}`);
console.log(`   using voice:          ${voice || "(model has no listed voices)"}`);

console.log("\n2. Text to speech");
const spoken = "The browser agent connection works.";
const audio = await createSpeech({ apiKey, model: speechModelId, input: spoken, voice, format: "mp3" });
console.log(`   synthesized ${audio.byteLength} bytes of mp3`);

console.log("\n3. Speech to text");
const transcript = await createTranscription({
  apiKey,
  model: transcriptionModel,
  audioBase64: Buffer.from(audio).toString("base64"),
  format: "mp3",
});
console.log(`   heard: "${transcript.trim()}"`);

console.log("\n4. Reasoning with a tool");
const chat = await createChatCompletion({
  apiKey,
  model: chatModel,
  messages: [{ role: "user", content: "Read the current tab and tell me its title." }],
  tools: [
    {
      name: "inspect-active-tab",
      description: "Read the visible text and interactive controls of the active browser tab.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
});
console.log(`   content:    ${JSON.stringify(chat.content)}`);
console.log(`   tool calls: ${chat.toolCalls.map(call => `${call.name}(${call.arguments})`).join(", ") || "(none)"}`);

console.log("\nAll four stages answered.");
