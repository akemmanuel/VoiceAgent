/**
 * Energy-based voice activity detection.
 *
 * Deliberately not a learned VAD: it runs on every analyzer frame in the offscreen
 * document with no model download. The cost is sensitivity to background noise,
 * which is handled by measuring the room continuously instead of trusting fixed
 * levels. A laptop microphone with gain applied can idle above the level a quiet
 * headset reaches while someone is talking, so absolute thresholds cannot work.
 *
 * The design follows the silence detector that already runs in production in
 * `dezarpa/runtime/browser.ts`, which has handled real microphones for months:
 *
 * - The ambient floor falls quickly toward any quieter frame and rises slowly, so a
 *   speech burst cannot drag it up while a room that genuinely got louder still
 *   raises it.
 * - Onset is a multiple of the floor, so a noisy room requires proportionally louder
 *   speech rather than misfiring.
 * - The stop level is clamped so it can never exceed the onset, which keeps the two
 *   levels correctly ordered however the floor moves.
 *
 * Two differences for a conversation rather than a recording. Utterances are
 * reported as boundaries so turn-taking can react to them, and an onset must persist
 * for `minSpeechMs` of genuinely loud frames. The earlier version accumulated that
 * duration on frames that merely cleared the stop level and then used the wrong
 * counter, so a room sitting between the two levels produced an endless stream of
 * false onsets, each opening a capture that nothing could close.
 */

export type VadConfig = {
  /** Onset must exceed the ambient floor by this factor. */
  onsetRatio: number;
  /** Onset is never below this, so a silent room does not become hypersensitive. */
  minOnsetRms: number;
  /** The level that keeps an utterance alive is at least this. */
  minStopRms: number;
  /** Stop level as a multiple of the floor. Clamped to never reach the onset. */
  stopRatio: number;
  /** Blend applied per frame when a frame is quieter than the floor. */
  floorFallBlend: number;
  /** Fraction of the gap the floor closes per frame while quiet. */
  floorRiseRate: number;
  /**
   * Rise rate used when a frame is already loud enough to be speech. Much slower, so
   * a long sentence barely moves the floor while a genuinely loud room still lifts it.
   */
  floorRiseRateWhileLoud: number;
  minFloorRms: number;
  maxFloorRms: number;
  /** Loud audio required before an onset counts, which drops clicks and pops. */
  minSpeechMs: number;
  /** Quiet required after speech before the utterance is considered finished. */
  endSilenceMs: number;
  /** A monologue longer than this is cut, so capture can never get stuck open. */
  maxUtteranceMs: number;
  /** Time spent gathering an onset before giving up and returning to idle. */
  stallMs: number;
  /** Duration of one analyzer frame. */
  frameMs: number;
};

export const DEFAULT_VAD: VadConfig = {
  onsetRatio: 2.5,
  minOnsetRms: 0.012,
  minStopRms: 0.02,
  stopRatio: 1.5,
  floorFallBlend: 0.3,
  floorRiseRate: 0.02,
  floorRiseRateWhileLoud: 0.002,
  minFloorRms: 0.001,
  maxFloorRms: 0.5,
  minSpeechMs: 250,
  endSilenceMs: 800,
  maxUtteranceMs: 30_000,
  stallMs: 1_500,
  frameMs: 100,
};

export type VadEvent = { type: "speech-start" } | { type: "speech-end"; speechMs: number };

export type VadThresholds = { floor: number; onsetRms: number; stopRms: number };

type Phase = "idle" | "starting" | "speech" | "trailing";

export class VoiceActivityDetector {
  private phase: Phase = "idle";
  private voicedMs = 0;
  private speechMs = 0;
  private silentMs = 0;
  private startingMs = 0;
  /** Ambient level, or -1 before the first frame seeds it. */
  private floor = -1;

  constructor(private readonly config: VadConfig = DEFAULT_VAD) {}

  /** The current decision levels, derived from the tracked floor. */
  thresholds(): VadThresholds {
    const floor = Math.max(this.config.minFloorRms, Math.max(0, this.floor));
    const onsetRms = Math.max(this.config.minOnsetRms, floor * this.config.onsetRatio);
    // Clamped so the two levels cannot invert however the floor moves.
    const stopRms = Math.min(Math.max(this.config.minStopRms, floor * this.config.stopRatio), onsetRms);
    return { floor, onsetRms, stopRms };
  }

