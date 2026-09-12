type Result = { ok: boolean; text?: string; error?: string; failed?: boolean };
type Runtime = { frame: HTMLIFrameElement; port: MessagePort; ready: Promise<void>; rejectReady: (error: Error) => void; current?: { execution: string; resolve: (value: Result) => void } };
const runtimes = new Map<string, Runtime>();
function dispose(session: string) {
  const runtime = runtimes.get(session); if (!runtime) return;
  runtimes.delete(session);
  runtime.port.postMessage({ type: "terminate" });
  runtime.port.close(); runtime.frame.remove();
  runtime.rejectReady(new Error("JavaScript execution stopped."));
  runtime.current?.resolve({ ok: false, error: "JavaScript execution stopped. REPL variables were reset; saved files remain." });
}
function create(session: string): Runtime {
  const frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL("repl/index.html");
  frame.hidden = true;
  const channel = new MessageChannel();
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const runtime: Runtime = { frame, port: channel.port1, ready, rejectReady };
  runtimes.set(session, runtime);
  channel.port1.onmessage = async ({ data }) => {
    if (data.type === "ready") { resolveReady(); return; }
    if (data.type === "fatal") { runtime.current?.resolve({ ok: false, error: data.error }); dispose(session); return; }
    if (!runtime.current || data.execution !== runtime.current.execution) return;
    if (data.type === "result") {
      runtime.current.resolve({ ok: true, text: data.text, failed: data.failed }); runtime.current = undefined;
    } else if (data.type === "rpc") {
      let reply;
      try { reply = await chrome.runtime.sendMessage({ target: "workspace-bridge", session, execution: data.execution, method: data.method, args: data.args }); }
      catch (error) { reply = { error: String(error) }; }
      if (runtimes.get(session) === runtime) channel.port1.postMessage({ type: "rpc-result", id: data.id, ...reply });
    }
  };
  frame.onload = () => frame.contentWindow!.postMessage({ type: "workspace-connect" }, "*", [channel.port2]);
  document.body.append(frame);
  return runtime;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.target !== "workspace-runtime") return;
  if (typeof message.session !== "string") return;
  if (message.type === "close") { dispose(message.session); respond({ ok: true }); return; }
  if (message.type !== "execute") return;
  (async (): Promise<Result> => {
    const runtime = runtimes.get(message.session) ?? create(message.session);
    await runtime.ready;
    if (runtimes.get(message.session) !== runtime) throw new Error("Runtime stopped.");
    if (runtime.current) throw new Error("Shell executions must be sequential.");
    return await new Promise(resolve => {
      runtime.current = { execution: message.execution, resolve };
      runtime.port.postMessage({ type: "execute", execution: message.execution, code: message.code });
    });
  })().then(respond, error => respond({ ok: false, error: String(error) }));
  return true;
});
