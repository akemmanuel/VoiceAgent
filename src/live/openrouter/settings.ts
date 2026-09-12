/**
 * Settings for the chained OpenRouter engine.
 *
 * The key is stored in `chrome.storage.local`, which is extension-private. It is
 * never written to source, logged, or committed; a key that leaks anywhere else has
 * to be rotated.
 */

import type { CatalogModel } from "./catalog";
import { resolveVoice } from "./catalog";

const STORAGE_KEY = "openrouter-settings";

export type OpenRouterSettings = {
  apiKey: string;
  /** Reasoning step. */
  chatModel: string;
  /** Text-to-speech model. */
  speechModel: string;
  /** Speech-to-text model. */
  transcriptionModel: string;
  /** Empty means "whichever voice the chosen speech model lists first". */
  voice: string;
};

export const DEFAULT_OPENROUTER_SETTINGS: OpenRouterSettings = {
  apiKey: "",
  chatModel: "deepseek/deepseek-v4.1-flash",
  speechModel: "x-ai/grok-voice-tts-1.0",
  transcriptionModel: "x-ai/grok-stt-1.0",
  voice: "",
};

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export async function readOpenRouterSettings(): Promise<OpenRouterSettings> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as Record<string, unknown> | undefined;
  return {
    apiKey: typeof stored?.apiKey === "string" ? stored.apiKey : DEFAULT_OPENROUTER_SETTINGS.apiKey,
    chatModel: asString(stored?.chatModel, DEFAULT_OPENROUTER_SETTINGS.chatModel),
    speechModel: asString(stored?.speechModel, DEFAULT_OPENROUTER_SETTINGS.speechModel),
    transcriptionModel: asString(stored?.transcriptionModel, DEFAULT_OPENROUTER_SETTINGS.transcriptionModel),
    voice: typeof stored?.voice === "string" ? stored.voice : DEFAULT_OPENROUTER_SETTINGS.voice,
  };
}

export async function writeOpenRouterSettings(settings: OpenRouterSettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

/** The agent cannot run a turn without a key and a model for each stage. */
export function isOpenRouterConfigured(settings: OpenRouterSettings): boolean {
  return Boolean(settings.apiKey && settings.chatModel && settings.speechModel && settings.transcriptionModel);
}

/** The voice to send, given whatever the catalog currently says the model supports. */
export function effectiveVoice(settings: OpenRouterSettings, speechModels: CatalogModel[]): string {
  return resolveVoice(
    speechModels.find(model => model.id === settings.speechModel),
    settings.voice,
  );
}
