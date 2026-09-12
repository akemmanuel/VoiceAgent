/** Which voice engine the extension uses. The two share only the settings page and the agent tools. */

const STORAGE_KEY = "voice-engine";
const CHATGPT_VOICE_STORAGE_KEY = "chatgpt-voice";

export type VoiceEngine = "chatgpt" | "openrouter";

/** GPT-Live v1 voices supported by the ChatGPT realtime session. */
export const CHATGPT_VOICES = [
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
] as const;

export type ChatGPTVoice = (typeof CHATGPT_VOICES)[number];

export const DEFAULT_ENGINE: VoiceEngine = "chatgpt";
export const DEFAULT_CHATGPT_VOICE: ChatGPTVoice = "cove";

export async function readEngine(): Promise<VoiceEngine> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  return stored === "openrouter" ? "openrouter" : DEFAULT_ENGINE;
}

export async function writeEngine(engine: VoiceEngine): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: engine });
}

export async function readChatGPTVoice(): Promise<ChatGPTVoice> {
  const stored = (await chrome.storage.local.get(CHATGPT_VOICE_STORAGE_KEY))[CHATGPT_VOICE_STORAGE_KEY];
  return CHATGPT_VOICES.includes(stored as ChatGPTVoice) ? stored as ChatGPTVoice : DEFAULT_CHATGPT_VOICE;
}

export async function writeChatGPTVoice(voice: ChatGPTVoice): Promise<void> {
  await chrome.storage.local.set({ [CHATGPT_VOICE_STORAGE_KEY]: voice });
  try {
    await chrome.runtime?.sendMessage?.({ type: "voice-settings-changed" });
  } catch {
    // The service worker may be asleep or not listening in tests.
  }
}
