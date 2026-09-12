/**
 * Browser tab tools and their model-facing descriptions.
 *
 * Moved out of `background/index.ts` so the voice session can call a tool directly:
 * a service worker cannot `sendMessage` to its own listener, so the orchestrator
 * needs a plain function, while the popup still reaches the same implementation
 * through a message.
 */

import type { InteractiveElement, PageSnapshot, TabAction, TabToolResponse } from "@/lib/tab-tools";
import type { ToolDefinition } from "@/live/openrouter/client";

export const BROWSER_TOOLS: ToolDefinition[] = [
  {
    name: "inspect-active-tab",
    description: "Read the visible text, title, URL, and interactive controls of the browser tab the user is looking at.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "capture-active-tab",
    description: "Take a screenshot of the visible part of the active tab. Use only when seeing the page matters.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wait-for-active-tab",
    description: "Wait until a CSS selector or visible text appears in the active tab. Use this after navigation or actions that load dynamic content.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Optional CSS selector to wait for." },
        text: { type: "string", description: "Optional visible text to wait for." },
        timeoutMs: { type: "number", description: "Wait time from 250 to 30000 milliseconds; defaults to 10000." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "act-on-active-tab",
    description:
      "Act on the active tab: click an element, type into a field, scroll, or highlight an element so the user can see it. Use request-user-action instead of click when the final step is something the user should confirm themselves, such as paying, sending, publishing, or deleting.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["click", "type", "scroll", "press-key", "select-option", "set-checked", "highlight", "request-user-action"], description: "The action to perform." },
        selector: { type: "string", description: "CSS selector from inspect-active-tab. Required for click, type, highlight, and request-user-action." },
        text: { type: "string", description: "Text to enter. Required for type." },
        deltaY: { type: "number", description: "Pixels to scroll; negative scrolls up. Required for scroll." },
        key: { type: "string", description: "Key to press, such as Enter, Escape, Tab, or a character. Required for press-key." },
        ctrlKey: { type: "boolean", description: "Hold Control while pressing a key." },
        altKey: { type: "boolean", description: "Hold Alt while pressing a key." },
        shiftKey: { type: "boolean", description: "Hold Shift while pressing a key." },
        metaKey: { type: "boolean", description: "Hold Meta/Command while pressing a key." },
        value: { type: "string", description: "Native dropdown option value for select-option." },
        checked: { type: "boolean", description: "Target checkbox/radio state for set-checked." },
        label: { type: "string", description: "Optional short caption for a highlight." },
        message: { type: "string", description: "What the user should do. Required for request-user-action." },
        durationSeconds: { type: "number", description: "How long a highlight or request stays on screen, 1 to 60 seconds. Defaults to 8." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
];

/** Turns a snapshot into compact text, since the transcript is what the model reads. */
export function formatSnapshot(snapshot: PageSnapshot): string {
  const controls = snapshot.interactiveElements
    .slice(0, 40)
    .map((element: InteractiveElement) => `${element.selector} — ${element.role ?? element.tag}${element.label ? ` "${element.label}"` : ""}${element.disabled ? " [disabled]" : ""}${element.checked === true ? " [checked]" : ""}${element.expanded !== null ? ` [expanded=${element.expanded}]` : ""}${!element.visible ? " [offscreen]" : element.occluded ? " [covered]" : ""}`)
    .join("\n");
  return [`Page: ${snapshot.title}`, `URL: ${snapshot.url}`, `Viewport: ${snapshot.viewport.width}×${snapshot.viewport.height} at ${snapshot.viewport.scrollX},${snapshot.viewport.scrollY}`, "", snapshot.text, controls ? `\nControls:\n${controls}` : ""].join("\n").trim();
}

export async function handleTabToolRequest(request: { type: string; action?: TabAction }): Promise<TabToolResponse> {
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

    if (request.type === "wait-for-active-tab") {
      const waiting = request as { selector?: string; text?: string; timeoutMs?: number };
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: waitForPageState,
        args: [waiting.selector, waiting.text, waiting.timeoutMs],
      });
      const found = result[0]?.result === true;
      return { ok: true, found, message: found ? "The requested page state appeared." : "Timed out waiting for the requested page state." };
    }

    const action = request.action;
    if (!action) return { ok: false, error: "That action needs a kind." };
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: performAction,
      args: [action],
    });
    const message = result[0]?.result as string | undefined;
    return message ? { ok: true, message } : { ok: false, error: "The page did not confirm the action." };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "The browser denied access to this page.";
    return { ok: false, error: message };
  }
}

