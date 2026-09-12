/**
 * Conversation state machine for the voice loop.
 *
 * Pure and synchronous on purpose: every decision about recording, thinking, and
 * speaking lives here, and the browser-facing code only performs the actions it is
 * handed. That keeps turn-taking testable without a microphone.
 */

export type ConversationState = "idle" | "connecting" | "listening" | "capturing" | "transcribing" | "thinking" | "speaking" | "failed";

export type VoiceEvent =
  | { type: "start" }
  | { type: "stop" }
  /** The detector heard speech begin. */
  | { type: "speech-start" }
  /** The detector decided the utterance is over. */
  | { type: "speech-end" }
  | { type: "transcript"; text: string }
  | { type: "turn-complete"; reply: string }
  | { type: "playback-end" }
  | { type: "failed"; message: string };

export type VoiceAction =
  | { type: "capture-start" }
  | { type: "capture-stop" }
  /** Transcribe the recording, then feed the text back as a `transcript` event. */
  | { type: "run-turn"; transcript: string }
  | { type: "speak"; text: string }
  | { type: "stop-playback" }
  /** Abandon work in flight; the turn result must be discarded when it arrives. */
  | { type: "cancel-turn" }
  | { type: "release" };

export type VoiceTransition = {
  state: ConversationState;
  actions: VoiceAction[];
  error: string | null;
};

const ACTIVE: ConversationState[] = ["connecting", "listening", "capturing", "transcribing", "thinking", "speaking"];

export function isActive(state: ConversationState): boolean {
  return ACTIVE.includes(state);
}

export function reduce(state: ConversationState, event: VoiceEvent): VoiceTransition {
  switch (event.type) {
    case "start":
      // Starting from `failed` is a retry, so the previous error is cleared.
      return { state: "listening", actions: [], error: null };

    case "stop":
      return { state: "idle", actions: teardown(state), error: null };

    case "speech-start":
      if (state === "listening") return { state: "capturing", actions: [{ type: "capture-start" }], error: null };
      // Barge-in. The user talking over the agent outranks whatever is playing or
      // being thought about, so both are discarded and listening starts over. The
      // microphone is deliberately not released here: capture continues into the
      // new utterance.
      if (state === "speaking" || state === "thinking") {
        return { state: "capturing", actions: stopInFlight(state).concat({ type: "capture-start" }), error: null };
      }
      return { state, actions: [], error: null };

    case "speech-end":
      if (state !== "capturing") return { state, actions: [], error: null };
      return { state: "transcribing", actions: [{ type: "capture-stop" }], error: null };

    case "transcript": {
      if (state !== "transcribing") return { state, actions: [], error: null };
      const text = event.text.trim();
      // A misdetected utterance transcribes to nothing; resume listening rather than
      // sending an empty turn to the model.
      if (!text) return { state: "listening", actions: [], error: null };
      return { state: "thinking", actions: [{ type: "run-turn", transcript: text }], error: null };
    }

    case "turn-complete": {
      if (state !== "thinking") return { state, actions: [], error: null };
      const reply = event.reply.trim();
      if (!reply) return { state: "listening", actions: [], error: null };
      return { state: "speaking", actions: [{ type: "speak", text: reply }], error: null };
    }

    case "playback-end":
      if (state !== "speaking") return { state, actions: [], error: null };
      return { state: "listening", actions: [], error: null };

    case "failed":
      return { state: "failed", actions: teardown(state), error: event.message };
  }
}

/** Everything that has to stop when work is abandoned or the session ends. */
function stopInFlight(state: ConversationState): VoiceAction[] {
  const actions: VoiceAction[] = [];
  if (state === "capturing") actions.push({ type: "capture-stop" });
  if (state === "speaking") actions.push({ type: "stop-playback" });
  if (state === "transcribing" || state === "thinking") actions.push({ type: "cancel-turn" });
  return actions;
}

/** Stopping also gives the microphone back, which an interruption must not do. */
function teardown(state: ConversationState): VoiceAction[] {
  return [...stopInFlight(state), { type: "release" }];
}
