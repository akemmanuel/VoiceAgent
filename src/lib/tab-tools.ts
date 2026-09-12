export type TabAction =
  | { kind: "click"; selector: string }
  | { kind: "type"; selector: string; text: string }
  | { kind: "scroll"; deltaY: number }
  | { kind: "press-key"; selector?: string; key: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }
  | { kind: "select-option"; selector: string; value?: string; label?: string }
  | { kind: "set-checked"; selector: string; checked: boolean }
  | { kind: "highlight"; selector: string; label?: string; durationSeconds?: number }
  | { kind: "request-user-action"; selector: string; message: string; durationSeconds?: number };

/** A bounded, declarative program for repetitive browser work. It is data, not page JavaScript. */
export type AutomationProgram = { steps: unknown[] };
export type AutomationResult = { completed: number; skippedFinalActions: number; outputs: Record<string, string[]> };

export type InteractiveElement = {
  selector: string;
  tag: string;
  role: string | null;
  label: string;
  visible: boolean;
  occluded: boolean;
  disabled: boolean;
  checked: boolean | null;
  expanded: boolean | null;
  bounds: { x: number; y: number; width: number; height: number };
  options?: string[];
};

export type PageSnapshot = {
  title: string;
  url: string;
  text: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  interactiveElements: InteractiveElement[];
};

export type TabToolRequest =
  | { type: "inspect-active-tab" }
  | { type: "capture-active-tab" }
  | { type: "wait-for-active-tab"; selector?: string; text?: string; timeoutMs?: number }
  | { type: "run-automation"; program: AutomationProgram }
  | { type: "act-on-active-tab"; action: TabAction };

export type TabToolResponse =
  | { ok: true; snapshot?: PageSnapshot; screenshot?: string; found?: boolean; automation?: AutomationResult; message?: string }
  | { ok: false; error: string };
