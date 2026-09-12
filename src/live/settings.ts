/** Which voice engine the extension uses. The two share only the settings page and the agent tools. */

const STORAGE_KEY = "voice-engine";

export type VoiceEngine = "chatgpt" | "openrouter";

export const DEFAULT_ENGINE: VoiceEngine = "chatgpt";

export async function readEngine(): Promise<VoiceEngine> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  return stored === "openrouter" ? "openrouter" : DEFAULT_ENGINE;
}

export async function writeEngine(engine: VoiceEngine): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: engine });
}
