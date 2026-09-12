import { describe, expect, test } from "bun:test";

import { bytesToBase64, rmsFromByteTimeDomain, rmsFromFloat } from "./audio-codec";
import { DEFAULT_VAD, VoiceActivityDetector, type VadEvent } from "./vad";
import { reduce, type ConversationState, type VoiceAction, type VoiceEvent } from "./conversation";
import { DEFAULT_MAX_TOOL_STEPS, parseToolArguments, requestWithActivePage, runTurn, systemMessage } from "./turn";
import { isVoiceRequest } from "./protocol";
import type { ChatMessage, ChatResult, ToolDefinition } from "../openrouter/client";

const LOUD = 0.05;
const QUIET_BUT_VOICED = 0.015;
const SILENT = 0;

/**
 * Most tests care about the state machine, not about measuring a room, so they pin the
 * floor by seeding it with a known first frame.
 */
function detectorFor(overrides: Partial<typeof DEFAULT_VAD> = {}): VoiceActivityDetector {
  const detector = new VoiceActivityDetector({ ...DEFAULT_VAD, ...overrides });
  detector.recalibrate();
  return detector;
}

/** Seeds the floor from a quiet frame, so thresholds are predictable in tests. */
function seeded(overrides: Partial<typeof DEFAULT_VAD> = {}): VoiceActivityDetector {
  const detector = detectorFor(overrides);
  detector.push(0);
  return detector;
}

describe("voice request protocol", () => {
  test("accepts a written turn only when it contains text", () => {
    expect(isVoiceRequest({ type: "text-send", text: "Summarize this page" })).toBe(true);
    expect(isVoiceRequest({ type: "text-send" })).toBe(false);
    expect(isVoiceRequest({ type: "conversation-reset" })).toBe(true);
  });
});

/** Pushes frames until an event appears, so tests do not hardcode frame counts. */
function pushUntilEvent(detector: VoiceActivityDetector, level: number, limit = 60): { event: VadEvent | null; frames: number } {
  for (let frame = 1; frame <= limit; frame += 1) {
    const event = detector.push(level);
    if (event) return { event, frames: frame };
  }
  return { event: null, frames: limit };
}

describe("voice activity detection", () => {
  test("does not start an utterance for a click", () => {
    const detector = seeded();
    expect(detector.push(LOUD)).toBeNull();
    expect(pushUntilEvent(detector, SILENT, 30).event).toBeNull();

    // The blip must not have poisoned the detector: real speech still works.
    let started = false;
    for (let frame = 0; frame < 5; frame += 1) started ||= detector.push(LOUD)?.type === "speech-start";
    expect(started).toBe(true);
  });

  test("starts once speech has lasted the minimum duration", () => {
    const detector = seeded();
    detector.reset();
    const { event, frames } = pushUntilEvent(detector, LOUD);
    expect(event?.type).toBe("speech-start");
    expect(frames).toBe(Math.ceil(DEFAULT_VAD.minSpeechMs / DEFAULT_VAD.frameMs));
  });

  test("keeps an utterance alive through a quiet syllable", () => {
    const detector = seeded();
    detector.reset();
    pushUntilEvent(detector, LOUD);
    // Above silenceRms but below speechRms: this is a pause mid-sentence, not the end.
    expect(pushUntilEvent(detector, QUIET_BUT_VOICED, 20).event).toBeNull();
    expect(detector.push(LOUD)).toBeNull();
  });

  test("ends an utterance after enough trailing silence and reports its length", () => {
    const detector = seeded();
    detector.reset();
    pushUntilEvent(detector, LOUD);
    const { event } = pushUntilEvent(detector, SILENT);
    expect(event?.type).toBe("speech-end");
    if (event?.type !== "speech-end") throw new Error("expected speech-end");
    // Trailing silence is excluded from the reported speech.
    expect(event.speechMs).toBeGreaterThanOrEqual(DEFAULT_VAD.minSpeechMs);
  });

  test("treats speech resuming inside the trailing window as the same utterance", () => {
    const detector = seeded();
    detector.reset();
    pushUntilEvent(detector, LOUD);
    // Fewer silent frames than the hangover allows.
    for (let frame = 0; frame < DEFAULT_VAD.endSilenceMs / DEFAULT_VAD.frameMs - 2; frame += 1) {
      expect(detector.push(SILENT)).toBeNull();
    }
    expect(detector.push(LOUD)).toBeNull();
    // Only one utterance has been reported, so no speech-end leaked out.
    expect(pushUntilEvent(detector, SILENT).event?.type).toBe("speech-end");
  });

  test("reset clears an in-progress utterance", () => {
    const detector = seeded();
    detector.reset();
    pushUntilEvent(detector, LOUD);
    detector.reset();
    expect(pushUntilEvent(detector, SILENT, 20).event).toBeNull();
  });
});

