import type { TabToolRequest } from "@/lib/tab-tools";
import { isOffscreenEvent, isVoiceRequest } from "@/live/voice/protocol";
import { handleOffscreenEvent, handleVoiceRequest } from "./live";
import { handleTabToolRequest } from "./tab-tools";

const TAB_TOOL_TYPES = ["inspect-active-tab", "capture-active-tab", "act-on-active-tab"];

// MV3 workers can be suspended when idle, so this listener is registered at
// module scope and keeps no state of its own.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (isVoiceRequest(message)) {
    void handleVoiceRequest(message).then(sendResponse);
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
