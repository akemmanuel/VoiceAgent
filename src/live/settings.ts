/** Which voice engine the extension uses. The two share only the settings page and the agent tools. */

const STORAGE_KEY = "voice-engine";
export const DISPLAY_NAME_STORAGE_KEY = "display-name";

export type VoiceEngine = "chatgpt" | "openrouter";

export const DEFAULT_ENGINE: VoiceEngine = "chatgpt";
export const DEFAULT_DISPLAY_NAME = "You";

export async function readEngine(): Promise<VoiceEngine> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  return stored === "openrouter" ? "openrouter" : DEFAULT_ENGINE;
}

export async function writeEngine(engine: VoiceEngine): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: engine });
}

export async function readDisplayName(): Promise<string> {
  const stored = (await chrome.storage.local.get(DISPLAY_NAME_STORAGE_KEY))[DISPLAY_NAME_STORAGE_KEY];
  return typeof stored === "string" && stored.trim() ? stored.trim() : DEFAULT_DISPLAY_NAME;
}

export async function writeDisplayName(name: string): Promise<void> {
  await chrome.storage.local.set({ [DISPLAY_NAME_STORAGE_KEY]: name.trim().slice(0, 40) });
}
