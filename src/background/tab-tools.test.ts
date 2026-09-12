import { describe, expect, test } from "bun:test";
import { BROWSER_TOOLS, formatSnapshot } from "./tab-tools";

describe("browser tool contract", () => {
  test("exposes every observation, action, and bounded-automation entry point", () => {
    expect(BROWSER_TOOLS.map(tool => tool.name)).toEqual([
      "inspect-active-tab",
      "capture-active-tab",
      "wait-for-active-tab",
      "run-automation",
      "act-on-active-tab",
    ]);
    const automation = BROWSER_TOOLS.find(tool => tool.name === "run-automation");
    expect(automation?.description).toContain("no-network");
    expect(automation?.description).toContain("final");
  });

  test("formats state needed for reliable follow-up actions", () => {
    const text = formatSnapshot({
      title: "Sales orders",
      url: "https://example.test/orders",
      text: "Two orders need review.",
      viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 320 },
      interactiveElements: [{
        selector: "#save", tag: "button", role: "button", label: "Save", visible: true, occluded: true,
        disabled: true, checked: null, expanded: false, bounds: { x: 10, y: 20, width: 80, height: 32 },
      }],
    });
    expect(text).toContain("Viewport: 1280×720 at 0,320");
    expect(text).toContain('#save — button "Save" [disabled] [expanded=false] [covered]');
  });
});
