export type TabAction =
  | { kind: "click"; selector: string }
  | { kind: "type"; selector: string; text: string }
  | { kind: "scroll"; deltaY: number };

export type InteractiveElement = {
  selector: string;
  tag: string;
  role: string | null;
  label: string;
};

export type PageSnapshot = {
  title: string;
  url: string;
  text: string;
  interactiveElements: InteractiveElement[];
};

export type TabToolRequest =
  | { type: "inspect-active-tab" }
  | { type: "capture-active-tab" }
  | { type: "act-on-active-tab"; action: TabAction };

export type TabToolResponse =
  | { ok: true; snapshot?: PageSnapshot; screenshot?: string; message?: string }
  | { ok: false; error: string };
