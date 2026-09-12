import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WaveformIcon } from "@phosphor-icons/react";
import { AccountSection } from "./account";
import { BrowserToolsSection } from "./browser-tools";
import { EngineSection } from "./engine";
import { LogsSection } from "./logs";
import { OpenRouterSection } from "./openrouter";
import { ProfileSection } from "./profile";

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
          <p className="mt-3 max-w-xl text-base leading-7 text-muted-foreground">
            Configure voice and accounts, manage browser tools, or <a href="#logs" className="text-primary underline underline-offset-4">view logs</a> to troubleshoot a session.
          </p>
        </div>

        <div className="grid gap-5">
          <div className="settings-card"><ProfileSection /></div>
          <div className="settings-card"><EngineSection /></div>
          <div className="settings-card"><AccountSection /></div>
          <div className="settings-card"><OpenRouterSection /></div>
          <div className="settings-card">
            <section aria-labelledby="voice-title">
              <h2 id="voice-title" className="text-lg font-semibold">Voice configuration</h2>
              <p className="mt-3 max-w-prose text-sm leading-6 text-muted-foreground">Additional voice preferences aren't implemented yet. Microphone access is requested only when a voice session starts.</p>
            </section>
          </div>
          <div className="settings-card"><BrowserToolsSection /></div>
          <div className="settings-card"><LogsSection /></div>
        </div>

        <footer className="py-8 text-center text-xs leading-5 text-muted-foreground">Changes stay in this browser and are applied to VoiceAgent.</footer>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Options /></StrictMode>);
