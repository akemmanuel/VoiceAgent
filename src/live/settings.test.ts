import { beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_CHATGPT_VOICE,
  readChatGPTVoice,
  writeChatGPTVoice,
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
});
