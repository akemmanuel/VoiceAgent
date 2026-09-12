/**
 * Offscreen audio document.
 *
 * MV3 service workers cannot call `getUserMedia`, so microphone capture and
 * playback live here. This document is deliberately mechanical: it reports speech
 * boundaries and plays audio, and the worker decides what any of it means.
 */

import { ChatGPTCall } from "./chatgpt";
import { rmsFromByteTimeDomain, bytesToBase64 } from "@/live/voice/audio-codec";
import { DEFAULT_VAD, VoiceActivityDetector } from "@/live/voice/vad";
import { isOffscreenCommand, type OffscreenCommand, type OffscreenEvent } from "@/live/voice/protocol";

/** Analyzer cadence. The detector's thresholds are expressed in these units. */
const FRAME_MS = 50;

const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

let liveCall: ChatGPTCall | null = null;
let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let detector: VoiceActivityDetector | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
/** Set when the worker abandons an utterance, so the recording is dropped unheard. */
let discardRecording = false;
const playing = new Set<AudioBufferSourceNode>();

function post(event: OffscreenEvent): void {
  void chrome.runtime.sendMessage(event).catch(() => {
    // The worker is gone, so there is nothing left to notify.
  });
}

function pickRecorderType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return RECORDER_TYPES.find(type => MediaRecorder.isTypeSupported(type));
}

async function startListening(): Promise<void> {
  if (stream) return;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  context ??= new AudioContext();
  await context.resume();

  const source = context.createMediaStreamSource(stream);
  analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  // Analysed only. Connecting to the destination would play the microphone back.
  source.connect(analyser);

  detector = new VoiceActivityDetector({ ...DEFAULT_VAD, frameMs: FRAME_MS });
  timer = setInterval(onFrame, FRAME_MS);
  post({ source: "offscreen", type: "listening" });
}

function onFrame(): void {
  if (!analyser || !detector) return;
  const frame = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(frame);
  const event = detector.push(rmsFromByteTimeDomain(frame));
  if (!event) return;

  if (event.type === "speech-start") {
    discardRecording = false;
    startRecording();
    post({ source: "offscreen", type: "speech-start" });
    return;
  }
  // speech-end: the recorder already holds the utterance, so stop locally but
  // keep the audio. The worker moves to transcribing and the pending blob
  // arrives next as an utterance.
  stopRecording();
  post({ source: "offscreen", type: "speech-end" });
}

function startRecording(): void {
  if (!stream || recorder) return;
  const mimeType = pickRecorderType();
  chunks = [];
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  recorder.addEventListener("dataavailable", event => {
    if (event.data.size > 0) chunks.push(event.data);
  });

  recorder.addEventListener("stop", () => {
    const active = recorder;
    recorder = null;
    const recorded = chunks;
    chunks = [];
    const discarded = discardRecording;
    discardRecording = false;
    // The detector fired again before the recorder flushed, or the worker cancelled.
    if (discarded || !active || recorded.length === 0) return;

    void new Blob(recorded, { type: active.mimeType || "audio/webm" })
      .arrayBuffer()
      .then(buffer => {
        post({
          source: "offscreen",
          type: "utterance",
          audioBase64: bytesToBase64(new Uint8Array(buffer)),
          mimeType: active.mimeType || "audio/webm",
        });
      });
  });

  recorder.start();
}

function stopRecording(): void {
  if (!recorder || recorder.state === "inactive") return;
  recorder.stop();
}

function stopPlayback(): void {
  for (const player of playing) {
    try {
      player.stop();
    } catch {
      // Already finished.
    }
  }
  playing.clear();
}

async function play(audioBase64: string): Promise<void> {
  stopPlayback();
  context ??= new AudioContext();
  await context.resume();

  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  const decoded = await context.decodeAudioData(bytes.buffer);
  const player = context.createBufferSource();
  player.buffer = decoded;
  player.connect(context.destination);
  playing.add(player);
  player.addEventListener("ended", () => {
    playing.delete(player);
    // Only the natural end reports completion; a cancelled reply does not.
    if (playing.size === 0) post({ source: "offscreen", type: "playback-end" });
  });
  player.start();
}

async function release(): Promise<void> {
  liveCall?.close();
  liveCall = null;
  stopPlayback();
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  discardRecording = true;
  stopRecording();
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  detector = null;
  analyser = null;
  const closing = context;
  context = null;
  await closing?.close().catch(() => {
    // Already closed.
  });
}

async function handleCommand(command: OffscreenCommand): Promise<void> {
  switch (command.type) {
    case "chatgpt-start": {
      await release();
      const call = new ChatGPTCall(command.sessionId);
      liveCall = call;
      await call.start();
      return;
    }
    case "listen":
      await startListening();
      return;
    case "discard-recording":
      discardRecording = true;
      stopRecording();
      return;
    case "play":
      await play(command.audioBase64);
      return;
    case "stop-playback":
      stopPlayback();
      return;
    case "release":
      await release();
      return;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isOffscreenCommand(message)) return;
  void handleCommand(message).then(
    () => sendResponse({ ok: true }),
    (cause: unknown) => {
      const reason = cause instanceof Error ? cause.message : "The audio device failed.";
      // A denied microphone permission arrives here, and the session has to know.
      if (message.type !== "chatgpt-start" && message.type !== "listen") post({ source: "offscreen", type: "failed", message: reason });
      sendResponse({ ok: false, error: reason });
    },
  );
  return true;
});
