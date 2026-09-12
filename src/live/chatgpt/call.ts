import type { ChatGPTVoice } from "../settings";
import type { FetchLike } from "../auth/oauth";

export const CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";

/** Ported from Crocov2's LiveManager. Never pass credentials to the media document. */
export async function negotiateCall(
  sdp: string,
  credentials: { accessToken: string; accountId: string | null },
  signal: AbortSignal,
  voice: ChatGPTVoice,
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
        instructions: "You are VoiceAgent, a voice assistant in a browser extension. Speak naturally and briefly. For browser tasks, delegate to the client. Never claim an action succeeded until its result returns. The client currently reports when a task cannot be performed.",
        audio: { output: { voice } },
        delegation: { type: "client", ack_filler: true },
      },
    }),
    signal,
  });
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
  | { type: "delegation"; id: string }
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
  if (event.type === "delegation.created" && typeof event.item?.id === "string") return { type: "delegation", id: event.item.id };
  if (event.type === "error") return { type: "error", message: "ChatGPT reported a voice session error. Stop and try again." };
  return null;
}

export function unavailableDelegation(id: string) {
  return {
    type: "delegation.context.append",
    delegation_item_id: id,
    channel: "speakable",
    content: [{ type: "input_text", text: "Browser task execution is not connected to this ChatGPT voice session yet. Tell the user the task was not performed. You can still have a spoken conversation." }],
  };
}
