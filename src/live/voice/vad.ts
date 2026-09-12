/**
 * Energy-based voice activity detection.
 *
 * Deliberately not a learned VAD: it runs on every analyzer frame in the offscreen
 * document with no model download. The tradeoff is sensitivity to background noise,
 * which is handled by measuring the room instead of guessing at it.
 *
 * Thresholds are relative to a learned noise floor, not fixed. Fixed levels cannot
 * work across devices: a laptop mic with gain applied can idle above the level a
 * quiet headset reaches while someone is talking. The floor is measured during a
 * short calibration window before listening starts, then tracked slowly while the
 * room is quiet, so a fan or an air conditioner does not look like a voice.
 *
 * Two thresholds rather than one. Speech has to be clearly above the floor to start
 * an utterance but only needs to stay above a lower bar to continue, so a quiet
 * syllable mid-sentence does not end the turn. Removing that hysteresis is the
 * difference between transcribing a sentence and transcribing its loudest word.
 */

export type VadConfig = {
  /** Audio observed before listening begins, used to measure the noise floor. */
  calibrationMs: number;
  /** Speech must exceed the noise floor by this factor to start an utterance. */
  speechRatio: number;
  /** Lower factor that keeps an utterance alive. Must be below `speechRatio`. */
  silenceRatio: number;
  /** Sensitivity ceiling: nothing quieter than this counts as speech, however still the room. */
  minSpeechRms: number;
  /** Lower bound for the hysteresis threshold. */
  minSilenceRms: number;
  /** Upper bound on the learned floor, so a loud room cannot put speech out of reach. */
  maxFloorRms: number;
  /** How quickly the floor follows a changing room, per frame, while quiet. */
  floorAdaptRate: number;
  /** Voiced audio required before an utterance counts, which drops clicks and pops. */
  minSpeechMs: number;
  /** Silence required before an utterance is considered finished. */
  endSilenceMs: number;
  /** A monologue longer than this is cut, so capture can never get stuck open. */
  maxUtteranceMs: number;
  /** Duration of one analyzer frame. */
  frameMs: number;
};

export const DEFAULT_VAD: VadConfig = {
  calibrationMs: 600,
  speechRatio: 3,
  silenceRatio: 1.8,
  minSpeechRms: 0.02,
  minSilenceRms: 0.012,
  maxFloorRms: 0.04,
  floorAdaptRate: 0.05,
  minSpeechMs: 250,
  endSilenceMs: 800,
  maxUtteranceMs: 30_000,
  frameMs: 50,
};

export type VadEvent = { type: "speech-start" } | { type: "speech-end"; speechMs: number };

export type VadThresholds = { floor: number; speechRms: number; silenceRms: number };

type Phase = "calibrating" | "silence" | "starting" | "speech" | "trailing";

/** Median resists a cough or a door slam during calibration, where a mean would not. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export class VoiceActivityDetector {
  private phase: Phase;
  private voicedMs = 0;
  private speechMs = 0;
  private silentMs = 0;
  private floor = 0;
  private calibration: number[] = [];
  private readonly calibrationFrames: number;

  constructor(private readonly config: VadConfig = DEFAULT_VAD) {
    this.calibrationFrames = Math.max(0, Math.round(config.calibrationMs / config.frameMs));
    // Tests and callers that already know the room can pass calibrationMs: 0.
    this.phase = this.calibrationFrames > 0 ? "calibrating" : "silence";
  }

  /** True until the room has been measured. */
  get isCalibrating(): boolean {
    return this.phase === "calibrating";
  }

  /** The current decision levels, derived from the learned floor. */
  thresholds(): VadThresholds {
    return {
      floor: this.floor,
      speechRms: Math.max(this.config.minSpeechRms, this.floor * this.config.speechRatio),
      silenceRms: Math.max(this.config.minSilenceRms, this.floor * this.config.silenceRatio),
    };
  }

  /** Clears utterance progress. The learned floor is kept, so the room is not re-measured. */
  reset(): void {
    this.voicedMs = 0;
    this.speechMs = 0;
    this.silentMs = 0;
    if (this.phase !== "calibrating") this.phase = "silence";
  }

  /** Discards the learned floor and measures the room again. */
  recalibrate(): void {
    this.floor = 0;
    this.calibration = [];
    this.reset();
    this.phase = this.calibrationFrames > 0 ? "calibrating" : "silence";
  }

  /**
   * Feeds one frame. Returns an event only on a transition, so callers can drive the
   * recorder from transitions instead of re-checking state every frame.
   */
  push(rms: number): VadEvent | null {
    if (this.phase === "calibrating") {
      this.calibration.push(rms);
      if (this.calibration.length >= this.calibrationFrames) {
        this.floor = Math.min(median(this.calibration), this.config.maxFloorRms);
        this.calibration = [];
        this.phase = "silence";
      }
      return null;
    }

    const { frameMs, minSpeechMs, endSilenceMs, maxUtteranceMs } = this.config;
    const { speechRms, silenceRms } = this.thresholds();
    const loud = rms >= speechRms;
    const stillVoiced = rms >= silenceRms;

    switch (this.phase) {
      case "silence":
        this.trackFloor(rms);
        if (!loud) return null;
        this.phase = "starting";
        this.voicedMs = frameMs;
        this.speechMs = frameMs;
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
        } else {
          this.silentMs = frameMs;
          this.phase = "trailing";
        }
        return this.cutOffIfTooLong();

      case "trailing":
        this.speechMs += frameMs;
        if (stillVoiced) {
          // Speech resumed, so the pause was just a pause.
          this.silentMs = 0;
          this.phase = "speech";
          return this.cutOffIfTooLong();
        }
        this.silentMs += frameMs;
        if (this.silentMs >= endSilenceMs) {
          const speechMs = this.speechMs - this.silentMs;
          this.reset();
          return { type: "speech-end", speechMs: Math.max(0, speechMs) };
        }
        return this.cutOffIfTooLong();
    }

    return null;
  }

  /**
   * Ends a monologue that has run past the limit. Without this, a room that keeps
   * generating noise above the threshold holds capture open indefinitely.
   */
  private cutOffIfTooLong(): VadEvent | null {
    if (this.speechMs < this.config.maxUtteranceMs) return null;
    const speechMs = this.speechMs - this.silentMs;
    this.reset();
    return { type: "speech-end", speechMs: Math.max(0, speechMs) };
  }

  /**
   * Follows a changing room, but only from frames that are not speech, so a long
   * utterance cannot teach the detector that talking is the new baseline.
   */
  private trackFloor(rms: number): void {
    if (rms >= this.thresholds().speechRms) return;
    const { floorAdaptRate, maxFloorRms } = this.config;
    const next = this.floor + (rms - this.floor) * floorAdaptRate;
    this.floor = Math.max(0, Math.min(maxFloorRms, next));
  }
}
