import { beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_CHATGPT_VOICE,
  DEFAULT_DISPLAY_NAME,
  readChatGPTVoice,
  readDisplayName,
  writeChatGPTVoice,
  writeDisplayName,
} from "./settings";

describe("ChatGPT voice settings", () => {
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
        },
      },
    };
  });

  test("uses Cove by default", async () => {
    expect(await readChatGPTVoice()).toBe(DEFAULT_CHATGPT_VOICE);
  });

  test("round-trips a supported voice", async () => {
    await writeChatGPTVoice("juniper");
    expect(await readChatGPTVoice()).toBe("juniper");
  });

  test("ignores an unsupported stored value", async () => {
    store.set("chatgpt-voice", "unsupported");
    expect(await readChatGPTVoice()).toBe(DEFAULT_CHATGPT_VOICE);
  });

  test("uses a neutral display name by default", async () => {
    expect(await readDisplayName()).toBe(DEFAULT_DISPLAY_NAME);
  });

  test("trims and round-trips the user's display name", async () => {
    await writeDisplayName("  Ada  ");
    expect(await readDisplayName()).toBe("Ada");
  });

  test("falls back when the saved display name is blank", async () => {
    store.set("display-name", "   ");
    expect(await readDisplayName()).toBe(DEFAULT_DISPLAY_NAME);
  });
});
