/**
 * Audio helpers for the voice loop.
 *
 * Kept free of browser APIs so the level maths can be tested directly. The offscreen
 * document feeds analyzer output in, and this module normalizes it.
 */

/**
 * Root-mean-square level of a time-domain analyzer frame, normalized to 0..1.
 * `AnalyserNode.getByteTimeDomainData` reports silence as 128, not 0, so the
 * values are recentered before squaring.
 */
export function rmsFromByteTimeDomain(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let sum = 0;
  for (const sample of data) {
    const centered = (sample - 128) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / data.length);
}

/** Root-mean-square level of float samples in -1..1. */
export function rmsFromFloat(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
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
