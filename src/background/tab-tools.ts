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
    name: "act-on-active-tab",
    description:
      "Act on the active tab: click an element, type into a field, scroll, or highlight an element so the user can see it. Use request-user-action instead of click when the final step is something the user should confirm themselves, such as paying, sending, publishing, or deleting.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["click", "type", "scroll", "highlight", "request-user-action"], description: "The action to perform." },
        selector: { type: "string", description: "CSS selector from inspect-active-tab. Required for click, type, highlight, and request-user-action." },
        text: { type: "string", description: "Text to enter. Required for type." },
        deltaY: { type: "number", description: "Pixels to scroll; negative scrolls up. Required for scroll." },
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
    .map((element: InteractiveElement) => `${element.selector} — ${element.role ?? element.tag}${element.label ? ` "${element.label}"` : ""}`)
    .join("\n");
  return [`Page: ${snapshot.title}`, `URL: ${snapshot.url}`, "", snapshot.text, controls ? `\nControls:\n${controls}` : ""].join("\n").trim();
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

  if (name === "inspect-active-tab" || name === "capture-active-tab") {
    const response = await handleTabToolRequest({ type: name });
    if (!response.ok) return response.error;
    if (name === "capture-active-tab") return response.screenshot ? "Captured a screenshot of the visible tab." : "The screenshot was empty.";
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

  const element = document.querySelector(action.selector);
  if (!element) throw new Error(`No element matches ${action.selector}.`);

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
    setter?.call(element, action.text);
  } else {
    element.textContent = action.text;
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: action.text }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return "Entered text in the selected element.";
}
