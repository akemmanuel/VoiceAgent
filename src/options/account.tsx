import { useEffect, useRef, useState } from "react";
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CopyIcon,
  SignInIcon,
  SignOutIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { clearCredentials, readCredentials, saveCredentials, type Credentials } from "@/live/auth/credentials";
import { awaitDeviceAuthorization, requestDeviceAuthorization, type DeviceAuthorization } from "@/live/auth/device";
import { AuthError, DEVICE_VERIFICATION_URL } from "@/live/auth/oauth";

type Phase = "loading" | "signed-out" | "requesting" | "waiting" | "signed-in";

export function AccountSection() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [device, setDevice] = useState<DeviceAuthorization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void readCredentials().then(stored => {
      setCredentials(stored);
      setPhase(stored ? "signed-in" : "signed-out");
    });
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function signIn() {
    setError(null);
    setPhase("requesting");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const authorization = await requestDeviceAuthorization();
      setDevice(authorization);
      setPhase("waiting");
      // Open the sign-in page only once a code exists, so the user never lands on it early.
      await chrome.tabs.create({ url: DEVICE_VERIFICATION_URL });
      const tokens = await awaitDeviceAuthorization(authorization, { signal: controller.signal });
      setCredentials(await saveCredentials(tokens));
      setDevice(null);
      setPhase("signed-in");
    } catch (cause) {
      setDevice(null);
      setPhase("signed-out");
      if (cause instanceof AuthError && cause.code === "cancelled") return;
      setError(cause instanceof Error ? cause.message : "Sign-in failed. Try again.");
    } finally {
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  async function signOut() {
    await clearCredentials();
    setCredentials(null);
    setError(null);
    setPhase("signed-out");
  }

  async function copyCode() {
    if (!device) return;
    try {
      await navigator.clipboard.writeText(device.userCode);
      setCopied(true);
    } catch {
      setError("The code couldn't be copied. Select it and copy it manually.");
    }
  }

  return (
    <section aria-labelledby="account-title">
      <h2 id="account-title" className="text-lg font-semibold">
        ChatGPT account
      </h2>
      <p className="mt-3 max-w-prose text-sm leading-6 text-muted-foreground">
        VoiceAgent talks to GPT-Live through your ChatGPT subscription. It signs in with a one-time code, so there is no API key to paste and no password to store.
      </p>

      <div className="mt-5">
        {phase === "loading" && <p className="text-sm text-muted-foreground">Checking sign-in status…</p>}

        {phase === "signed-out" && (
          <Button onClick={() => void signIn()}>
            <SignInIcon aria-hidden="true" />
            Sign in with ChatGPT
          </Button>
        )}

        {phase === "requesting" && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <SpinnerGapIcon className="animate-spin" aria-hidden="true" />
            Requesting a sign-in code…
          </p>
        )}

        {phase === "waiting" && device && (
          <div role="status" className="rounded-lg border border-border p-4">
            <p className="text-sm leading-6">
              Enter this code on the sign-in page that just opened:
            </p>
            <p className="mt-3">
              <code className="rounded bg-muted px-2 py-1 font-mono text-base font-semibold tracking-widest">
                {device.userCode}
              </code>
            </p>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              It expires in 15 minutes. If the page didn't open, visit{" "}
              <span className="font-medium">auth.openai.com/codex/device</span>. This panel updates on its own once you approve.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => void copyCode()}>
                {copied ? <CheckCircleIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                {copied ? "Copied" : "Copy code"}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void chrome.tabs.create({ url: DEVICE_VERIFICATION_URL })}>
                <ArrowSquareOutIcon aria-hidden="true" />
                Open sign-in page
              </Button>
              <Button variant="ghost" size="sm" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {phase === "signed-in" && credentials && (
          <div className="rounded-lg border border-border p-4">
            <p className="text-sm font-medium">
              {credentials.email ?? "Signed in to ChatGPT"}
              {credentials.planType && <span className="ml-2 text-xs font-normal text-muted-foreground">{credentials.planType} plan</span>}
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Voice sessions bill to this account and count against its concurrent-session limit.
            </p>
            <Button variant="secondary" size="sm" className="mt-4" onClick={() => void signOut()}>
              <SignOutIcon aria-hidden="true" />
              Sign out
            </Button>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 flex items-start gap-2 text-sm leading-5 text-destructive">
            <WarningCircleIcon className="mt-0.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
