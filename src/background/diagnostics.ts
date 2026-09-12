import { LOG_KEY, LogStore, log, sanitizeLog, setLogSink, type LogEntry } from "@/lib/diagnostics";

const store = new LogStore({
  get: async () => {
    const rows = (await chrome.storage.local.get(LOG_KEY))[LOG_KEY];
    return Array.isArray(rows) ? rows as LogEntry[] : [];
  },
  set: entries => chrome.storage.local.set({ [LOG_KEY]: entries }),
});
setLogSink(entry => { void store.append(entry).catch(() => console.error("VoiceAgent diagnostic storage write failed.")); });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message?.type?.startsWith("diagnostic-")) return;
  // Content scripts and web pages cannot inject or read diagnostic records.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("")) || sender.tab && !sender.tab.url?.startsWith(chrome.runtime.getURL(""))) return;
  let result: Promise<unknown>;
  if (message.type === "diagnostic-append") {
    const entry = sanitizeLog(message.entry);
    if (!entry) { respond({ ok: false }); return; }
    result = store.append(entry).then(() => ({ ok: true }));
  } else if (message.type === "diagnostic-read") result = store.read().then(entries => ({ ok: true, entries }));
  else if (message.type === "diagnostic-clear") result = store.clear().then(() => ({ ok: true }));
  else return;
  void result.then(respond, () => respond({ ok: false, error: "Diagnostic storage is unavailable. Reload the extension and try again." }));
  return true;
});
self.addEventListener("error", () => log("error", "worker", "uncaught-error"));
self.addEventListener("unhandledrejection", () => log("error", "worker", "unhandled-rejection"));
log("info", "worker", "started");
