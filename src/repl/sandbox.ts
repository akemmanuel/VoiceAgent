declare const __REPL_WORKER_SOURCE__: string;

// This page has an opaque sandbox origin. Only its privileged parent gets the port.
window.addEventListener("message", event => {
  if (event.source !== parent || event.data?.type !== "workspace-connect" || !event.ports[0]) return;
  const port = event.ports[0];
  const url = URL.createObjectURL(new Blob([__REPL_WORKER_SOURCE__], { type: "text/javascript" }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  worker.onmessage = event => port.postMessage(event.data);
  worker.onerror = event => port.postMessage({ type: "fatal", error: event.message });
  port.onmessage = event => {
    if (event.data.type === "terminate") { worker.terminate(); port.close(); }
    else worker.postMessage(event.data);
  };
  port.start();
  port.postMessage({ type: "ready" });
}, { once: true });