describe("noise floor handling", () => {
  test("reads a constant, offset analyzer frame as silence", () => {
    // The bug this guards: a frame resting at 131 instead of 128 used to measure as
    // 0.023 RMS, which is above a typical speech threshold, so a silent microphone
    // looked like continuous speech.
    expect(rmsFromByteTimeDomain(new Uint8Array([131, 131, 131, 131, 131, 131]))).toBe(0);
    expect(rmsFromByteTimeDomain(new Uint8Array([128, 128, 128, 128]))).toBe(0);
    expect(rmsFromFloat(new Float32Array([0.4, 0.4, 0.4, 0.4]))).toBe(0);
  });

  test("never declares speech in a room that sits between the two levels", () => {
    // The reported bug. A room whose noise clears the stop level but never reaches the
    // onset used to accumulate the onset duration anyway, so it produced an endless
    // stream of false onsets, each opening a capture that nothing could close.
    const detector = detectorFor();
    detector.recalibrate();
    detector.push(0.03); // a frame this loud seeds the floor, so the hold band is real
    const { onsetRms, stopRms } = detector.thresholds();
    expect(stopRms).toBeLessThan(onsetRms);
    const between = (onsetRms + stopRms) / 2;

    for (let frame = 0; frame < 200; frame += 1) {
      expect(detector.push(between)).toBeNull();
    }
  });

  test("still starts on speech that is clearly above the room", () => {
    const detector = detectorFor();
    detector.recalibrate();
    detector.push(0.03);
    const { onsetRms, stopRms } = detector.thresholds();

    // Room noise between the levels is ignored; speech well above the onset is not.
    for (let frame = 0; frame < 20; frame += 1) expect(detector.push((onsetRms + stopRms) / 2)).toBeNull();
    expect(pushUntilEvent(detector, 0.4).event?.type).toBe("speech-start");
  });

  test("drops the floor quickly and lifts it slowly", () => {
    const dropping = detectorFor();
    dropping.recalibrate();
    dropping.push(0.1);
    const high = dropping.thresholds().floor;

    // One quiet frame drops the floor by about a third, so a transient noise does not
    // leave the detector deaf to normal speech afterwards.
    dropping.push(0);
    expect(dropping.thresholds().floor).toBeLessThan(high * 0.75);

    // Rising is slow: five frames at a speech level must not climb anywhere near it,
    // so one sentence cannot teach the detector that talking is the baseline.
    const rising = seeded();
    for (let frame = 0; frame < 5; frame += 1) rising.push(0.3);
    expect(rising.thresholds().floor).toBeLessThan(0.02);
  });

  test("learns a room that genuinely gets louder, but not one long sentence", () => {
    const louder = seeded();
    for (let frame = 0; frame < 400; frame += 1) louder.push(0.05);
    expect(louder.thresholds().floor).toBeGreaterThan(0.03);

    // Speech lifts the floor far more slowly, so talking does not raise the bar.
    const talking = seeded();
    for (let frame = 0; frame < 30; frame += 1) talking.push(0.3);
    expect(talking.thresholds().floor).toBeLessThan(0.05);
  });

  test("keeps the levels ordered however far the floor moves", () => {
    const detector = seeded();
    for (const level of [0, 0.005, 0.05, 0.2, 0.4]) {
      for (let frame = 0; frame < 20; frame += 1) detector.push(level);
      const { floor, onsetRms, stopRms } = detector.thresholds();
      expect(floor).toBeGreaterThanOrEqual(DEFAULT_VAD.minFloorRms);
      expect(floor).toBeLessThanOrEqual(DEFAULT_VAD.maxFloorRms);
      expect(stopRms).toBeLessThanOrEqual(onsetRms);
    }
  });

  test("cuts off a monologue so capture can never get stuck open", () => {
    const detector = seeded({ maxUtteranceMs: 600 });
    detector.reset();
    expect(pushUntilEvent(detector, LOUD).event?.type).toBe("speech-start");
    // Continuous noise above the stop level used to hold the capture open forever.
    const { event } = pushUntilEvent(detector, LOUD);
    expect(event?.type).toBe("speech-end");
  });

  test("returns to idle when an onset stalls, so the floor keeps tracking", () => {
    const detector = detectorFor({ stallMs: 400 });
    detector.recalibrate();
    detector.push(0.05);
    const { onsetRms, stopRms } = detector.thresholds();

    // A loud frame opens the onset window, then the room settles into the hold band.
    expect(detector.push(0.4)).toBeNull();
    for (let frame = 0; frame < 10; frame += 1) expect(detector.push((onsetRms + stopRms) / 2)).toBeNull();

    // Back in idle, a genuinely loud frame can open a new onset window.
    expect(pushUntilEvent(detector, 0.4).event?.type).toBe("speech-start");
  });

  test("recalibrate seeds the floor from the next frame", () => {
    const detector = seeded();
    detector.push(0.02);
    expect(detector.thresholds().floor).toBeGreaterThan(DEFAULT_VAD.minFloorRms);

    detector.recalibrate();
    expect(detector.thresholds().floor).toBe(DEFAULT_VAD.minFloorRms);
    detector.push(0.1);
    expect(detector.thresholds().floor).toBeCloseTo(0.1, 5);
  });
});

