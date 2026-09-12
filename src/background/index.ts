import "./diagnostics";
import type { TabToolRequest } from "@/lib/tab-tools";
import { isOffscreenEvent, isVoiceRequest } from "@/live/voice/protocol";
import { handleChatGPTMessage, handleOffscreenEvent, handleVoiceDebugReport, handleVoiceRequest } from "./live";
import { handleTabToolRequest } from "./tab-tools";

const TAB_TOOL_TYPES = ["inspect-active-tab", "capture-active-tab", "wait-for-active-tab", "run-automation", "act-on-active-tab"];

// MV3 workers can be suspended when idle, so this listener is registered at
// module scope and keeps no state of its own.
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const record = message as Record<string, unknown> | null;
  if (record?.type === "chatgpt-offer" || record?.type === "chatgpt-event") {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("offscreen/index.html")) return;
    void handleChatGPTMessage(record).then(sendResponse);
    return true;
  }
  if (isVoiceRequest(message)) {
    if (message.type === "voice-debug-report") {
      sendResponse(handleVoiceDebugReport());
      return;
    }
    void handleVoiceRequest(message).then(sendResponse).catch(cause => sendResponse({ state: "failed", engine: "chatgpt", transcript: "", reply: "", error: cause instanceof Error ? cause.message : "Voice request failed.", activity: [] }));
    return true;
  }

  if (isOffscreenEvent(message)) {
    void handleOffscreenEvent(message).then(() => sendResponse({ ok: true }));
    return true;
  }

  const request = message as TabToolRequest;
  if (!TAB_TOOL_TYPES.includes(request?.type)) return;

  void handleTabToolRequest(request).then(sendResponse);
  return true;
});
