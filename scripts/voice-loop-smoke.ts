/**
 * End-to-end check of the voice loop without a microphone.
 *
 * The microphone is replaced by a TTS -> STT round trip: a question is synthesized,
 * the resulting audio is fed back in as if the user had spoken it, and the real
 * agent loop then runs with the real tool definitions. Every stage except the
 * offscreen audio document and the browser tools is production code.
 *
 * Run with `OPENROUTER_API_KEY=... bun run scripts/voice-loop-smoke.ts`. The key is
 * read from the environment on purpose; it must never be written into a file.
 */

import { createChatCompletion, createSpeech, createTranscription } from "../src/live/openrouter/client";
import { fetchSpeechModels, fetchTranscriptionModels, resolveVoice } from "../src/live/openrouter/catalog";
import { runTurn, systemMessage } from "../src/live/voice/turn";
import { DEFAULT_OPENROUTER_SETTINGS, reasoningOption } from "../src/live/openrouter/settings";
import { rmsFromFloat } from "../src/live/voice/audio-codec";
import { DEFAULT_VAD, VoiceActivityDetector } from "../src/live/voice/vad";
import { BROWSER_TOOLS } from "../src/background/tab-tools";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY before running this script.");
  process.exit(1);
}

const chatModel = process.env.OPENROUTER_CHAT_MODEL ?? "deepseek/deepseek-v4.1-flash";
const speechModelId = process.env.OPENROUTER_SPEECH_MODEL ?? "x-ai/grok-voice-tts-1.0";
const transcriptionModel = process.env.OPENROUTER_TRANSCRIPTION_MODEL ?? "x-ai/grok-stt-1.0";

const QUESTION = "What is on the page right now? Read it to me.";
const PAGE_FIXTURE = [
  "Page: VoiceAgent settings",
  "URL: chrome-extension://kkjndknkgijfcmkhkjoongomkfhbkcil/options/index.html",
  "",
  "Settings",
  "Voice engine",
  "ChatGPT account",
  "OpenRouter",
  "Voice configuration",
  "",
  "Controls:",
  '#openrouter-key — input "API key"',
  "#openrouter-chat — select",
  "#openrouter-voice — select",
].join("\n");

function elapsed(startedAt: number): string {
  return `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
}

async function probeDuration(path: string): Promise<string> {
  const process_ = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration,format_name", "-of", "json", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(process_.stdout).text();
  await process_.exited;
  try {
    const info = JSON.parse(out) as { format?: { duration?: string; format_name?: string } };
    return `${Number(info.format?.duration ?? 0).toFixed(2)}s ${info.format?.format_name ?? "?"}`;
  } catch {
    return "unreadable";
  }
}

/** Words shared between what was asked and what was heard, as a rough fidelity score. */
function overlap(expected: string, heard: string): string {
  const words = (text: string) =>
    new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(word => word.length > 2));
  const wanted = words(expected);
  const got = words(heard);
  const hits = [...wanted].filter(word => got.has(word)).length;
  return `${hits}/${wanted.size} key words`;
}

console.log("1. Catalog");
const started = performance.now();
const speechModels = await fetchSpeechModels();
const transcriptionModels = await fetchTranscriptionModels();
const voice = resolveVoice(speechModels.find(model => model.id === speechModelId), "");
console.log(`   ${speechModels.length} speech models, ${transcriptionModels.length} transcription models (${elapsed(started)})`);
console.log(`   ${speechModelId} voice: ${voice}`);

console.log("\n2. Detector against a synthetic utterance");
{
  const detector = new VoiceActivityDetector(DEFAULT_VAD);
  const events: string[] = [];
  // Leading silence lets the floor settle, then a tone, then trailing silence. The
  // envelope is fed through the real detector and the real RMS maths, at the real
  // frame interval.
  for (const [amplitude, frames] of [[0, 8], [0.3, 12], [0, 15]] as [number, number][]) {
    for (let frame = 0; frame < frames; frame += 1) {
      const samples = new Float32Array(800);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = amplitude === 0 ? 0 : amplitude * Math.sin((2 * Math.PI * 220 * index) / 16000);
      }
      const event = detector.push(rmsFromFloat(samples));
      if (event) events.push(event.type === "speech-end" ? `speech-end@${event.speechMs}ms` : event.type);
    }
  }
  console.log(`   events: ${events.join(", ") || "(none)"}`);
  if (events[0] !== "speech-start" || !events[1]?.startsWith("speech-end")) {
    console.error("   the detector did not follow the envelope");
    process.exit(1);
  }
}

console.log("\n3. Text to speech (the stand-in microphone)");
let stage = performance.now();
const questionAudio = await createSpeech({ apiKey, model: speechModelId, input: QUESTION, voice, format: "mp3" });
console.log(`   asked "${QUESTION}"`);
console.log(`   synthesized ${questionAudio.byteLength} bytes (${elapsed(stage)})`);
await Bun.write("/tmp/voice-loop-question.mp3", questionAudio);

console.log("\n4. Speech to text");
stage = performance.now();
const transcript = await createTranscription({
  apiKey,
  model: transcriptionModel,
  audioBase64: Buffer.from(questionAudio).toString("base64"),
  format: "mp3",
});
console.log(`   heard "${transcript.trim()}" (${elapsed(stage)})`);
console.log(`   fidelity: ${overlap(QUESTION, transcript)}`);

console.log("\n5. Agent turn with real tool definitions");
stage = performance.now();
const toolCalls: { name: string; args: string }[] = [];
const turn = await runTurn(
  {
    chat: (messages, tools) =>
      createChatCompletion({ apiKey, model: chatModel, messages, tools, reasoning: reasoningOption(DEFAULT_OPENROUTER_SETTINGS) }),
    // The browser tools need a tab, so the harness answers for them.
    executeTool: async (name, args) => {
      toolCalls.push({ name, args });
      return name === "inspect-active-tab" ? PAGE_FIXTURE : `The ${name} tool is not available in this harness.`;
    },
  },
  [systemMessage(BROWSER_TOOLS)],
  transcript.trim() || QUESTION,
  BROWSER_TOOLS,
);
console.log(`   tool calls: ${toolCalls.map(call => `${call.name}(${call.args})`).join(", ") || "(none)"}`);
console.log(`   reply: "${turn.reply}"`);
console.log(`   ${turn.toolCallCount} tool round-trips, truncated=${turn.truncated} (${elapsed(stage)})`);

if (!turn.reply.trim()) {
  console.error("   the turn produced nothing to speak");
  process.exit(1);
}

console.log("\n6. Text to speech (the reply)");
stage = performance.now();
const replyAudio = await createSpeech({ apiKey, model: speechModelId, input: turn.reply, voice, format: "mp3" });
console.log(`   synthesized ${replyAudio.byteLength} bytes (${elapsed(stage)})`);
await Bun.write("/tmp/voice-loop-reply.mp3", replyAudio);

console.log("\n7. Audio validation");
console.log(`   question: ${await probeDuration("/tmp/voice-loop-question.mp3")}`);
console.log(`   reply:    ${await probeDuration("/tmp/voice-loop-reply.mp3")}`);

console.log("\nThe whole loop answered end to end.");
