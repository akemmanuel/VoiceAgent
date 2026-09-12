import { useEffect, useState } from "react";
import { PlugsConnectedIcon, RobotIcon } from "@phosphor-icons/react";
import { DEFAULT_ENGINE, readEngine, writeEngine, type VoiceEngine } from "@/live/settings";

const OPTIONS: { value: VoiceEngine; title: string; description: string; Icon: typeof RobotIcon }[] = [
  {
    value: "chatgpt",
    title: "ChatGPT subscription",
    description: "GPT-Live speech-to-speech over one session. Needs a paid ChatGPT plan; there is no API key.",
    Icon: RobotIcon,
  },
  {
    value: "openrouter",
    title: "OpenRouter key",
    description: "Your own key, with a separate model for listening, thinking, and speaking. Works on any OpenRouter balance.",
    Icon: PlugsConnectedIcon,
  },
];

export function EngineSection() {
  const [engine, setEngine] = useState<VoiceEngine>(DEFAULT_ENGINE);

  useEffect(() => {
    void readEngine().then(setEngine);
  }, []);

  async function choose(next: VoiceEngine) {
    setEngine(next);
    await writeEngine(next);
  }

  return (
    <section aria-labelledby="engine-title">
      <h2 id="engine-title" className="text-lg font-semibold">
        Voice engine
      </h2>
      <p className="mt-3 max-w-prose text-sm leading-6 text-muted-foreground">
        These are different engines rather than two ways to reach the same one, so pick the one you want to use and configure it below.
      </p>

      <fieldset className="mt-5">
        <legend className="sr-only">Voice engine</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {OPTIONS.map(({ value, title, description, Icon }) => (
            <label
              key={value}
              className="flex cursor-pointer gap-3 rounded-lg border border-border p-4 has-checked:border-primary has-checked:bg-accent/40 focus-within:ring-[3px] focus-within:ring-ring/50"
            >
              <input
                type="radio"
                name="voice-engine"
                value={value}
                checked={engine === value}
                onChange={() => void choose(value)}
                className="mt-0.5 size-4 accent-primary"
              />
              <span>
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Icon aria-hidden="true" />
                  {title}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
