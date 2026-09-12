import { describe, expect, test } from "bun:test";

import { MAX_PERSISTED_HISTORY_CHARACTERS, readStoredConversation, storeConversation } from "./history";
import type { ChatMessage } from "../openrouter/client";

describe("durable conversation history", () => {
  test("round-trips a valid conversation", () => {
    const stored = storeConversation([
      { role: "system", content: "Use the browser tools." },
      { role: "user", content: "What is on this page?" },
      { role: "assistant", content: "It is a dashboard." },
    ], "What is on this page?", "It is a dashboard.");

    expect(readStoredConversation(stored)).toEqual(stored);
  });

  test("rejects malformed storage before it reaches the model", () => {
    expect(readStoredConversation({ version: 1, history: [{ role: "tool", content: "missing id" }], transcript: "x", reply: "y" })).toBeNull();
  });

  test("keeps dialogue rather than an incomplete tool sequence when storage is large", () => {
    const largeObservation = "x".repeat(MAX_PERSISTED_HISTORY_CHARACTERS + 1);
    const history: ChatMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: "Find it" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "inspect", arguments: "{}" }] },
      { role: "tool", content: largeObservation, toolCallId: "call-1" },
      { role: "assistant", content: "I found it." },
    ];

    expect(storeConversation(history, "Find it", "I found it.").history).toEqual([
      { role: "system", content: "System" },
      { role: "user", content: "Find it" },
      { role: "assistant", content: "I found it." },
    ]);
  });
});
