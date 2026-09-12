import type { ToolDefinition } from "@/live/openrouter/client";
import type { ToolOutput } from "@/live/chatgpt/responses";
import { WorkspaceBrowser } from "./workspace-browser";

export const AGENT_TOOLS: ToolDefinition[] = [
  { name: "read", description: "Read a UTF-8 virtual workspace file. Files persist across sessions and browser restarts, separately from the user's disk. Offset and limit are characters.", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 24000 } }, required: ["path"], additionalProperties: false } },
  { name: "write", description: "Create or replace a UTF-8 virtual workspace file. Creates parent directories. Saved files survive session stop and browser restarts.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } },
  { name: "edit", description: "Apply exact-text replacements to a workspace file atomically. Every oldText must match exactly once in the original file; edits must not overlap.", parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "array", items: { type: "object", properties: { oldText: { type: "string" }, newText: { type: "string" } }, required: ["oldText", "newText"], additionalProperties: false } } }, required: ["path", "edits"], additionalProperties: false } },
  { name: "shell", description: `Execute native browser JavaScript, NOT Bash. Persistent REPL with top-level await. Top-level var/let/const/function/class bindings survive calls; declarations are redeclarable and top-level const is mutable. Block-local bindings do not persist. Last expression and console output are returned. All fs and browser calls are async: await them. run(path) executes a saved JS file in this REPL. Native fetch, timers, import(url), and Web APIs are available; no Node/OS shell.
APIs:
fs.read(path), fs.write(path,text), fs.edit(path,edits), fs.mkdir(path), fs.list(path='/'), fs.stat(path), fs.remove(path). Files persist across restarts.
browser.tabs.list(), .open(url), .close(tabIdOrIds), plus Chrome tabs API methods such as query({}), create({url}), update(id,{url,active,pinned,muted}), remove(id), reload(id), goBack(id), goForward(id), move(id,{index}), duplicate(id), discard(id). browser.windows and browser.downloads expose their Chrome API methods.
browser.page.evaluate(tabId, functionOrSource, ...args) executes arbitrary JavaScript in the actual page, including DOM manipulation, and awaits its result. Function arguments are JSON-serialized, so closures cannot cross into the page. Use this for anything beyond the helpers. browser.page.read(tabId) returns title/url/text/html. browser.page.click(tabId,selector), .type(tabId,selector,text), .screenshot(tabId) returning a data URL. await display(dataUrl) attaches an image for you to see.
Native fetch follows CORS; browser.fetch(url,options) fetches through the extension and returns {url,status,ok,headers,text}. browser.downloads.download({url,filename}) saves to the user's download folder, including data URLs for exporting virtual files.
Chrome-protected pages cannot be scripted. Tab lifecycle operations are separate and may still work. Page evaluation uses the debugger API and Chrome may show a debugging banner. No raw access to extension credentials/storage. Stop/timeout resets JS variables but preserves files and cannot undo completed browser actions. Default timeout 60 seconds, maximum 5 minutes.`, parameters: { type: "object", properties: { code: { type: "string" }, timeoutMs: { type: "integer", minimum: 1, maximum: 300000 } }, required: ["code"], additionalProperties: false } },
];

const sessions = new Map<string, AgentTools>();
// The sandbox has no extension API. Its offscreen parent forwards RPC on its behalf.
if (typeof chrome !== "undefined") chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "workspace-bridge") return;
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("offscreen/index.html")) return;
  const session = sessions.get(message.session);
  if (!session) { respond({ error: "Workspace session ended." }); return; }
  session.bridge(message.execution, message.method, message.args).then(value => respond({ value }), error => respond({ error: String(error) }));
  return true;
});

export class AgentTools {
  private readonly id = crypto.randomUUID();
  private readonly browser = new WorkspaceBrowser(data => { if (this.images.length >= 4) throw new Error("At most four images per shell output."); this.images.push(data); });
  private images: string[] = [];
  private active?: { id: string; signal: AbortSignal };
  private stopped = new AbortController();
  private busy = false;
  private resetting: Promise<unknown> = Promise.resolve();
  constructor() { sessions.set(this.id, this); }

  async bridge(execution: string, method: string, args: unknown[]): Promise<unknown> {
    if (!this.active || this.active.id !== execution || typeof method !== "string" || !Array.isArray(args)) throw new Error("No matching shell execution.");
    const { signal } = this.active;
    signal.throwIfAborted();
    const result = await this.browser.call(method, args, signal);
    signal.throwIfAborted();
    return result;
  }

  async execute(name: string, args: string, signal: AbortSignal): Promise<ToolOutput> {
    signal = AbortSignal.any([signal, this.stopped.signal]);
    signal.throwIfAborted();
    if (this.busy) throw new Error("Workspace calls must be sequential.");
    if (!AGENT_TOOLS.some(tool => tool.name === name)) throw new Error(`Unknown tool: ${name}.`);
    const input = JSON.parse(args);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool arguments must be a JSON object.");
    this.busy = true;
    try {
      if (name === "read") {
        const offset = input.offset ?? 0, limit = input.limit ?? 24000;
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 24000) throw new Error("Invalid read offset or limit.");
        const text = await this.browser.files.call("read", [input.path]) as string;
        return JSON.stringify({ text: text.slice(offset, offset + limit), offset, totalCharacters: text.length, truncated: offset + limit < text.length });
      }
      if (name === "write" || name === "edit") return `Saved ${await this.browser.files.call(name, [input.path, name === "write" ? input.content : input.edits])} in the persistent virtual workspace.`;
      if (typeof input.code !== "string") throw new Error("shell requires JavaScript code.");
      const timeout = input.timeoutMs ?? 60000;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000) throw new Error("timeoutMs must be 1–300000.");
      await this.resetting;
      signal.throwIfAborted();
      signal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
      const execution = crypto.randomUUID();
      this.active = { id: execution, signal }; this.images = [];
      const cancel = () => { this.resetting = chrome.runtime.sendMessage({ target: "workspace-runtime", type: "close", session: this.id }).catch(() => {}); };
      let abort!: () => void;
      try {
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => { cancel(); reject(new Error("JavaScript stopped or timed out. REPL variables reset; saved files remain. Completed actions are not undone.")); };
          signal.addEventListener("abort", abort, { once: true });
        });
        signal.throwIfAborted();
        const result = await Promise.race([chrome.runtime.sendMessage({ target: "workspace-runtime", type: "execute", session: this.id, execution, code: input.code }), cancelled]);
        signal.throwIfAborted();
        if (!result?.ok) throw new Error(result?.error ?? "The workspace offscreen document is unavailable. Start a session first.");
        const text = String(result.text ?? "undefined");
        if (!this.images.length) return text;
        return [{ type: "input_text", text }, ...this.images.map(image_url => ({ type: "input_image" as const, image_url, detail: "auto" as const }))];
      } finally {
        signal.removeEventListener("abort", abort);
        this.active = undefined;
      }
    } finally { this.busy = false; }
  }
  close() {
    this.stopped.abort(); this.browser.close(); sessions.delete(this.id);
    void chrome.runtime.sendMessage({ target: "workspace-runtime", type: "close", session: this.id }).catch(() => {});
  }
}
