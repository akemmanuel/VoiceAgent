import { expect, test } from "bun:test";
import { decodeLiveEvent, delegationAppends } from "./call";

test("preserves client delegation content and rejects other targets", () => {
  const item = { id: "d1", type: "delegation", target: "client", content: [{ type: "input_text", text: "Read the page" }, { type: "image", text: "ignore" }, { type: "input_text", text: "then calculate" }] };
  expect(decodeLiveEvent(JSON.stringify({ type: "delegation.created", item }))).toEqual({ type: "delegation", id: "d1", prompt: "Read the page\nthen calculate" });
  expect(decodeLiveEvent(JSON.stringify({ type: "delegation.created", item: { ...item, target: "responses" } }))).toBeNull();
  expect(decodeLiveEvent(JSON.stringify({ type: "delegation.created", item: { ...item, content: [] } }))).toEqual({ type: "delegation", id: "d1", prompt: "" });
  expect(decodeLiveEvent("malformed")).toBeNull();
});

test("routes progress and final appends on documented channels with UTF-8 byte limits", () => {
  const text = "résultat 💡".repeat(160);
  for (const kind of ["update", "final"] as const) {
    const events = delegationAppends("d1", text, kind);
    expect(events.map(event => event.content[0]!.text).join("")).toBe(text);
    for (const event of events) {
      expect(event.type).toBe("delegation.context.append");
      expect(event.delegation_item_id).toBe("d1");
      expect(event.channel).toBe(kind === "update" ? "commentary" : "speakable");
      expect(new TextEncoder().encode(event.content[0]!.text).length).toBeLessThanOrEqual(500);
    }
  }
  expect(delegationAppends("d1", "", "final")).toEqual([]);
});
