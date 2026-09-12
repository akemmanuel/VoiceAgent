import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WaveformIcon } from "@phosphor-icons/react";
import { Separator } from "@/components/ui/separator";
import { AccountSection } from "./account";
import { EngineSection } from "./engine";
import { OpenRouterSection } from "./openrouter";
import { VoiceConfigurationSection } from "./voice";

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
      <EngineSection />
      <Separator className="my-8" />
      <AccountSection />
      <Separator className="my-8" />
      <OpenRouterSection />
      <Separator className="my-8" />
      <VoiceConfigurationSection />
      <Separator className="my-8" />
      <footer className="text-sm leading-6 text-muted-foreground">You can close this tab and return to the extension popup.</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Options /></StrictMode>);
