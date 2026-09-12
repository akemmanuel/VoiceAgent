import { useEffect, useState } from "react";
import {
  CHATGPT_VOICES,
  DEFAULT_CHATGPT_VOICE,
  readChatGPTVoice,
  writeChatGPTVoice,
  type ChatGPTVoice,
} from "@/live/settings";

function displayName(voice: ChatGPTVoice): string {
  return voice[0]!.toUpperCase() + voice.slice(1);
}

export function VoiceConfigurationSection() {
  const [voice, setVoice] = useState<ChatGPTVoice>(DEFAULT_CHATGPT_VOICE);

  useEffect(() => {
    void readChatGPTVoice().then(setVoice);
  }, []);

  function choose(next: ChatGPTVoice) {
    setVoice(next);
    void writeChatGPTVoice(next);
  }

  return (
    <section aria-labelledby="voice-title">
      <h2 id="voice-title" className="text-lg font-semibold">
        Voice configuration
      </h2>
      <p className="mt-3 max-w-prose text-sm leading-6 text-muted-foreground">
        Choose the voice used by GPT-Live when the ChatGPT subscription engine is selected.
      </p>

      <div className="mt-5">
        <label htmlFor="chatgpt-voice" className="block text-sm font-medium">
          GPT-Live voice
        </label>
        <select
          id="chatgpt-voice"
          value={voice}
          onChange={event => choose(event.target.value as ChatGPTVoice)}
          className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {CHATGPT_VOICES.map(option => (
            <option key={option} value={option}>
              {displayName(option)}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          The selection is saved automatically and is applied to the active voice session when possible.
        </p>
      </div>
    </section>
  );
}
