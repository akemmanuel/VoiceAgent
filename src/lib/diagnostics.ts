export const LOG_KEY = "diagnostic-logs";
export const LOG_LIMIT = 500;
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogEntry = {
  id: string; time: string; level: LogLevel; source: string; event: string;
  details: Record<string, string | number | boolean>;
};
// Deliberately exclude arbitrary messages, bodies, URLs, headers and tool arguments.
const FIELDS = new Set(["sessionId", "taskId", "tool", "model", "eventType", "state", "kind", "errorName", "status", "elapsedMs", "bytes", "characters", "count", "round", "pending", "stopReason", "aborted", "complete", "role"]);
const label = (value: unknown) => typeof value === "string" && /^[\w.:-]{1,100}$/.test(value) ? value : "unknown";
export function sanitizeLog(value: unknown): LogEntry | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (!["debug", "info", "warn", "error"].includes(String(input.level))) return null;
  const details: LogEntry["details"] = {};
  if (input.details && typeof input.details === "object") {
    for (const [key, item] of Object.entries(input.details)) {
      if (!FIELDS.has(key)) continue;
      if (typeof item === "number" && Number.isFinite(item) || typeof item === "boolean") details[key] = item;
      else if (typeof item === "string") details[key] = label(item);
    }
  }
  return { id: crypto.randomUUID(), time: new Date().toISOString(), level: input.level as LogLevel,
    source: label(input.source), event: label(input.event), details };
}
export function errorDetails(cause: unknown): Record<string, string | number | boolean> {
  // Error messages from providers/tools can contain prompts, page text or credentials.
  return { errorName: cause instanceof Error ? label(cause.name) : "UnknownError" };
}
let sink: ((entry: LogEntry) => void) | undefined;
export function setLogSink(next: (entry: LogEntry) => void) { sink = next; }
export function log(level: LogLevel, source: string, event: string, details: Record<string, unknown> = {}): void {
  const entry = sanitizeLog({ level, source, event, details })!;
  if (sink) { sink(entry); return; }
  if (typeof chrome !== "undefined" && chrome.runtime?.id) {
    void chrome.runtime.sendMessage({ type: "diagnostic-append", entry }).catch(() => {});
  }
}

/** One worker owns all writes, including Clear, so offscreen events cannot overwrite them. */
export class LogStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: {
    get: () => Promise<LogEntry[]>;
    set: (entries: LogEntry[]) => Promise<void>;
  }) {}
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  append(entry: LogEntry) { return this.run(async () => {
    const entries = await this.storage.get();
    await this.storage.set([...entries.slice(-(LOG_LIMIT - 1)), entry]);
  }); }
  read() { return this.run(() => this.storage.get()); }
  clear() { return this.run(() => this.storage.set([])); }
}