/** Runs a list of events through the reducer, returning the final state and every action. */
function runEvents(events: VoiceEvent[], from: ConversationState = "idle") {
  let state = from;
  const actions: VoiceAction[] = [];
  let error: string | null = null;
  for (const event of events) {
    const transition = reduce(state, event);
    state = transition.state;
    actions.push(...transition.actions);
    error = transition.error;
  }
  return { state, actions, error };
}

describe("conversation state machine", () => {
  test("walks a full turn from listening to speaking and back", () => {
    const { state, actions } = runEvents([
      { type: "start" },
      { type: "speech-start" },
      { type: "speech-end" },
      { type: "transcript", text: "what is on this page" },
      { type: "turn-complete", reply: "It is a settings page." },
      { type: "playback-end" },
    ]);

    expect(state).toBe("listening");
    expect(actions).toEqual([
      { type: "capture-start" },
      { type: "capture-stop" },
      { type: "run-turn", transcript: "what is on this page" },
      { type: "speak", text: "It is a settings page." },
    ]);
  });

  test("ignores an empty transcript instead of sending an empty turn", () => {
    const { state, actions } = runEvents([
      { type: "start" },
      { type: "speech-start" },
      { type: "speech-end" },
      { type: "transcript", text: "   " },
    ]);
    expect(state).toBe("listening");
    expect(actions.some(action => action.type === "run-turn")).toBe(false);
  });

  test("stays silent when the model has nothing to say", () => {
    const { state, actions } = runEvents([
      { type: "start" },
      { type: "speech-start" },
      { type: "speech-end" },
      { type: "transcript", text: "hello" },
      { type: "turn-complete", reply: "  " },
    ]);
    expect(state).toBe("listening");
    expect(actions.some(action => action.type === "speak")).toBe(false);
  });

  test("lets the user interrupt while the agent is speaking", () => {
    const { state, actions } = runEvents([
      { type: "start" },
      { type: "speech-start" },
      { type: "speech-end" },
      { type: "transcript", text: "one" },
      { type: "turn-complete", reply: "talking" },
      { type: "speech-start" },
    ]);

    expect(state).toBe("capturing");
    // Playback stops and capture starts, but the microphone is not released.
    expect(actions.slice(-2)).toEqual([{ type: "stop-playback" }, { type: "capture-start" }]);
    expect(actions).not.toContainEqual({ type: "release" });
  });

  test("cancels an in-flight turn when the user interrupts thinking", () => {
    const { state, actions } = runEvents([
      { type: "start" },
      { type: "speech-start" },
      { type: "speech-end" },
      { type: "transcript", text: "one" },
      { type: "speech-start" },
    ]);

    expect(state).toBe("capturing");
    expect(actions).toContainEqual({ type: "cancel-turn" });
    expect(actions).toContainEqual({ type: "capture-start" });
  });

  test("drops a late turn result after an interruption", () => {
    // The cancelled turn still resolves, and its reply must not be spoken.
    const afterInterrupt = runEvents([
      { type: "start" },
      { type: "speech-start" },
      { type: "speech-end" },
      { type: "transcript", text: "one" },
      { type: "speech-start" },
    ]);
    const transition = reduce(afterInterrupt.state, { type: "turn-complete", reply: "stale answer" });
    expect(transition.state).toBe("capturing");
    expect(transition.actions).toEqual([]);
  });

  test("stops from any state and releases what was running", () => {
    expect(runEvents([{ type: "start" }, { type: "stop" }])).toEqual({ state: "idle", actions: [{ type: "release" }], error: null });

    const fromSpeaking = runEvents([
      { type: "start" },
      { type: "speech-start" },
      { type: "speech-end" },
      { type: "transcript", text: "hi" },
      { type: "turn-complete", reply: "hello" },
      { type: "stop" },
    ]);
    expect(fromSpeaking.state).toBe("idle");
    expect(fromSpeaking.actions).toContainEqual({ type: "stop-playback" });
  });

  test("reports a failure and clears it on restart", () => {
    const failed = runEvents([{ type: "start" }, { type: "failed", message: "Microphone unavailable." }]);
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("Microphone unavailable.");
    expect(runEvents([{ type: "start" }], "failed")).toEqual({ state: "listening", actions: [], error: null });
  });

  test("ignores events that do not belong to the current state", () => {
    expect(reduce("idle", { type: "speech-end" }).actions).toEqual([]);
    expect(reduce("listening", { type: "playback-end" }).state).toBe("listening");
    expect(reduce("listening", { type: "transcript", text: "orphan" }).actions).toEqual([]);
  });
});

