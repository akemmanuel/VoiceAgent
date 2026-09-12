import { log } from "@/lib/diagnostics";
import type { FetchLike } from "../auth/oauth";

export const CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";

/** Ported from Crocov2's LiveManager. Never pass credentials to the media document. */
export async function negotiateCall(
  sdp: string,
  credentials: { accessToken: string; accountId: string | null },
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const response = await fetchImpl(CALL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      ...(credentials.accountId ? { "chatgpt-account-id": credentials.accountId } : {}),
      "OpenAI-Alpha": "quicksilver=v2",
      "x-session-id": crypto.randomUUID(),
      originator: "pi",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sdp,
      session: {
        model: "gpt-live-1-codex",
        instructions: "You are VoiceAgent, a voice assistant in a browser extension. Speak naturally and briefly. Delegate browser actions, JavaScript computation, and in-memory file tasks to the client background agent. You have no direct tools. It can inspect and control tabs, run a persistent sandboxed JavaScript REPL, and read/write virtual files that last only for this voice session. It cannot access the user's disk. Commentary updates describe unfinished work; do not mistake them for final answers or claim success before a speakable result returns. Keep talking with the user while delegated work runs. Do not re-delegate a task just because it is still running. Website sends, payments, publishing and deletion require the user's final action.",
        audio: { output: { voice: "cove" } },
        delegation: { type: "client", ack_filler: true },
      },
    }),
    signal,
  });
  log(response.ok ? "info" : "error", "voice", "negotiation-response", { status: response.status });
  if (!response.ok) {
    // Do not echo raw response bodies: auth failures can include identifying data.
    const hint = response.status === 401 ? "Sign in again in settings."
      : response.status === 403 ? "This account or client may not have voice access."
      : response.status === 429 ? "The voice session limit was reached. Try again later."
      : "The voice service rejected the request. Try again later.";
    throw new Error(`ChatGPT voice returned ${response.status}. ${hint}`);
  }
  const answer = await response.text();
  if (!answer.startsWith("v=0")) throw new Error("ChatGPT returned an invalid voice connection answer.");
  return answer;
}

/** Crocov2's V3 transcript and delegation event shapes. Ignore unknown events. */
export function decodeLiveEvent(raw: string):
  | { type: "transcript"; role: "user" | "assistant"; text: string; complete: boolean }
  | { type: "delegation"; id: string; prompt: string }
  | { type: "error"; message: string }
  | null {
  let event: any;
  try { event = JSON.parse(raw); } catch { return null; }
  if (!event || typeof event !== "object") return null;
  if (event.type === "input_transcript.added" || event.type === "output_transcript.added") {
    if (typeof event.item?.text !== "string") return null;
    return { type: "transcript", role: event.type === "input_transcript.added" ? "user" : "assistant", text: event.item.text, complete: false };
  }
  if (event.type === "turn.done" && ["user", "assistant"].includes(event.turn?.role) && typeof event.turn?.transcript === "string") {
    return { type: "transcript", role: event.turn.role, text: event.turn.transcript, complete: true };
  }
  if (event.type === "delegation.created" && event.item?.type === "delegation" && event.item.target === "client" && typeof event.item.id === "string" && event.item.id.length > 0 && event.item.id.length <= 256) {
    const prompt = Array.isArray(event.item.content) ? event.item.content
      .filter((part: any) => part?.type === "input_text" && typeof part.text === "string")
      .map((part: any) => part.text).join("\n").trim() : "";
    return { type: "delegation", id: event.item.id, prompt };
  }
  if (event.type === "error") return { type: "error", message: "ChatGPT reported a voice session error. Stop and try again." };
  return null;
}

export type DelegationAppend = {
  type: "delegation.context.append";
  delegation_item_id: string;
  channel: "commentary" | "speakable";
  content: Array<{ type: "input_text"; text: string }>;
};

/** Match Codex's 500-byte V3 text chunks, without splitting a Unicode character. */
export function delegationAppends(id: string, text: string, kind: "update" | "final"): DelegationAppend[] {
  const chunks: string[] = [];
  const encoder = new TextEncoder();
  let chunk = "", bytes = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > 500) { chunks.push(chunk); chunk = ""; bytes = 0; }
    chunk += char; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map(text => ({ type: "delegation.context.append", delegation_item_id: id,
    channel: kind === "update" ? "commentary" : "speakable", content: [{ type: "input_text", text }] }));
}
