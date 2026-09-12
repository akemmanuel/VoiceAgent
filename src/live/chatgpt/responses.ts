import { log, errorDetails } from "@/lib/diagnostics";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";

export const DELEGATION_MODEL = "gpt-5.6-luna";
export const LUNA_MODEL = OPENAI_CODEX_MODELS[DELEGATION_MODEL];
if (!LUNA_MODEL) throw new Error("Pi's catalog does not contain gpt-5.6-luna.");
export type ToolOutput = string | Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "auto" }>;
export type AgentCredentials = { accessToken: string; accountId: string | null };

/** Pi owns SSE assembly, call IDs, images and encrypted reasoning continuity.
 * Static API import avoids dynamic import in MV3; force SSE because browser
 * WebSockets cannot attach the Codex authorization headers.
 */
export function createLunaStream(getCredentials: () => Promise<AgentCredentials>, fetchImpl?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): StreamFn {
  return async (_model, context, options) => {
    options?.signal?.throwIfAborted();
    log("debug", "model", "credentials-requested", { model: DELEGATION_MODEL });
    let credentials: AgentCredentials;
    try { credentials = await getCredentials(); }
    catch (cause) { log("error", "model", "credentials-failed", errorDetails(cause)); throw cause; }
    options?.signal?.throwIfAborted();
    return streamSimple(LUNA_MODEL, context, {
      ...options,
      apiKey: credentials.accessToken,
      headers: { ...(credentials.accountId ? { "chatgpt-account-id": credentials.accountId } : {}) },
      reasoning: "high",
      transport: "sse",
      maxRetries: 0,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        const started = Date.now();
        log("info", "model", "request-started", { model: DELEGATION_MODEL });
        let response: Response;
        try { response = await (fetchImpl ?? globalThis.fetch)(...args); }
        catch (cause) { log("error", "model", "request-failed", { elapsedMs: Date.now() - started, ...errorDetails(cause) }); throw cause; }
        log(response.ok ? "info" : "error", "model", "response-received", { status: response.status, elapsedMs: Date.now() - started });
        if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
          if (response.ok) log("warn", "model", "unexpected-response-format");
          return response;
        }
        let bytes = 0;
        // Pi 0.85's SSE parser expects LF. Normalize CRLF without decoding or
        // splitting UTF-8, and let pipeThrough propagate reader cancellation.
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            if (bytes === 0) log("debug", "model", "stream-first-bytes", { elapsedMs: Date.now() - started });
            bytes += chunk.length;
            controller.enqueue(chunk.includes(13) ? chunk.filter(byte => byte !== 13) : chunk);
          },
          flush() { log("debug", "model", "stream-ended", { bytes, elapsedMs: Date.now() - started }); },
        }));
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      }) as typeof fetch,
    });
  };
}

/** Pi preserves the Responses commentary/final phase in its text signature. */
export function textPhase(block: TextContent): "commentary" | "final_answer" | undefined {
  if (!block.textSignature) return undefined;
  try { return JSON.parse(block.textSignature).phase; } catch { return undefined; }
}
