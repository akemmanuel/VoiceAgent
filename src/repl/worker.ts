import { compileRepl } from "../live/agent/transform";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let sequence = 0;
let execution: string | undefined;
let output: string[] = [];
let outputLength = 0;
const send = self.postMessage.bind(self);
function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try { return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? `${v}n` : v) ?? String(value); }
  catch { return String(value); }
}
function print(...args: unknown[]) {
  if (outputLength >= 24000) return;
  const text = args.map(format).join(" ").slice(0, 24000 - outputLength);
  output.push(text); outputLength += text.length + 1;
}
function rpc(method: string, args: unknown[]): Promise<any> {
  if (!execution) return Promise.reject(new Error("Browser and filesystem calls require an active shell execution."));
  const id = ++sequence;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ type: "rpc", id, execution, method, args }); });
}
const fs = Object.fromEntries(["read", "write", "edit", "mkdir", "list", "stat", "remove"].map(name => [name, (...args: unknown[]) => rpc(`fs.${name}`, args)]));
const namespace = (name: string) => new Proxy(Object.create(null), { get: (_target, method) => typeof method === "string" && method !== "then" ? (...args: unknown[]) => rpc(`${name}.${method}`, args) : undefined });
const evaluate = (tabId: number, code: string | Function, ...args: unknown[]) => rpc("page.evaluate", [tabId, typeof code === "function" ? `(${code.toString()})(...${JSON.stringify(args)})` : code]);
const page = {
  evaluate,
  read: (tabId: number) => evaluate(tabId, () => ({ title: document.title, url: location.href, text: document.body?.innerText ?? "", html: document.documentElement.outerHTML })),
  click: (tabId: number, selector: string) => evaluate(tabId, (selector: string) => { const e = document.querySelector(selector) as HTMLElement; if (!e) throw new Error(`No element: ${selector}`); e.click(); return "Clicked"; }, selector),
  type: (tabId: number, selector: string, text: string) => evaluate(tabId, (selector: string, text: string) => {
    const e = document.querySelector(selector) as HTMLInputElement;
    if (!e) throw new Error(`No element: ${selector}`);
    e.focus();
    if (e.isContentEditable) e.textContent = text;
    else { const setter = Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set; if (!setter) throw new Error("Not a text input"); setter.call(e, text); }
    e.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    e.dispatchEvent(new Event("change", { bubbles: true })); return "Typed";
  }, selector, text),
  screenshot: (tabId: number) => rpc("page.screenshot", [tabId]),
};
const tabs = namespace("tabs");
const browser = {
  tabs: new Proxy(tabs, { get: (target, key) => {
    if (key === "list") return () => rpc("tabs.query", [{}]);
    if (key === "close") return (ids: number | number[]) => rpc("tabs.remove", [ids]);
    if (key === "open") return (url: string) => rpc("tabs.create", [{ url, active: true }]);
    return Reflect.get(target, key);
  } }),
  windows: namespace("windows"), downloads: namespace("downloads"), page,
  fetch: (url: string, options?: RequestInit) => rpc("network.fetch", [url, options]),
};
Object.assign(globalThis, {
  fs, browser,
  console: Object.fromEntries(["log", "info", "warn", "error", "debug", "dir"].map(name => [name, print])),
  display: (dataUrl: string) => rpc("display", [dataUrl]),
  run: async (path: string) => new AsyncFunction(compileRepl(await fs.read!(path)))(),
});
self.onmessage = async ({ data }) => {
  if (data.type === "rpc-result") {
    const call = pending.get(data.id); if (!call) return;
    pending.delete(data.id);
    if (data.error) call.reject(new Error(data.error)); else call.resolve(data.value);
    return;
  }
  if (data.type !== "execute") return;
  execution = data.execution; output = []; outputLength = 0;
  try {
    const value = await new AsyncFunction(compileRepl(data.code))();
    print(value);
    send({ type: "result", execution, text: output.join("\n") });
  } catch (error) {
    print(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    send({ type: "result", execution, text: output.join("\n"), failed: true });
  } finally { execution = undefined; }
};