/** Runs one tool call and returns the text the model should see. */
export async function executeBrowserTool(name: string, args: string): Promise<string> {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(args) as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    return "The arguments were not valid JSON. Call the tool again with valid arguments.";
  }

  if (name === "inspect-active-tab" || name === "capture-active-tab" || name === "wait-for-active-tab") {
    const response = name === "wait-for-active-tab"
      ? await handleTabToolRequest({ type: name, ...parsed } as { type: string })
      : await handleTabToolRequest({ type: name });
    if (!response.ok) return response.error;
    if (name === "capture-active-tab") return response.screenshot ? "Captured a screenshot of the visible tab." : "The screenshot was empty.";
    if (name === "wait-for-active-tab") return response.message ?? "Finished waiting.";
    return response.snapshot ? formatSnapshot(response.snapshot) : "The page had no readable content.";
  }

  if (name === "act-on-active-tab") {
    const kind = parsed.kind;
    if (typeof kind !== "string") {
      return "An action needs a kind of click, type, scroll, highlight, or request-user-action.";
    }
    const action = { ...parsed, kind } as unknown as TabAction;
    const response = await handleTabToolRequest({ type: "act-on-active-tab", action });
    return response.ok ? response.message ?? "The action was applied." : response.error;
  }

  return `There is no tool named ${name}.`;
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
    .map(element => {
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      const pointX = Math.max(0, Math.min(innerWidth - 1, rect.left + Math.min(rect.width / 2, 8)));
      const pointY = Math.max(0, Math.min(innerHeight - 1, rect.top + Math.min(rect.height / 2, 8)));
      const topElement = visible ? document.elementFromPoint(pointX, pointY) : null;
      const control = element as HTMLInputElement & HTMLButtonElement;
      const select = element instanceof HTMLSelectElement ? [...element.options].map(option => option.text.trim()).filter(Boolean).slice(0, 30) : undefined;
      return {
        selector: selectorFor(element),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        label: labelFor(element),
        visible,
        occluded: visible && !!topElement && topElement !== element && !element.contains(topElement) && !topElement.contains(element),
        disabled: ("disabled" in control && Boolean(control.disabled)) || element.getAttribute("aria-disabled") === "true",
        checked: element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type) ? element.checked : null,
        expanded: element.hasAttribute("aria-expanded") ? element.getAttribute("aria-expanded") === "true" : null,
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        ...(select ? { options: select } : {}),
      };
    });

  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || "").replace(/\s+\n/g, "\n").trim().slice(0, 12000),
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    interactiveElements,
  };
}

function waitForPageState(selector: string | undefined, text: string | undefined, timeoutMs: number | undefined): Promise<boolean> {
  const limit = Math.max(250, Math.min(30_000, Number.isFinite(timeoutMs) ? timeoutMs! : 10_000));
  const matches = () => (!selector || !!document.querySelector(selector)) && (!text || document.body?.innerText.includes(text));
  if (matches()) return Promise.resolve(true);
  return new Promise(resolve => {
    const observer = new MutationObserver(() => {
      if (!matches()) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(true);
    });
    const timer = window.setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, limit);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  });
}

