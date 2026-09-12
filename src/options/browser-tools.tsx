import { useCallback, useEffect, useState } from "react";
import { ArrowClockwiseIcon, BrowserIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { PageSnapshot, TabAction, TabToolRequest, TabToolResponse } from "@/lib/tab-tools";

type TargetTab = { id: number; title: string; url: string; windowId: number; lastAccessed: number };

function isSupportedPage(tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & { id: number; url: string } {
  return typeof tab.id === "number" && typeof tab.url === "string" && /^https?:\/\//.test(tab.url);
}

export function BrowserToolsSection() {
  const [tabs, setTabs] = useState<TargetTab[]>([]);
  const [tabId, setTabId] = useState<number | "">("");
  const [snapshot, setSnapshot] = useState<PageSnapshot | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [selector, setSelector] = useState("");
  const [text, setText] = useState("");
  const [highlightSeconds, setHighlightSeconds] = useState(8);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadTabs = useCallback(async () => {
    const available = (await chrome.tabs.query({}))
      .filter(isSupportedPage)
      .map(tab => ({
        id: tab.id,
        title: tab.title || "Untitled page",
        url: tab.url,
        windowId: tab.windowId,
        lastAccessed: tab.lastAccessed ?? 0,
      }))
      .sort((a, b) => b.lastAccessed - a.lastAccessed);
    setTabs(available);
    setTabId(current => current !== "" && available.some(tab => tab.id === current) ? current : available[0]?.id ?? "");
  }, []);

  useEffect(() => {
    const refresh = () => void loadTabs();
    void loadTabs();
    chrome.tabs.onCreated.addListener(refresh);
    chrome.tabs.onRemoved.addListener(refresh);
    chrome.tabs.onUpdated.addListener(refresh);
    return () => {
      chrome.tabs.onCreated.removeListener(refresh);
      chrome.tabs.onRemoved.removeListener(refresh);
      chrome.tabs.onUpdated.removeListener(refresh);
    };
  }, [loadTabs]);

  async function send(request: TabToolRequest): Promise<TabToolResponse> {
    if (tabId === "") return { ok: false, error: "Select a browser tab first." };
    try {
      return await chrome.runtime.sendMessage({ ...request, tabId });
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : "The browser tool is unavailable." };
    }
  }

  async function inspect() {
    setBusy("inspect"); setError(null);
    const response = await send({ type: "inspect-active-tab" });
    setBusy(null);
    if (response.ok && response.snapshot) setSnapshot(response.snapshot);
    else setError(response.ok ? "No page content was returned." : response.error);
  }

  async function capture() {
    if (tabId === "") { setError("Select a browser tab first."); return; }
    setBusy("capture"); setError(null);
    try {
      const target = tabs.find(tab => tab.id === tabId);
      if (target) {
        await chrome.windows.update(target.windowId, { focused: true });
        await chrome.tabs.update(tabId, { active: true });
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      const response = await send({ type: "capture-active-tab" });
      if (response.ok && response.screenshot) setScreenshot(response.screenshot);
      else setError(response.ok ? "No screenshot was returned." : response.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The tab could not be captured.");
    } finally {
      setBusy(null);
    }
  }

  async function act(action: TabAction) {
    setError(null);
    const response = await send({ type: "act-on-active-tab", action });
    if (!response.ok) setError(response.error);
  }

  const selected = tabs.find(tab => tab.id === tabId);

  return (
    <section id="browser-tools" aria-labelledby="browser-tools-title" className="scroll-mt-6">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <BrowserIcon size={22} weight="fill" aria-hidden="true" />
        </span>
        <div>
          <h2 id="browser-tools-title" className="text-lg font-semibold">Browser tools</h2>
          <p className="text-xs text-muted-foreground">Inspect and test a specific browser tab</p>
        </div>
      </div>

      <div className="mt-5 grid gap-2">
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1 text-sm font-medium" htmlFor="browser-target">
            Target tab
            <select
              id="browser-target"
              className="mt-2 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              value={tabId}
              onChange={event => {
                setTabId(event.target.value ? Number(event.target.value) : "");
                setSnapshot(null);
                setScreenshot(null);
                setError(null);
              }}
            >
              {!tabs.length && <option value="">No supported tabs open</option>}
              {tabs.map(tab => <option key={tab.id} value={tab.id}>{tab.title}</option>)}
            </select>
          </label>
          <Button variant="outline" size="icon" onClick={() => void loadTabs()} aria-label="Refresh tab list" title="Refresh tab list">
            <ArrowClockwiseIcon aria-hidden="true" />
          </Button>
        </div>
        {selected && <p className="truncate text-xs text-muted-foreground" title={selected.url}>{selected.url}</p>}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button onClick={() => void inspect()} disabled={tabId === "" || busy !== null}>{busy === "inspect" ? "Reading…" : "Read selected tab"}</Button>
        <Button variant="secondary" onClick={() => void capture()} disabled={tabId === "" || busy !== null}>{busy === "capture" ? "Capturing…" : "Capture selected tab"}</Button>
      </div>
      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">Capturing briefly focuses the selected tab. Return to Settings to view the result.</p>

      {snapshot && <div className="mt-4 rounded-lg border border-border bg-secondary/30 p-3 text-xs leading-5">
        <p className="font-semibold">{snapshot.title || "Untitled page"}</p>
        <p className="truncate text-muted-foreground">{snapshot.url}</p>
        <p className="mt-2 text-muted-foreground">{snapshot.text.slice(0, 500) || "No visible text"}</p>
        <p className="mt-2 text-muted-foreground">{snapshot.interactiveElements.length} interactive elements found</p>
      </div>}
      {screenshot && <img className="mt-4 max-h-80 w-full rounded-lg border border-border object-contain" src={screenshot} alt="Screenshot of the selected browser tab" />}

      <Separator className="my-5" />
      <div className="grid gap-3">
        <input className="h-10 rounded-lg border bg-background px-3 text-sm" value={selector} onChange={event => setSelector(event.target.value)} placeholder="CSS selector, e.g. button[type=submit]" aria-label="CSS selector" />
        <input className="h-10 rounded-lg border bg-background px-3 text-sm" value={text} onChange={event => setText(event.target.value)} placeholder="Text to enter or highlight label" aria-label="Text to enter" />
        <label className="grid gap-2 text-sm font-medium">Highlight duration (seconds)
          <input className="h-10 rounded-lg border bg-background px-3 text-sm" type="number" min="1" max="60" value={highlightSeconds} onChange={event => setHighlightSeconds(Number(event.target.value))} />
        </label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Button variant="secondary" onClick={() => void act({ kind: "click", selector })} disabled={!selector || tabId === ""}>Click</Button>
          <Button variant="secondary" onClick={() => void act({ kind: "type", selector, text })} disabled={!selector || tabId === ""}>Type</Button>
          <Button variant="secondary" onClick={() => void act({ kind: "highlight", selector, label: text || undefined, durationSeconds: highlightSeconds })} disabled={!selector || tabId === ""}>Highlight</Button>
          <Button variant="secondary" onClick={() => void act({ kind: "request-user-action", selector, message: text || "Please complete this action", durationSeconds: highlightSeconds })} disabled={!selector || tabId === ""}>Ask user</Button>
          <Button variant="secondary" onClick={() => void act({ kind: "scroll", deltaY: 600 })} disabled={tabId === ""}>Scroll down</Button>
        </div>
      </div>
      {error && <p role="alert" className="notice-enter mt-4 text-sm leading-5 text-destructive">{error}</p>}
    </section>
  );
}