describe("agent turn", () => {
  const tools: ToolDefinition[] = [
    { name: "inspect-active-tab", description: "Read the page", parameters: { type: "object", properties: {} } },
  ];

  function chatReturning(...results: ChatResult[]) {
    let index = 0;
    return async (): Promise<ChatResult> => results[Math.min(index++, results.length - 1)]!;
  }

  test("answers directly when no tool is needed", async () => {
    const result = await runTurn(
      { chat: chatReturning({ content: "It is a settings page.", toolCalls: [] }), executeTool: async () => "" },
      systemMessage(tools) ? [systemMessage(tools)] : [],
      "what is this",
      tools,
    );

    expect(result.reply).toBe("It is a settings page.");
    expect(result.toolCallCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.history.at(-1)).toEqual({ role: "assistant", content: "It is a settings page." });
  });

  test("runs a requested tool and feeds the result back", async () => {
    const calls: { name: string; args: string }[] = [];
    const result = await runTurn(
      {
        chat: chatReturning(
          { content: "", toolCalls: [{ id: "call_1", name: "inspect-active-tab", arguments: "{}" }] },
          { content: "The tab is a settings page.", toolCalls: [] },
        ),
        executeTool: async (name, args) => {
          calls.push({ name, args });
          return "Settings — VoiceAgent";
        },
      },
      [systemMessage(tools)],
      "read the tab",
      tools,
    );

    expect(calls).toEqual([{ name: "inspect-active-tab", args: "{}" }]);
    expect(result.reply).toBe("The tab is a settings page.");
    expect(result.toolCallCount).toBe(1);
    expect(result.activity).toEqual([{ kind: "tool", tool: "inspect-active-tab", outcome: "Read the active page.", failed: false }]);
    // The assistant tool-call turn must sit between the request and the result.
    const toolMessage = result.history.find(message => message.role === "tool");
    expect(toolMessage).toEqual({ role: "tool", content: "Settings — VoiceAgent", toolCallId: "call_1" });
    expect(result.history.some(message => message.role === "assistant" && "toolCalls" in message)).toBe(true);
  });

  test("reports a failed tool back to the model instead of ending the turn", async () => {
    const result = await runTurn(
      {
        chat: chatReturning(
          { content: "", toolCalls: [{ id: "call_1", name: "inspect-active-tab", arguments: "{}" }] },
          { content: "I could not read the page.", toolCalls: [] },
        ),
        executeTool: async () => {
          throw new Error("No active tab");
        },
      },
      [],
      "read it",
      tools,
    );

    expect(result.reply).toBe("I could not read the page.");
    expect(result.history.find(message => message.role === "tool")).toEqual({
      role: "tool",
      content: "The tool failed: No active tab",
      toolCallId: "call_1",
    });
  });

  test("stops at the step limit instead of looping forever", async () => {
    let turns = 0;
    const result = await runTurn(
      {
        chat: async () => {
          turns += 1;
          return { content: "", toolCalls: [{ id: `call_${turns}`, name: "inspect-active-tab", arguments: "{}" }] };
        },
        executeTool: async () => "still here",
        maxSteps: 3,
      },
      [],
      "loop",
      tools,
    );

    expect(turns).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.reply).toBe("");
    expect(result.toolCallCount).toBe(3);
  });

  test("has enough room for a normal multi-step admin workflow", () => {
    expect(DEFAULT_MAX_TOOL_STEPS).toBe(16);
  });

  test("parses tool arguments defensively", () => {
    expect(parseToolArguments('{"selector":"#go"}')).toEqual({ selector: "#go" });
    expect(parseToolArguments("not json")).toEqual({});
    expect(parseToolArguments("[1,2]")).toEqual({});
    expect(parseToolArguments("null")).toEqual({});
  });

  test("tells the model when it has no browser tools", () => {
    expect(systemMessage([]).content).toContain("cannot act on the browser");
    expect(systemMessage(tools).content).toContain("inspect-active-tab");
    expect(systemMessage(tools).content).toContain("For downloads, decide from the request");
    expect(systemMessage(tools).content).toContain("run-automation with for-each");
    expect(systemMessage(tools).content).toContain("untrusted data");
  });

  test("supplies the active page to a turn without confusing it for user instructions", () => {
    const request = requestWithActivePage("Enable ONLYOFFICE", "Page: Nextcloud\nControls: Apps");
    expect(request).toContain("User request:\nEnable ONLYOFFICE");
    expect(request).toContain("untrusted webpage data");
    expect(request).toContain("<active-page>");
  });
});