function performAction(action: TabAction): string {
  const durationFor = (value: number | undefined) => {
    const requestedDuration = value ?? 8;
    return Number.isFinite(requestedDuration) ? Math.max(1, Math.min(60, requestedDuration)) : 8;
  };
  const highlight = (element: Element, label: string | undefined, durationSeconds: number) => {
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
    if (label) {
      const caption = document.createElement("span");
      caption.textContent = label.slice(0, 120);
      caption.style.cssText = "position:absolute;left:-3px;top:-30px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 8px;border-radius:4px;background:#92400e;color:#fff;font:600 13px system-ui,sans-serif;line-height:18px;box-shadow:0 1px 3px rgba(0,0,0,.25)";
      overlay.append(caption);
    }
    document.body.append(overlay);
    element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    window.setTimeout(() => overlay.remove(), durationSeconds * 1000);
  };
  // Final actions carry real consequences, so the user performs them. This is a
  // heuristic on the control's own text, and it errs toward asking.
  const needsUserClick = (element: Element) => {
    const label = [(element as HTMLElement).innerText, element.getAttribute("aria-label"), element.getAttribute("title"), (element as HTMLInputElement).value]
      .filter(Boolean).join(" ").toLocaleLowerCase();
    return /\b(send|submit|senden|abschicken|pay|bezahlen|zahlung|place order|bestellung abschließen|confirm|bestätigen|delete|löschen|entfernen|veröffentlichen|publish)\b/u.test(label);
  };

  if (action.kind === "scroll") {
    window.scrollBy({ top: Math.max(-2000, Math.min(2000, action.deltaY)), behavior: "smooth" });
    return "Scrolled the page.";
  }

  if (action.kind === "press-key" && !action.selector) {
    const target = document.activeElement;
    if (!(target instanceof HTMLElement)) throw new Error("No focusable element is active.");
    dispatchKey(target, action);
    return `Pressed ${action.key}.`;
  }

  const selector = action.selector;
  if (!selector) throw new Error("This action requires a selector.");
  const element = document.querySelector(selector);
  if (!element) throw new Error(`No element matches ${selector}.`);

  if (action.kind === "highlight") {
    const durationSeconds = durationFor(action.durationSeconds);
    highlight(element, action.label, durationSeconds);
    return `Highlighted the selected element for ${durationSeconds} seconds.`;
  }

  if (action.kind === "request-user-action") {
    const durationSeconds = durationFor(action.durationSeconds);
    highlight(element, action.message, durationSeconds);
    return `Asked the user to perform the final action; it is highlighted for ${durationSeconds} seconds.`;
  }

  if (action.kind === "press-key") {
    dispatchKey(element, action);
    return `Pressed ${action.key}.`;
  }

  if (action.kind === "select-option") {
    if (!(element instanceof HTMLSelectElement)) throw new Error("The selected element is not a native dropdown.");
    const option = [...element.options].find(candidate => candidate.value === action.value || candidate.text.trim() === action.label);
    if (!option) throw new Error("The requested dropdown option was not found.");
    element.value = option.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return `Selected ${option.text.trim()}.`;
  }

  if (action.kind === "set-checked") {
    if (!(element instanceof HTMLInputElement) || !["checkbox", "radio"].includes(element.type)) {
      throw new Error("The selected element is not a checkbox or radio button.");
    }
    if (element.disabled) throw new Error("The selected control is disabled.");
    element.checked = action.checked;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return `${action.checked ? "Checked" : "Unchecked"} the selected control.`;
  }

  if (action.kind === "click") {
    if (needsUserClick(element)) {
      highlight(element, "Bitte selbst klicken: finale Aktion", 12);
      return "This appears to be a final external action, so it was highlighted for the user instead of clicked.";
    }
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
    for (const character of action.text) {
      dispatchKey(element, { kind: "press-key", key: character });
      setter?.call(element, `${element.value}${character}`);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: character }));
    }
  } else {
    element.textContent = action.text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: action.text }));
  }
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return "Entered text in the selected element.";
}

function dispatchKey(element: Element, action: Extract<TabAction, { kind: "press-key" }>) {
  const options = { key: action.key, bubbles: true, cancelable: true, ctrlKey: action.ctrlKey, altKey: action.altKey, shiftKey: action.shiftKey, metaKey: action.metaKey };
  element.dispatchEvent(new KeyboardEvent("keydown", options));
  element.dispatchEvent(new KeyboardEvent("keypress", options));
  element.dispatchEvent(new KeyboardEvent("keyup", options));
}
