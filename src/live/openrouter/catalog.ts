/**
 * Catalog discovery for the OpenRouter engine.
 *
 * The full `/models` list does not report which models synthesize or transcribe
 * speech: it returns every chat model and zero audio models, even though audio
 * models exist. They only appear when the request is filtered by output modality,
 * so every lookup here goes through the filtered endpoint. Filtering the full list
 * client-side silently produces an empty picker.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const MODELS_ENDPOINT = `${OPENROUTER_BASE_URL}/models`;

/** The output modality that selects text-to-speech models. */
export type AudioModality = "speech" | "transcription";

export type CatalogModel = {
  id: string;
  name: string;
  contextLength: number | null;
  /** Voices the model accepts, when the catalog reports them. */
  voices: string[];
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function toCatalogModel(entry: unknown): CatalogModel[] {
  const model = entry as {
    id?: unknown;
    name?: unknown;
    context_length?: unknown;
    supported_voices?: unknown;
  };
  if (typeof model.id !== "string") return [];
  return [
    {
      id: model.id,
      // The display name is cosmetic; fall back to the id so a picker is never blank.
      name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
      contextLength: typeof model.context_length === "number" ? model.context_length : null,
      voices: Array.isArray(model.supported_voices)
        ? model.supported_voices.filter((voice): voice is string => typeof voice === "string")
        : [],
    },
  ];
}

async function fetchCatalog(url: string, fetchImpl: FetchLike): Promise<CatalogModel[]> {
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`OpenRouter's model catalog returned ${response.status}.`);
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) return [];
  return body.data.flatMap(toCatalogModel);
}

export function fetchModels(modality: AudioModality, fetchImpl: FetchLike = fetch): Promise<CatalogModel[]> {
  return fetchCatalog(`${MODELS_ENDPOINT}?output_modalities=${modality}`, fetchImpl);
}

/** Text-to-speech models, for example `x-ai/grok-voice-tts-1.0`. */
export function fetchSpeechModels(fetchImpl: FetchLike = fetch): Promise<CatalogModel[]> {
  return fetchModels("speech", fetchImpl);
}

/** Speech-to-text models, for example `x-ai/grok-stt-1.0`. */
export function fetchTranscriptionModels(fetchImpl: FetchLike = fetch): Promise<CatalogModel[]> {
  return fetchModels("transcription", fetchImpl);
}

/** Chat models, unfiltered because the default output modality is text. */
export function fetchChatModels(fetchImpl: FetchLike = fetch): Promise<CatalogModel[]> {
  return fetchCatalog(MODELS_ENDPOINT, fetchImpl);
}

/**
 * Picks a voice the model will accept. Switching TTS models invalidates the previous
 * voice, so an unset or unsupported choice falls back to the model's first voice
 * rather than sending a value that fails at synthesis time.
 */
export function resolveVoice(model: CatalogModel | undefined, requested: string): string {
  if (model && model.voices.includes(requested)) return requested;
  return model?.voices[0] ?? requested;
}
