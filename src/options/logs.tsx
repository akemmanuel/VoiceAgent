import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { LOG_KEY, LOG_LIMIT, type LogEntry, type LogLevel } from "@/lib/diagnostics";

const control = "rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";
export function LogsSection() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [level, setLevel] = useState<LogLevel | "all">("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true, version = 0;
    async function refresh() {
      const current = ++version;
      try {
        const response = await chrome.runtime.sendMessage({ type: "diagnostic-read" });
        if (!response?.ok) throw new Error();
        if (active && current === version) { setEntries(response.entries); setError(""); }
      } catch {
        if (active && current === version) setError("Couldn't load logs. Reload the extension, then reopen Settings.");
      } finally { if (active && current === version) setLoading(false); }
    }
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[LOG_KEY]) void refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    void refresh();
    return () => { active = false; chrome.storage.onChanged.removeListener(changed); };
  }, []);
  const filtered = entries.filter(entry => (level === "all" || entry.level === level) &&
    `${entry.source} ${entry.event} ${JSON.stringify(entry.details)}`.toLowerCase().includes(query.toLowerCase()));
  async function copy() {
    try { await navigator.clipboard.writeText(JSON.stringify(filtered, null, 2)); setNotice(`Copied ${filtered.length} logs.`); }
    catch { setError("Couldn't copy logs. Allow clipboard access and try again."); }
  }
  async function clear() {
    setBusy(true); setNotice("");
    try {
      const response = await chrome.runtime.sendMessage({ type: "diagnostic-clear" });
      if (!response?.ok) throw new Error();
      setNotice("Logs cleared.");
    } catch { setError("Couldn't clear logs. Reload the extension and try again."); }
    finally { setBusy(false); }
  }
  return (
    <section id="logs" aria-labelledby="logs-title" className="scroll-mt-6">
      <h2 id="logs-title" className="text-lg font-semibold">Logs</h2>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        Live diagnostics for voice connections, model requests and tools. The latest {LOG_LIMIT} entries stay on this device until cleared or replaced by newer logs.
      </p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        No tokens, audio, transcripts, page content or raw error bodies. Errors show the failing stage, error type and HTTP status when available. Copy logs to share a problem.
      </p>
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="grid gap-1.5 text-xs font-medium">Level
          <select className={control} value={level} onChange={event => setLevel(event.target.value as typeof level)}>
            <option value="all">All levels</option>
            {["error", "warn", "info", "debug"].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="grid min-w-0 flex-1 gap-1.5 text-xs font-medium">Search logs
          <input type="search" className={control} placeholder="Event, source or task ID" value={query} onChange={event => setQuery(event.target.value)} />
        </label>
        <Button variant="outline" onClick={() => void copy()} disabled={!filtered.length || busy}>Copy logs</Button>
        <Button variant="outline" onClick={() => void clear()} disabled={!entries.length || busy}>{busy ? "Clearing…" : "Clear"}</Button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <p role="status" className="mt-3 text-xs text-muted-foreground">{notice || (loading ? "Loading logs…" : `${filtered.length} of ${entries.length} logs · newest first`)}</p>
      <div className="mt-3 max-h-[32rem] overflow-auto rounded-lg border border-border" tabIndex={0} role="region" aria-label="Diagnostic entries">
        {!loading && !filtered.length ? <p className="p-5 text-sm text-muted-foreground">{entries.length ? "No logs match these filters." : "No logs yet. Start a voice session to record activity."}</p> :
          <ol className="divide-y divide-border">
            {[...filtered].reverse().map(entry => <li key={entry.id} className="px-4 py-3 text-xs">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                <time className="font-mono tabular-nums" dateTime={entry.time} title={entry.time}>{new Date(entry.time).toLocaleTimeString(undefined, { hour12: false })}</time>
                <span className={entry.level === "error" ? "font-semibold text-destructive" : "font-semibold text-foreground"}>{entry.level.toUpperCase()}</span>
                <span>{entry.source}</span>
              </div>
              <p className="mt-1.5 break-words font-mono text-foreground">{entry.event}</p>
              {Object.keys(entry.details).length > 0 && <pre className="mt-1.5 whitespace-pre-wrap break-all font-mono leading-5 text-muted-foreground">{Object.entries(entry.details).map(([key, value]) => `${key}=${value}`).join("  ")}</pre>}
            </li>)}
          </ol>}
      </div>
    </section>
  );
}
