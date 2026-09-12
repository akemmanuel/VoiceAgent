import { expect, test } from "bun:test";
import { createLunaStream, LUNA_MODEL, textPhase } from "./responses";
const credentials = { accessToken: `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }))}.test`, accountId: "account" };
const encode = (events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
const completion = { type: "response.completed", response: { id: "r1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
const call = { type: "function_call", id: "fc1", call_id: "call1", name: "test-tool", arguments: "{}", status: "completed" };
const text = (phase = "final_answer") => ({ type: "message", id: "msg1", role: "assistant", phase, content: [{ type: "output_text", text: "héllo 🌍" }] });

async function invoke(events: unknown[], fetchImpl?: Parameters<typeof createLunaStream>[1]) {
  const stream = await createLunaStream(async () => credentials, fetchImpl ?? (async () => new Response(encode(events), { headers: { "content-type": "text/event-stream" } })))(LUNA_MODEL, { messages: [] }, { signal: AbortSignal.timeout(5000), sessionId: "session" });
  const observed = [];
  for await (const event of stream) observed.push(event);
  return { result: await stream.result(), observed };
}

test("regression: real Codex sends function calls in output_item.done but empty output at completion", async () => {
  const { result } = await invoke([{ type: "response.output_item.done", output_index: 0, item: call }, completion]);
  expect(result.errorMessage).toBeUndefined();
  expect(result.stopReason).toBe("toolUse");
  expect(result.content).toContainEqual({ type: "toolCall", id: "call1|fc1", name: "test-tool", arguments: {} });
});

test("Pi sends Luna/high, subscription auth, SSE and store:false", async () => {
  let init!: RequestInit;
  await invoke([], async (url, options) => {
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
    init = options!;
    return new Response(encode([{ type: "response.output_item.done", output_index: 0, item: text() }, completion]), { headers: { "content-type": "text/event-stream" } });
  });
  const body = JSON.parse(new Headers(init.headers).get("content-encoding") === "zstd" ? new TextDecoder().decode(Bun.zstdDecompressSync(init.body as Uint8Array)) : init.body as string);
  expect(body.model).toBe("gpt-5.6-luna");
  expect(body.reasoning.effort).toBe("high");
  expect(body.stream).toBe(true); expect(body.store).toBe(false);
  expect(body.include).toContain("reasoning.encrypted_content");
  expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${credentials.accessToken}`);
});

test("Pi handles byte-fragmented Unicode SSE and preserves commentary phase", async () => {
  const bytes = new TextEncoder().encode(encode([{ type: "response.output_item.done", output_index: 0, item: text("commentary") }, completion]));
  const { result, observed } = await invoke([], async () => new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } }), { headers: { "content-type": "text/event-stream" } }));
  const block = result.content[0]!;
  expect(block.type).toBe("text");
  if (block.type === "text") { expect(block.text).toBe("héllo 🌍"); expect(textPhase(block)).toBe("commentary"); }
  expect(observed.some(event => event.type === "text_end")).toBe(true);
});

test("Pi reports truncated streams as errors instead of executing partial tools", async () => {
  const { result } = await invoke([{ type: "response.output_item.done", output_index: 0, item: call }]);
  expect(result.stopReason).toBe("error");
});

test("Pi aborts a pending request and does not retry rejected auth", async () => {
  let calls = 0;
  const { result } = await invoke([], async () => { calls++; return new Response("Unauthorized", { status: 401 }); });
  expect(result.stopReason).toBe("error"); expect(calls).toBe(1);
  const abort = new AbortController();
  const stream = await createLunaStream(async () => credentials, async (_url, init) => {
    await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    return new Response();
  })(LUNA_MODEL, { messages: [] }, { signal: abort.signal });
  setTimeout(() => abort.abort(), 5);
  expect((await stream.result()).stopReason).toBe("aborted");
});
