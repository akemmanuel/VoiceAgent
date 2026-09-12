import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUpRightIcon, GearSixIcon, WaveformIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

function Popup() {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <main className="p-6">
      <header className="flex items-center gap-2.5">
        <WaveformIcon size={26} weight="bold" className="text-primary" aria-hidden="true" />
        <h1 className="text-lg font-semibold tracking-tight">VoiceAgent</h1>
      </header>
      <Separator className="my-6" />
      <section aria-labelledby="starter-title">
        <h2 id="starter-title" className="text-2xl font-semibold tracking-tight">A place to start.</h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Your extension shell is ready. Voice features haven't been connected yet.
        </p>
        <Button className="mt-6 w-full" onClick={openSettings} disabled={opening}>
          <GearSixIcon aria-hidden="true" />
          {opening ? "Opening settings…" : "Open settings"}
          <ArrowUpRightIcon className="ml-auto" aria-hidden="true" />
        </Button>
        {error && <p role="alert" className="mt-3 text-sm leading-5 text-destructive">{error}</p>}
      </section>
      <p className="mt-5 text-xs leading-5 text-muted-foreground">Starter build · No microphone access</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Popup /></StrictMode>);
