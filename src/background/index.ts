import type { TabToolRequest } from "@/lib/tab-tools";
import { isOffscreenEvent, isVoiceRequest } from "@/live/voice/protocol";
import { handleChatGPTMessage, handleOffscreenEvent, handleVoiceRequest, handleVoiceSettingsChanged } from "./live";
import { handleTabToolRequest } from "./tab-tools";

const TAB_TOOL_TYPES = ["inspect-active-tab", "capture-active-tab", "wait-for-active-tab", "run-automation", "act-on-active-tab"];

// The browser owns the side panel, so it survives page reloads and ordinary tab
// navigation. It deliberately uses one global panel rather than a tab-specific
// instance, keeping the agent conversation available across websites.
if ("sidePanel" in chrome) {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    // Older Chromium builds can still load the extension; they simply cannot
    // provide the persistent panel UI.
  });
}

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
    void handleVoiceRequest(message).then(sendResponse).catch(cause => sendResponse({ state: "failed", engine: "chatgpt", transcript: "", reply: "", error: cause instanceof Error ? cause.message : "Voice request failed." }));
    return true;
  }

  if (record?.type === "voice-settings-changed") {
    void handleVoiceSettingsChanged().then(() => sendResponse({ ok: true }), cause => sendResponse({ ok: false, error: cause instanceof Error ? cause.message : "Voice settings could not be applied." }));
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