  /** True while an utterance is being captured. */
  get isCapturing(): boolean {
    return this.phase === "speech" || this.phase === "trailing";
  }

  /** Clears utterance progress. The learned floor is kept, so the room is not re-measured. */
  reset(): void {
    this.phase = "idle";
    this.voicedMs = 0;
    this.speechMs = 0;
    this.silentMs = 0;
    this.startingMs = 0;
  }

  /** Forgets the room and seeds the floor from the next frame. */
  recalibrate(): void {
    this.floor = -1;
    this.reset();
  }

  /**
   * Feeds one frame. Returns an event only on a transition, so callers can drive the
   * recorder from transitions instead of re-checking state every frame.
   */
  push(rms: number): VadEvent | null {
    this.trackFloor(rms);
    const { onsetRms, stopRms } = this.thresholds();
    const { frameMs, minSpeechMs, endSilenceMs, maxUtteranceMs, stallMs } = this.config;
    const loud = rms >= onsetRms;
    const voiced = rms >= stopRms;

    switch (this.phase) {
      case "idle":
        if (!loud) return null;
        this.phase = "starting";
        this.voicedMs = frameMs;
        this.speechMs = frameMs;
        this.startingMs = frameMs;
        return null;

      case "starting": {
        this.startingMs += frameMs;
        if (loud) {
          this.voicedMs += frameMs;
          this.speechMs += frameMs;
        } else if (voiced) {
          // Inside the hold band: neither progress nor reset.
          this.speechMs += frameMs;
        } else {
          // Dropped below the stop level before the onset completed: not speech.
          this.phase = "idle";
          this.voicedMs = 0;
          this.speechMs = 0;
          this.startingMs = 0;
          return null;
        }

        if (this.voicedMs >= minSpeechMs) {
          this.phase = "speech";
          this.silentMs = 0;
          return { type: "speech-start" };
        }

        // A room that sits in the hold band forever must not pin the detector here,
        // because the floor only re-tracks from the idle phase.
        if (this.startingMs >= stallMs) {
          this.phase = "idle";
          this.voicedMs = 0;
          this.speechMs = 0;
          this.startingMs = 0;
        }
        return null;
      }

      case "speech":
        this.speechMs += frameMs;
        if (voiced) {
          this.silentMs = 0;
        } else {
          this.silentMs = frameMs;
          this.phase = "trailing";
        }
        return this.cutOffIfTooLong();

      case "trailing":
        this.speechMs += frameMs;
        if (voiced) {
          // Speech resumed, so the pause was just a pause.
          this.silentMs = 0;
          this.phase = "speech";
          return this.cutOffIfTooLong();
        }
        this.silentMs += frameMs;
        if (this.silentMs >= endSilenceMs) {
          const speechMs = Math.max(0, this.speechMs - this.silentMs);
          this.reset();
          return { type: "speech-end", speechMs };
        }
        return this.cutOffIfTooLong();
    }

    return null;
  }

  /**
   * Ends a monologue that has run past the limit. Without this, a room that keeps
   * generating noise above the stop level holds capture open indefinitely.
   */
  private cutOffIfTooLong(): VadEvent | null {
    if (this.speechMs < this.config.maxUtteranceMs) return null;
    const speechMs = Math.max(0, this.speechMs - this.silentMs);
    this.reset();
    return { type: "speech-end", speechMs };
  }

  /**
   * Follows the room. Falling is fast so the floor recovers immediately from a
   * transient noise; rising is slow, and slower still on frames loud enough to be
   * speech, so one long sentence cannot teach the detector that talking is the
   * baseline while a room that genuinely got louder is still learned.
   */
  private trackFloor(rms: number): void {
    const { minFloorRms, maxFloorRms, floorFallBlend, floorRiseRate, floorRiseRateWhileLoud, minOnsetRms } = this.config;
    if (this.floor < 0) {
      this.floor = rms;
    } else if (rms < this.floor) {
      this.floor = this.floor * (1 - floorFallBlend) + rms * floorFallBlend;
    } else {
      const rate = rms >= Math.max(minOnsetRms, this.floor * this.config.onsetRatio) ? floorRiseRateWhileLoud : floorRiseRate;
      this.floor += (rms - this.floor) * rate;
    }
    this.floor = Math.max(minFloorRms, Math.min(maxFloorRms, this.floor));
  }
}
