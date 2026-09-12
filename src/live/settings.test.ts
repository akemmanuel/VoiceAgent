import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_DISPLAY_NAME, readDisplayName, writeDisplayName } from "./settings";

describe("display name settings", () => {
  const store = new Map<string, unknown>();

  beforeEach(() => {
    store.clear();
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string) => store.has(key) ? { [key]: store.get(key) } : {},
          set: async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) store.set(key, value);
          },
        },
      },
    };
  });

  test("uses a neutral name by default", async () => {
    expect(await readDisplayName()).toBe(DEFAULT_DISPLAY_NAME);
  });

  test("trims and round-trips the user's name", async () => {
    await writeDisplayName("  Ada  ");
    expect(await readDisplayName()).toBe("Ada");
  });

  test("falls back when the saved name is blank", async () => {
    store.set("display-name", "   ");
    expect(await readDisplayName()).toBe(DEFAULT_DISPLAY_NAME);
  });
});
