import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WaveformIcon } from "@phosphor-icons/react";
import { AccountSection } from "./account";
import { EngineSection } from "./engine";
import { OpenRouterSection } from "./openrouter";
import { VoiceConfigurationSection } from "./voice";

function Options() {
  return (
    <main className="options-shell min-h-screen px-6 py-10 sm:py-14">
      <div className="mx-auto max-w-3xl">
        <header className="app-header flex items-center gap-3">
          <span className="brand-mark flex size-10 items-center justify-center rounded-xl text-primary-foreground">
            <WaveformIcon size={22} weight="bold" aria-hidden="true" />
          </span>
          <div>
            <span className="text-base font-semibold tracking-tight">VoiceAgent</span>
            <p className="text-xs text-muted-foreground">Control center</p>
          </div>
        </header>

        <div className="mb-8 mt-12 sm:mb-10">
          <p className="eyebrow">Personalize your agent</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Settings</h1>
          <p className="mt-3 max-w-xl text-base leading-7 text-muted-foreground">Choose how VoiceAgent listens, thinks, and responds while you browse.</p>
        </div>

        <div className="grid gap-5">
          <div className="settings-card"><EngineSection /></div>
          <div className="settings-card"><AccountSection /></div>
          <div className="settings-card"><OpenRouterSection /></div>
          <div className="settings-card"><VoiceConfigurationSection /></div>
        </div>

        <footer className="py-8 text-center text-xs leading-5 text-muted-foreground">Changes are saved in this browser and applied to VoiceAgent.</footer>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Options /></StrictMode>);
