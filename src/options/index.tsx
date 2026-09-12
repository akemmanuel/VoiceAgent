import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WaveformIcon } from "@phosphor-icons/react";
import { Separator } from "@/components/ui/separator";
import { AccountSection } from "./account";

function Options() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-10 sm:py-16">
      <header className="flex items-center gap-2.5">
        <WaveformIcon size={26} weight="bold" className="text-primary" aria-hidden="true" />
        <span className="text-lg font-semibold tracking-tight">VoiceAgent</span>
      </header>
      <h1 className="mt-12 text-3xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-3 text-base leading-7 text-muted-foreground">This is the starting point for your extension's preferences.</p>
      <Separator className="my-8" />
      <AccountSection />
      <Separator className="my-8" />
      <section aria-labelledby="voice-title">
        <h2 id="voice-title" className="text-lg font-semibold">Voice configuration</h2>
        <p className="mt-3 max-w-prose text-sm leading-6 text-muted-foreground">
          Voice preferences aren't implemented yet. The popup's tab controls use temporary access to the active tab, and this page keeps your ChatGPT tokens in local extension storage.
        </p>
      </section>
      <Separator className="my-8" />
      <footer className="text-sm leading-6 text-muted-foreground">You can close this tab and return to the extension popup.</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Options /></StrictMode>);
