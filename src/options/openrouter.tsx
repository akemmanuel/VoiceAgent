import { useEffect, useState } from "react";
import { ArrowSquareOutIcon, CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { fetchChatModels, fetchSpeechModels, fetchTranscriptionModels, type CatalogModel } from "@/live/openrouter/catalog";
import {
  DEFAULT_OPENROUTER_SETTINGS,
  effectiveVoice,
  readOpenRouterSettings,
  writeOpenRouterSettings,
  type OpenRouterSettings,
} from "@/live/openrouter/settings";

type Catalog = {
  chat: CatalogModel[];
  speech: CatalogModel[];
  transcription: CatalogModel[];
};

const EMPTY_CATALOG: Catalog = { chat: [], speech: [], transcription: [] };

/** A select over catalog models, with the saved choice kept visible even if the catalog lacks it. */
function ModelField({
  id,
  label,
  value,
  models,
  fallback,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  models: CatalogModel[];
  fallback: string;
  onChange: (next: string) => void;
}) {
  const known = models.some(model => model.id === value);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={event => onChange(event.target.value)}
        className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {!known && <option value={value}>{fallback}</option>}
        {models.map(model => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function OpenRouterSection() {
  const [settings, setSettings] = useState<OpenRouterSettings>(DEFAULT_OPENROUTER_SETTINGS);
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void readOpenRouterSettings().then(setSettings);
    // The catalog is public, so it loads before any key is entered.
    void Promise.all([fetchChatModels(), fetchSpeechModels(), fetchTranscriptionModels()])
      .then(([chat, speech, transcription]) => setCatalog({ chat, speech, transcription }))
      .catch((cause: unknown) => setCatalogError(cause instanceof Error ? cause.message : "The model list could not be loaded."));
  }, []);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2_000);
    return () => clearTimeout(timer);
  }, [saved]);

  function update(patch: Partial<OpenRouterSettings>) {
    setSettings(current => ({ ...current, ...patch }));
  }

  async function save() {
    await writeOpenRouterSettings(settings);
    setSaved(true);
  }

  const speechModel = catalog.speech.find(model => model.id === settings.speechModel);
  const voices = speechModel?.voices ?? [];

  return (
    <section aria-labelledby="openrouter-title">
      <h2 id="openrouter-title" className="text-lg font-semibold">
        OpenRouter
      </h2>
      <p className="mt-3 max-w-prose text-sm leading-6 text-muted-foreground">
        VoiceAgent listens with a speech-to-text model, thinks with a chat model, and answers with a text-to-speech model. Your key stays in this browser and is sent only to openrouter.ai.
      </p>

      <div className="mt-5 grid gap-4">
        <div>
          <label htmlFor="openrouter-key" className="block text-sm font-medium">
            API key
          </label>
          <input
            id="openrouter-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={settings.apiKey}
            onChange={event => update({ apiKey: event.target.value })}
            placeholder="sk-or-v1-…"
            className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          />
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Create one at openrouter.ai/keys. Rotate it if it is ever pasted anywhere else, and check your balance — a key with no credit fails at the first turn.
          </p>
        </div>

        <ModelField
          id="openrouter-chat"
          label="Reasoning model"
          value={settings.chatModel}
          models={catalog.chat}
          fallback={settings.chatModel}
          onChange={chatModel => update({ chatModel })}
        />

        <ModelField
          id="openrouter-stt"
          label="Speech-to-text model"
          value={settings.transcriptionModel}
          models={catalog.transcription}
          fallback={settings.transcriptionModel}
          onChange={transcriptionModel => update({ transcriptionModel })}
        />

        <ModelField
          id="openrouter-tts"
          label="Text-to-speech model"
          value={settings.speechModel}
          models={catalog.speech}
          fallback={settings.speechModel}
          onChange={speechModelId =>
            // The previous voice belongs to the previous model, so clear it and let
            // effectiveVoice resolve the new model's first voice.
            update({ speechModel: speechModelId, voice: "" })
          }
        />

        {voices.length > 0 && (
          <div>
            <label htmlFor="openrouter-voice" className="block text-sm font-medium">
              Voice
            </label>
            <select
              id="openrouter-voice"
              value={effectiveVoice(settings, catalog.speech)}
              onChange={event => update({ voice: event.target.value })}
              className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {voices.map(voice => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void save()}>
            {saved ? <CheckCircleIcon aria-hidden="true" /> : null}
            {saved ? "Saved" : "Save OpenRouter settings"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void chrome.tabs.create({ url: "https://openrouter.ai/keys" })}>
            <ArrowSquareOutIcon aria-hidden="true" />
            Open key page
          </Button>
        </div>

        {catalogError && (
          <p role="alert" className="flex items-start gap-2 text-sm leading-5 text-destructive">
            <WarningCircleIcon className="mt-0.5 shrink-0" aria-hidden="true" />
            {catalogError} You can still type a model name by saving the default.
          </p>
        )}
        {!catalogError && catalog.speech.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading available models…
          </p>
        )}
      </div>
    </section>
  );
}
