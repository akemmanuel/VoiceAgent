import type { InteractiveElement, PageSnapshot, TabAction, TabToolRequest, TabToolResponse } from "@/lib/tab-tools";

// MV3 workers can be suspended when idle, so this listener is registered at
// module scope and has no durable in-memory state.
chrome.runtime.onMessage.addListener((request: TabToolRequest, _sender, sendResponse) => {
  if (request.type !== "inspect-active-tab" && request.type !== "capture-active-tab" && request.type !== "act-on-active-tab") return;

  void handleTabToolRequest(request).then(sendResponse);
  return true;
});

async function handleTabToolRequest(request: TabToolRequest): Promise<TabToolResponse> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return { ok: false, error: "No active browser tab is available." };

    if (request.type === "capture-active-tab") {
      const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { ok: true, screenshot };
    }

    if (request.type === "inspect-active-tab") {
      const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inspectPage });
      const snapshot = result[0]?.result as PageSnapshot | undefined;
      return snapshot ? { ok: true, snapshot } : { ok: false, error: "The page returned no readable content." };
    }

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: performAction,
      args: [request.action],
    });
    const message = result[0]?.result as string | undefined;
    return message ? { ok: true, message } : { ok: false, error: "The page did not confirm the action." };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "The browser denied access to this page.";
    return { ok: false, error: message };
  }
}

function inspectPage(): PageSnapshot {
  const selectorFor = (element: Element): string => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const name = element.getAttribute("name");
    if (name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
    const testId = element.getAttribute("data-testid");
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const parent = element.parentElement;
    if (!parent) return element.tagName.toLowerCase();
    const siblings = [...parent.children].filter(child => child.tagName === element.tagName);
    return `${selectorFor(parent)} > ${element.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(element) + 1})`;
  };
  const labelFor = (element: Element) => {
    const aria = element.getAttribute("aria-label");
    const text = (element as HTMLElement).innerText || element.getAttribute("placeholder") || element.getAttribute("title") || "";
    return (aria || text).replace(/\s+/g, " ").trim().slice(0, 160);
  };
  const interactiveElements: InteractiveElement[] = [...document.querySelectorAll("a, button, input, textarea, select, [role='button'], [contenteditable='true']")]
    .filter(element => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    })
    .slice(0, 80)
    .map(element => ({
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      label: labelFor(element),
    }));

  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || "").replace(/\s+\n/g, "\n").trim().slice(0, 12000),
    interactiveElements,
  };
}

function performAction(action: TabAction): string {
  if (action.kind === "clear-highlights") {
    document.querySelectorAll("[data-voiceagent-highlight]").forEach(element => element.remove());
    return "Cleared page highlights.";
  }

  if (action.kind === "scroll") {
    window.scrollBy({ top: Math.max(-2000, Math.min(2000, action.deltaY)), behavior: "smooth" });
    return "Scrolled the page.";
  }

  const element = document.querySelector(action.selector);
  if (!element) throw new Error(`No element matches ${action.selector}.`);

  if (action.kind === "highlight") {
    document.querySelectorAll("[data-voiceagent-highlight]").forEach(existing => existing.remove());
    const rect = element.getBoundingClientRect();
    const overlay = document.createElement("div");
    overlay.dataset.voiceagentHighlight = "true";
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText = [
      "position:absolute", `top:${rect.top + window.scrollY - 4}px`, `left:${rect.left + window.scrollX - 4}px`,
      `width:${rect.width + 8}px`, `height:${rect.height + 8}px`, "box-sizing:border-box", "pointer-events:none",
      "z-index:2147483647", "border:3px solid #f59e0b", "border-radius:6px", "box-shadow:0 0 0 4px rgba(245,158,11,.28)",
    ].join(";");
    if (action.label) {
      const label = document.createElement("span");
      label.textContent = action.label.slice(0, 120);
      label.style.cssText = "position:absolute;left:-3px;top:-30px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 8px;border-radius:4px;background:#92400e;color:#fff;font:600 13px system-ui,sans-serif;line-height:18px;box-shadow:0 1px 3px rgba(0,0,0,.25)";
      overlay.append(label);
    }
    document.body.append(overlay);
    element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    return "Highlighted the selected element.";
  }

  if (action.kind === "click") {
    (element as HTMLElement).click();
    return "Clicked the selected element.";
  }

  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLElement && element.isContentEditable)) {
    throw new Error("The selected element does not accept text.");
  }
  if (element instanceof HTMLInputElement && element.type === "password") {
    throw new Error("Typing into password fields is not allowed.");
  }
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    setter?.call(element, action.text);
  } else {
    element.textContent = action.text;
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: action.text }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return "Entered text in the selected element.";
}
