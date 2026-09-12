import { useEffect, useState, type FormEvent } from "react";
import { CheckCircleIcon, UserCircleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { DEFAULT_DISPLAY_NAME, readDisplayName, writeDisplayName } from "@/live/settings";

export function ProfileSection() {
  const [name, setName] = useState(DEFAULT_DISPLAY_NAME);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void readDisplayName().then(setName);
  }, []);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2_000);
    return () => clearTimeout(timer);
  }, [saved]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = name.trim();
    if (!next) return;
    await writeDisplayName(next);
    setName(next);
    setSaved(true);
  }

  return (
    <section aria-labelledby="profile-title">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UserCircleIcon size={22} weight="fill" aria-hidden="true" />
        </span>
        <div>
          <h2 id="profile-title" className="text-lg font-semibold">Your profile</h2>
          <p className="text-xs text-muted-foreground">How VoiceAgent identifies your messages</p>
        </div>
      </div>

      <form className="mt-5" onSubmit={save}>
        <label htmlFor="display-name" className="block text-sm font-medium">Display name</label>
        <div className="mt-2 flex gap-2">
          <input
            id="display-name"
            className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            value={name}
            onChange={event => {
              setName(event.target.value);
              setSaved(false);
            }}
            maxLength={40}
            autoComplete="name"
            placeholder="Your name"
          />
          <Button type="submit" disabled={!name.trim()}>
            {saved && <CheckCircleIcon aria-hidden="true" />}
            {saved ? "Saved" : "Save"}
          </Button>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">Stored only in this browser. It does not change your ChatGPT or Google account.</p>
      </form>
    </section>
  );
}
