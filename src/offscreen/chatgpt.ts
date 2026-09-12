import { decodeLiveEvent, unavailableDelegation } from "@/live/chatgpt/call";
import type { ChatGPTVoice } from "@/live/settings";

/** One WebRTC call. Server VAD handles speech boundaries; no local recorder or STT. */
export class ChatGPTCall {
  private peer = new RTCPeerConnection();
  private audio = new Audio();
  private stream: MediaStream | null = null;
  private channel: RTCDataChannel | null = null;
  private abort = new AbortController();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private pending = { user: "", assistant: "" };
  private completed = { user: false, assistant: false };
  private closed = false;

  constructor(private readonly sessionId: string) {}

  private async post(update: Record<string, unknown>) {
    return chrome.runtime.sendMessage({ type: "chatgpt-event", sessionId: this.sessionId, ...update });
  }

  private fail(cause: unknown) {
    if (this.closed) return;
    const message = cause instanceof Error ? cause.message : "The ChatGPT voice connection failed.";
    void this.post({ kind: "failed", message }).catch(() => {});
    this.close();
  }

  private waitFor(event: string, ready: () => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.peer.removeEventListener(event, check);
        this.abort.signal.removeEventListener("abort", cancelled);
      };
      const cancelled = () => { cleanup(); reject(new Error("Voice connection cancelled.")); };
      const check = () => {
        if (["failed", "closed"].includes(this.peer.connectionState)) {
          cleanup(); reject(new Error("The voice connection failed."));
        } else if (ready()) { cleanup(); resolve(); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error("The voice connection timed out. Check your network and retry.")); }, timeoutMs);
      this.peer.addEventListener(event, check);
      this.abort.signal.addEventListener("abort", cancelled, { once: true });
      if (this.abort.signal.aborted) cancelled(); else check();
    });
  }

  async start(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.closed) { stream.getTracks().forEach(track => track.stop()); throw new Error("Voice connection cancelled."); }
      this.stream = stream;
      this.audio.autoplay = true;
      this.audio.setAttribute("playsinline", "");
      this.peer.ontrack = event => {
        this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void this.audio.play().catch(cause => this.fail(cause));
      };
      this.peer.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(this.peer.connectionState)) this.fail(new Error("ChatGPT voice disconnected. Start a new session."));
      };
      for (const track of stream.getTracks()) {
        track.onended = () => this.fail(new Error("The microphone was disconnected."));
        this.peer.addTrack(track, stream);
      }
      this.channel = this.peer.createDataChannel("oai-events", { ordered: true });
      this.channel.onmessage = event => this.receive(String(event.data));
      this.channel.onerror = () => this.fail(new Error("ChatGPT's voice event channel failed."));
      this.channel.onclose = () => this.fail(new Error("ChatGPT ended the voice session."));
      await this.peer.setLocalDescription(await this.peer.createOffer());
      await this.waitFor("icegatheringstatechange", () => this.peer.iceGatheringState === "complete", 10_000);
      const result = await chrome.runtime.sendMessage({ type: "chatgpt-offer", sessionId: this.sessionId, sdp: this.peer.localDescription!.sdp });
      if (!result?.ok) throw new Error(result?.error ?? "ChatGPT negotiation failed.");
      if (this.closed) throw new Error("Voice connection cancelled.");
      await this.peer.setRemoteDescription({ type: "answer", sdp: result.answer });
      await this.waitFor("connectionstatechange", () => this.peer.connectionState === "connected", 15_000);
      await this.post({ kind: "connected" });
      // MV3 needs activity even during quiet conversation. If the worker lost the
      // session, stop the microphone rather than leaving an orphan call running.
      this.heartbeat = setInterval(() => {
        void this.post({ kind: "heartbeat" }).then(response => {
          if (!response?.ok) this.close();
        }).catch(() => this.close());
      }, 20_000);
    } catch (cause) {
      this.close();
      if (cause instanceof DOMException && cause.name === "NotAllowedError") {
        throw new Error("Microphone access was denied. Allow it on the VoiceAgent microphone tab and retry.");
      }
      throw cause;
    }
  }

  updateVoice(voice: ChatGPTVoice): void {
    if (this.closed || this.channel?.readyState !== "open") return;
    this.channel.send(JSON.stringify({
      type: "session.update",
      session: { audio: { output: { voice } } },
    }));
  }

  private receive(raw: string) {
    if (this.closed) return;
    const event = decodeLiveEvent(raw);
    if (!event) return;
    if (event.type === "error") { this.fail(new Error(event.message)); return; }
    if (event.type === "delegation") {
      if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(unavailableDelegation(event.id)));
      return;
    }
    if (event.complete) {
      this.pending[event.role] = event.text;
      this.completed[event.role] = true;
    } else {
      if (this.completed[event.role]) this.pending[event.role] = "";
      this.completed[event.role] = false;
      this.pending[event.role] += event.text;
    }
    void this.post({ kind: "transcript", role: event.role, text: this.pending[event.role] }).catch(() => this.close());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.channel?.readyState === "open") {
      try { this.channel.send(JSON.stringify({ type: "session.close" })); } catch { /* Already closed. */ }
    }
    this.channel?.close();
    this.peer.close();
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.audio.pause();
    (this.audio.srcObject as MediaStream | null)?.getTracks().forEach(track => track.stop());
    this.audio.srcObject = null;
  }
}
