/**
 * Audio helpers for the voice loop.
 *
 * Kept free of browser APIs so the level maths can be tested directly. The offscreen
 * document feeds analyzer output in, and this module normalizes it.
 */

/**
 * Root-mean-square level of a time-domain analyzer frame, normalized to 0..1.
 *
 * The frame mean is removed before squaring. `AnalyserNode` centers silence at 128,
 * but real devices rest a few counts away from it, and a constant bias of only three
 * counts reads as 0.023 RMS — above a typical speech threshold. Left in, a silent
 * microphone with a small offset looks like continuous speech, which is exactly what
 * a level detector must never conclude.
 */
export function rmsFromByteTimeDomain(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let mean = 0;
  for (const sample of data) mean += sample;
  mean /= data.length;

  let sum = 0;
  for (const sample of data) {
    const centered = (sample - mean) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / data.length);
}

/** Root-mean-square level of float samples in -1..1, with any DC offset removed. */
export function rmsFromFloat(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let mean = 0;
  for (const sample of frame) mean += sample;
  mean /= frame.length;

  let sum = 0;
  for (const sample of frame) {
    const centered = sample - mean;
    sum += centered * centered;
  }
  return Math.sqrt(sum / frame.length);
}

/**
 * Base64 for a recorded audio blob. Built in chunks: passing a whole recording to
 * `String.fromCharCode` at once overflows the argument list on anything but a very
 * short utterance.
 */
export function bytesToBase64(bytes: Uint8Array, chunkSize = 0x8000): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