describe("audio codec", () => {
  test("treats a flat analyzer frame as silence", () => {
    expect(rmsFromByteTimeDomain(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(rmsFromByteTimeDomain(new Uint8Array())).toBe(0);
  });

  test("reports a full-scale square wave as near maximum level", () => {
    // Byte encoding is asymmetric around 128: 0 maps to exactly -1 but 255 maps to
    // 0.992, so a hard square wave reads just under the ceiling.
    expect(rmsFromByteTimeDomain(new Uint8Array([0, 255, 0, 255]))).toBeGreaterThan(0.99);
  });

  test("matches the float equivalent", () => {
    expect(rmsFromFloat(new Float32Array([0, 0]))).toBe(0);
    expect(rmsFromFloat(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1, 5);
    expect(rmsFromFloat(new Float32Array())).toBe(0);
  });

  test("base64-encodes a recording larger than one chunk", () => {
    // 0x8000 is the chunk size, so this exercises the multi-chunk path that a
    // single String.fromCharCode call would blow up on.
    const bytes = new Uint8Array(0x8000 * 2 + 10);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
    const encoded = bytesToBase64(bytes);
    expect(encoded.length).toBe(Math.ceil(bytes.length / 3) * 4);
    expect(new Uint8Array(Buffer.from(encoded, "base64"))).toEqual(bytes);
  });
});
