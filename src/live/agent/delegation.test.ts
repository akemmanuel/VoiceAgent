import { expect, test } from "bun:test";
import type { Context, AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { DelegatedSession, runDelegation, type AgentDependencies, type DelegationUpdate } from "./delegation";

function message(text = "Done", callId?: string): AssistantMessage {
  return { role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-luna", timestamp: 1,
    content: callId ? [{ type: "toolCall", id: callId, name: "test-tool", arguments: {} }] : [{ type: "text", text }],
    stopReason: callId ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function stream(response: (context: Context, signal?: AbortSignal) => Promise<AssistantMessage>): StreamFn {
  return async (_model, context, options) => {
    const result = await response(context, options?.signal);
    const events = createAssistantMessageEventStream();
    events.push({ type: "start", partial: result });
    events.push({ type: "done", reason: result.stopReason as "stop", message: result });
    return events;
  };
}
function deps(overrides: Partial<AgentDependencies> = {}): AgentDependencies {
  return { stream: stream(async () => message()), tools: [{ name: "test-tool", description: "test", parameters: { type: "object", properties: {}, additionalProperties: false } }],
    execute: async () => "ok", publish: async () => {}, dispose() {}, ...overrides };
}
const run = (dependencies: AgentDependencies, options: { maxRounds?: number; signal?: AbortSignal } = {}) => runDelegation({ sessionId: "s", prompt: "work", history: [], deps: dependencies, signal: new AbortController().signal, update() {}, ...options });

test("Pi tool loop preserves tool results and image content across steps", async () => {
  let rounds = 0;
  const requests: Context[] = [];
  const result = await run(deps({ stream: stream(async context => { requests.push(JSON.parse(JSON.stringify(context))); return ++rounds === 1 ? message("", "call1") : message("I see it"); }),
    execute: async () => [{ type: "input_image", image_url: "data:image/png;base64,dGVzdA==", detail: "auto" }] }));
  expect(result.answer).toBe("I see it");
  expect(requests[1]!.messages.some(item => item.role === "toolResult" && item.toolCallId === "call1" && item.content[0]?.type === "image")).toBe(true);
});

test("Pi returns tool failures to Luna and the adapter bounds rounds", async () => {
  let round = 0, sawError = false;
  await expect(run(deps({ stream: stream(async context => { sawError ||= context.messages.some(item => item.role === "toolResult" && item.isError); return message("", `c${round++}`); }), execute: async () => { throw new Error("denied"); } }), { maxRounds: 2 })).rejects.toThrow("step limit");
  expect(sawError).toBe(true);
});

test("duplicate calls are blocked and an aborted tool prevents continuation", async () => {
  let executions = 0;
  await expect(run(deps({ stream: stream(async () => message("", "same")), execute: async () => { executions++; return "ok"; } }))).rejects.toThrow("repeated");
  expect(executions).toBe(1);
  const abort = new AbortController();
  await expect(run(deps({ stream: stream(async () => message("", "call")), execute: async () => { abort.abort(); return "ok"; } }), { signal: abort.signal })).rejects.toThrow();
});

test("session serializes requests, deduplicates IDs and shares history", async () => {
  const updates: DelegationUpdate[] = [];
  let calls = 0, active = 0, max = 0;
  const requests: Context[] = [];
  const session = new DelegatedSession("s", deps({ stream: stream(async context => { requests.push(JSON.parse(JSON.stringify(context))); calls++; active++; max = Math.max(max, active); await Bun.sleep(5); active--; return message(); }), publish: async update => { updates.push(update); } }));
  session.submit("a", "first"); session.submit("b", "next"); session.submit("a", "duplicate"); await session.idle();
  expect(calls).toBe(2); expect(max).toBe(1); expect(requests[1]!.messages).toHaveLength(3);
  expect(updates.some(update => update.id === "b" && update.text.includes("queued"))).toBe(true);
  expect(updates.filter(update => update.kind === "final")).toHaveLength(2); session.close();
});

test("progress arrives while Luna is unfinished, then a separate final answer", async () => {
  let finish!: (message: AssistantMessage) => void;
  const updates: DelegationUpdate[] = [];
  const session = new DelegatedSession("s", deps({ stream: stream(() => new Promise(resolve => { finish = resolve; })), publish: async update => { updates.push(update); } }), { updateMs: 5, timeoutMs: 1000 });
  session.submit("a", "work"); await Bun.sleep(20);
  expect(updates.some(update => update.text.includes("still working"))).toBe(true);
  expect(updates.every(update => update.kind === "update")).toBe(true);
  finish(message("Finished")); await session.idle();
  expect(updates.at(-1)).toEqual({ id: "a", kind: "final", text: "Finished" }); session.close();
});

test("session close aborts Luna, drops pending tasks, and suppresses late results", async () => {
  let finish!: (message: AssistantMessage) => void, requestSignal!: AbortSignal;
  let calls = 0, disposed = 0;
  const updates: DelegationUpdate[] = [];
  const session = new DelegatedSession("s", deps({ stream: stream((_context, signal) => { calls++; requestSignal = signal!; return new Promise(resolve => { finish = resolve; }); }),
    publish: async update => { updates.push(update); }, dispose() { disposed++; } }));
  session.submit("a", "work"); session.submit("b", "more"); await Bun.sleep(1); session.close(); session.close();
  expect(requestSignal.aborted).toBe(true); finish(message("late")); await session.idle();
  expect(calls).toBe(1); expect(disposed).toBe(1); expect(updates.filter(update => update.kind === "final")).toEqual([]);
});

test("timeout reports incomplete work and releases the queue", async () => {
  let calls = 0;
  const updates: DelegationUpdate[] = [];
  const session = new DelegatedSession("s", deps({ stream: stream(async (_context, signal) => {
    if (++calls > 1) return message("Second done");
    await new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    return message("never");
  }), publish: async update => { updates.push(update); } }), { updateMs: 5, timeoutMs: 20 });
  session.submit("a", "slow"); session.submit("b", "next"); await session.idle();
  expect(updates.find(update => update.id === "a" && update.kind === "final")?.text).toContain("timed out");
  expect(updates.at(-1)?.text).toBe("Second done"); session.close();
});
