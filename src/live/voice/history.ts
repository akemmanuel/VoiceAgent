import type { ChatMessage, ToolCall } from "../openrouter/client";

/** Keep durable context well within extension storage quota and model context limits. */
export const MAX_PERSISTED_HISTORY_CHARACTERS = 200_000;

export type StoredConversation = {
  version: 1;
  history: ChatMessage[];
  transcript: string;
  reply: string;
};

function isToolCall(value: unknown): value is ToolCall {
  if (typeof value !== "object" || value === null) return false;
  const call = value as Record<string, unknown>;
  return typeof call.id === "string" && typeof call.name === "string" && typeof call.arguments === "string";
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (typeof message.content !== "string") return false;
  if (message.role === "tool") return typeof message.toolCallId === "string";
  if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") return false;
  return message.toolCalls === undefined || (Array.isArray(message.toolCalls) && message.toolCalls.every(isToolCall));
}

function characterCount(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length + ("toolCalls" in message ? message.toolCalls.reduce((sum, call) => sum + call.arguments.length + call.name.length + call.id.length, 0) : 0), 0);
}

/**
 * Large tool observations do not need to survive forever. When a conversation is
 * large, retain its system instruction and complete user/assistant dialogue turns,
 * instead of persisting partial tool-call chains that providers cannot replay.
 */
function compactHistory(history: ChatMessage[]): ChatMessage[] {
  if (characterCount(history) <= MAX_PERSISTED_HISTORY_CHARACTERS) return history;

  const system = history.find(message => message.role === "system");
  const budget = MAX_PERSISTED_HISTORY_CHARACTERS - (system?.content.length ?? 0);
  const dialogue = history.filter((message): message is Extract<ChatMessage, { role: "user" | "assistant" }> =>
    (message.role === "user" || message.role === "assistant") && !(message.role === "assistant" && "toolCalls" in message),
  );
  const retained: ChatMessage[] = [];
  let used = 0;
  for (const message of [...dialogue].reverse()) {
    if (used + message.content.length > budget) break;
    retained.unshift(message);
    used += message.content.length;
  }
  return system ? [system, ...retained] : retained;
}

export function storeConversation(history: ChatMessage[], transcript: string, reply: string): StoredConversation {
  return { version: 1, history: compactHistory(history), transcript, reply };
}

/** Reject malformed local storage rather than sending it to the model. */
export function readStoredConversation(value: unknown): StoredConversation | null {
  if (typeof value !== "object" || value === null) return null;
  const stored = value as Record<string, unknown>;
  if (stored.version !== 1 || !Array.isArray(stored.history) || !stored.history.every(isChatMessage)) return null;
  if (typeof stored.transcript !== "string" || typeof stored.reply !== "string") return null;
  if (characterCount(stored.history) > MAX_PERSISTED_HISTORY_CHARACTERS) return null;
  return { version: 1, history: stored.history, transcript: stored.transcript, reply: stored.reply };
}
