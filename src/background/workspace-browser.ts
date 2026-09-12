import { Workspace } from "@/live/agent/workspace";

/** Privileged operations available to native JS, never credentials or extension storage. */
export class WorkspaceBrowser {
  readonly files = new Workspace();
  private targets = new Set<number>();
  private queues = new Map<number, Promise<unknown>>();
  constructor(private readonly image: (dataUrl: string) => void) {}

  async call(method: string, args: unknown[], signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (method.startsWith("fs.")) return this.files.call(method.slice(3), args);
    if (method === "display") {
      const data = args[0];
      if (typeof data !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data) || data.length > 20_000_000) throw new Error("display requires a PNG, JPEG, or WebP base64 data URL up to 20 MB.");
      this.image(data); return "Image attached to shell output.";
    }
    if (method === "page.evaluate") {
      const [id, code] = args;
      if (!Number.isInteger(id) || (id as number) < 0 || typeof code !== "string") throw new Error("evaluate requires a tab ID and JavaScript source or function.");
      const tabId = id as number;
      const task = (this.queues.get(tabId) ?? Promise.resolve()).catch(() => {}).then(() => this.evaluate(tabId, code, signal));
      this.queues.set(tabId, task);
      try { return await task; }
      finally { if (this.queues.get(tabId) === task) this.queues.delete(tabId); }
    }
    if (method === "page.screenshot") {
      const tab = await chrome.tabs.update(args[0] as number, { active: true });
      signal.throwIfAborted();
      if (!tab) throw new Error("Tab no longer exists.");
      await chrome.windows.update(tab.windowId, { focused: true });
      signal.throwIfAborted();
      return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    }
    if (method === "network.fetch") {
      const [url, options] = args as [string, RequestInit | undefined];
      if (!/^https?:$/.test(new URL(url).protocol)) throw new Error("browser.fetch requires an http(s) URL.");
      const response = await fetch(url, { ...options, signal });
      return { url: response.url, status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), text: await response.text() };
    }
    const [namespace, operation, extra] = method.split(".");
    // API namespaces are deliberate. Generated code cannot call runtime/storage/identity.
    if (!extra && ["tabs", "windows", "downloads"].includes(namespace!)) {
      const api = (chrome as any)[namespace!];
      const fn = Object.hasOwn(api, operation!) && api[operation!];
      if (typeof fn !== "function") throw new Error(`No browser API ${method}.`);
      return await fn.apply(api, args);
    }
    throw new Error(`Unknown workspace API: ${method}.`);
  }

  private async evaluate(tabId: number, expression: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const target = { tabId };
    // Refuse to steal an existing DevTools/debugger attachment; Chrome reports it.
    await chrome.debugger.attach(target, "1.3");
    this.targets.add(tabId);
    const cancel = () => { void chrome.debugger.sendCommand(target, "Runtime.terminateExecution").catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const result = await chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }) as any;
      signal.throwIfAborted();
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Page JavaScript failed.");
      return result.result?.value ?? result.result?.unserializableValue;
    } finally {
      signal.removeEventListener("abort", cancel);
      this.targets.delete(tabId);
      await chrome.debugger.detach(target).catch(() => {});
    }
  }
  close() {
    for (const tabId of this.targets) {
      void chrome.debugger.sendCommand({ tabId }, "Runtime.terminateExecution").catch(() => {}).finally(() => chrome.debugger.detach({ tabId }).catch(() => {}));
    }
    this.targets.clear();
  }
}
