import { expect, test } from "bun:test";
import { LOG_LIMIT, LogStore, errorDetails, sanitizeLog, type LogEntry } from "./diagnostics";

test("logs retain only diagnostic metadata, never payloads or raw errors", () => {
  const entry = sanitizeLog({ level: "error", source: "model", event: "request-failed", details: {
    status: 401, taskId: "task-1", prompt: "private words", Authorization: "Bearer secret", token: "secret",
    body: "private page", url: "https://example.com/?key=secret", errorName: "Error: Bearer secret",
    ...errorDetails(new Error("private words Bearer secret")),
  } })!;
  expect(entry.details).toEqual({ status: 401, taskId: "task-1", errorName: "Error" });
  expect(JSON.stringify(entry)).not.toContain("secret");
  expect(sanitizeLog({ level: "nonsense" })).toBeNull();
});
test("store serializes concurrent sources, bounds retention, and orders Clear", async () => {
  let rows: LogEntry[] = [];
  const store = new LogStore({ get: async () => [...rows], set: async entries => { rows = entries; } });
  await Promise.all(Array.from({ length: LOG_LIMIT + 5 }, (_, count) => store.append(sanitizeLog({ level: "info", source: "test", event: "event", details: { count } })!)));
  expect((await store.read()).length).toBe(LOG_LIMIT);
  expect(rows[0]!.details.count).toBe(5);
  const clear = store.clear();
  const append = store.append(sanitizeLog({ level: "error", source: "test", event: "after-clear" })!);
  await Promise.all([clear, append]);
  expect((await store.read()).map(row => row.event)).toEqual(["after-clear"]);
});
test("a storage failure does not poison subsequent writes", async () => {
  let fail = true;
  let rows: LogEntry[] = [];
  const store = new LogStore({ get: async () => rows, set: async entries => { if (fail) { fail = false; throw new Error("quota"); } rows = entries; } });
  const entry = sanitizeLog({ level: "info", source: "test", event: "retry" })!;
  await expect(store.append(entry)).rejects.toThrow("quota");
  await store.append(entry);
  expect(await store.read()).toHaveLength(1);
});
