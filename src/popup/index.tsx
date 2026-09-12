import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUpRightIcon, GearSixIcon, WaveformIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { PageSnapshot, TabAction, TabToolRequest, TabToolResponse } from "@/lib/tab-tools";

async function sendTabTool(request: TabToolRequest): Promise<TabToolResponse> {
  try {
    return await chrome.runtime.sendMessage(request);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "The browser tool is unavailable." };
  }
}

function Popup() {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PageSnapshot | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [selector, setSelector] = useState("");
  const [text, setText] = useState("");

  async function openSettings() {
    setOpening(true);
    setError(null);
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      setError("Settings couldn't open. Try again, or open extension options from your browser's Extensions page.");
    } finally {
      setOpening(false);
    }
  }

  async function inspectActiveTab() {
    setLoadingPage(true);
    setError(null);
    const response = await sendTabTool({ type: "inspect-active-tab" });
    setLoadingPage(false);
    if (response.ok && response.snapshot) setSnapshot(response.snapshot);
    else setError(response.ok ? "No page content was returned." : response.error);
  }

  async function act(action: TabAction) {
    setError(null);
    const response = await sendTabTool({ type: "act-on-active-tab", action });
    if (!response.ok) setError(response.error);
  }

  async function captureActiveTab() {
    setCapturing(true);
    setError(null);
    const response = await sendTabTool({ type: "capture-active-tab" });
    setCapturing(false);
    if (response.ok && response.screenshot) setScreenshot(response.screenshot);
    else setError(response.ok ? "No screenshot was returned." : response.error);
  }

  return (
    <main className="p-6">
      <header className="flex items-center gap-2.5">
        <WaveformIcon size={26} weight="bold" className="text-primary" aria-hidden="true" />
        <h1 className="text-lg font-semibold tracking-tight">VoiceAgent</h1>
      </header>
      <Separator className="my-6" />
      <section aria-labelledby="starter-title">
        <h2 id="starter-title" className="text-2xl font-semibold tracking-tight">Browser tools</h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Read the current page or test a page action. Access is granted only to the active tab when you open this popup.
        </p>
        <Button className="mt-5 w-full" onClick={inspectActiveTab} disabled={loadingPage}>
          {loadingPage ? "Reading page…" : "Read active tab"}
        </Button>
        <Button variant="secondary" className="mt-2 w-full" onClick={captureActiveTab} disabled={capturing}>
          {capturing ? "Capturing screenshot…" : "Capture visible tab"}
        </Button>
        {snapshot && <div className="mt-4 rounded-md border border-border p-3 text-xs leading-5">
          <p className="font-semibold">{snapshot.title || "Untitled page"}</p>
          <p className="truncate text-muted-foreground">{snapshot.url}</p>
          <p className="mt-2 text-muted-foreground">{snapshot.text.slice(0, 360) || "No visible text"}</p>
          <p className="mt-2 text-muted-foreground">{snapshot.interactiveElements.length} interactive elements found</p>
        </div>}
        {screenshot && <img className="mt-4 max-h-48 w-full rounded-md border border-border object-contain" src={screenshot} alt="Screenshot of the active browser tab" />}
        <div className="mt-4 grid gap-2">
          <input className="h-9 rounded-md border bg-background px-3 text-sm" value={selector} onChange={event => setSelector(event.target.value)} placeholder="CSS selector, e.g. button[type=submit]" aria-label="CSS selector" />
          <input className="h-9 rounded-md border bg-background px-3 text-sm" value={text} onChange={event => setText(event.target.value)} placeholder="Text to enter" aria-label="Text to enter" />
          <div className="grid grid-cols-3 gap-2">
            <Button variant="secondary" onClick={() => act({ kind: "click", selector })} disabled={!selector}>Click</Button>
            <Button variant="secondary" onClick={() => act({ kind: "type", selector, text })} disabled={!selector}>Type</Button>
            <Button variant="secondary" onClick={() => act({ kind: "scroll", deltaY: 600 })}>Scroll</Button>
          </div>
        </div>
        <Button className="mt-6 w-full" onClick={openSettings} disabled={opening}>
          <GearSixIcon aria-hidden="true" />
          {opening ? "Opening settings…" : "Open settings"}
          <ArrowUpRightIcon className="ml-auto" aria-hidden="true" />
        </Button>
        {error && <p role="alert" className="mt-3 text-sm leading-5 text-destructive">{error}</p>}
      </section>
      <p className="mt-5 text-xs leading-5 text-muted-foreground">No microphone access · Password fields are protected</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Popup /></StrictMode>);
