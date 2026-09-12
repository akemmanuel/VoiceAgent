/**
 * Energy-based voice activity detection.
 *
 * Deliberately not a learned VAD: it needs to run on every analyzer frame in the
 * offscreen document with no model download. The tradeoff is sensitivity to steady
 * background noise, which the caller manages by setting thresholds.
 *
 * Two thresholds rather than one. Speech has to be loud to start an utterance but
 * only needs to stay above a lower bar to continue, so a quiet syllable mid-sentence
 * does not end the turn. This hysteresis is the difference between transcribing a
 * sentence and transcribing its loudest word.
 */

export type VadConfig = {
  /** Level that starts an utterance. */
  speechRms: number;
  /** Lower level that keeps an utterance alive; must be below `speechRms`. */
  silenceRms: number;
  /** Voiced audio required before an utterance counts, which drops clicks and pops. */
  minSpeechMs: number;
  /** Silence required before an utterance is considered finished. */
  endSilenceMs: number;
  /** Duration of one analyzer frame. */
  frameMs: number;
};

export const DEFAULT_VAD: VadConfig = {
  speechRms: 0.02,
  silenceRms: 0.012,
  minSpeechMs: 250,
  endSilenceMs: 800,
  frameMs: 50,
};

export type VadEvent = { type: "speech-start" } | { type: "speech-end"; speechMs: number };

type Phase = "silence" | "starting" | "speech" | "trailing";

/** Tracks whether the caller should be recording, across a stream of levels. */
export class VoiceActivityDetector {
  private phase: Phase = "silence";
  private voicedMs = 0;
  private speechMs = 0;
  private silentMs = 0;

  constructor(private readonly config: VadConfig = DEFAULT_VAD) {}

  reset(): void {
    this.phase = "silence";
    this.voicedMs = 0;
    this.speechMs = 0;
    this.silentMs = 0;
  }

  /**
   * Feeds one frame. Returns an event only on a transition, so callers can drive the
   * recorder from transitions instead of re-checking state every frame.
   */
  push(rms: number): VadEvent | null {
    const { frameMs, speechRms, silenceRms, minSpeechMs, endSilenceMs } = this.config;
    const loud = rms >= speechRms;
    const stillVoiced = rms >= silenceRms;

    switch (this.phase) {
      case "silence":
        if (loud) {
          this.phase = "starting";
          this.voicedMs = frameMs;
          this.speechMs = frameMs;
        }
        return null;

      case "starting":
        // A short blip returns to silence without ever starting an utterance.
        if (!stillVoiced) {
          this.phase = "silence";
          this.voicedMs = 0;
          this.speechMs = 0;
          return null;
        }
        this.speechMs += frameMs;
        if (loud) this.voicedMs += frameMs;
        if (this.speechMs >= minSpeechMs) {
          this.phase = "speech";
          this.silentMs = 0;
          return { type: "speech-start" };
        }
        return null;

      case "speech":
        this.speechMs += frameMs;
        if (stillVoiced) {
          this.silentMs = 0;
          return null;
        }
        this.silentMs = frameMs;
        this.phase = "trailing";
        return null;

      case "trailing":
        this.speechMs += frameMs;
        if (stillVoiced) {
          // Speech resumed, so the pause was just a pause.
          this.silentMs = 0;
          this.phase = "speech";
          return null;
        }
        this.silentMs += frameMs;
        if (this.silentMs >= endSilenceMs) {
          const speechMs = this.speechMs - this.silentMs;
          this.reset();
          return { type: "speech-end", speechMs: Math.max(0, speechMs) };
        }
        return null;
    }
  }
}
