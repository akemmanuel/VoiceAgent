import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;
const manifest = await Bun.file(join(dist, "manifest.json")).json();

describe("built extension", () => {
  test("uses MV3 with persistent browser access and strict privileged-page CSP", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions ?? []).toEqual(["tabs", "scripting", "storage", "offscreen", "downloads", "debugger"]);
    expect(manifest.host_permissions ?? []).toEqual(["<all_urls>"]);
    expect(manifest.content_scripts ?? []).toEqual([]);
    expect(manifest.background.type).toBe("module");
    expect(manifest.content_security_policy.extension_pages).toBe("script-src 'self'; object-src 'self'");
    expect(manifest.sandbox.pages).toEqual(["repl/index.html"]);
    expect(manifest.content_security_policy.sandbox).toContain("'unsafe-eval'");
    expect(manifest.content_security_policy.sandbox).not.toContain("allow-same-origin");
    expect(manifest.content_security_policy.extension_pages).not.toContain("'unsafe-eval'");
  });

  test("has every declared entry point and PNG icon", async () => {
    const files = [manifest.action.default_popup, manifest.options_ui.page, manifest.background.service_worker,
      ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)] as string[];
    for (const path of files) {
      expect(await Bun.file(join(dist, path)).exists()).toBe(true);
    }
    for (const [size, path] of Object.entries(manifest.icons)) {
      const bytes = Buffer.from(await Bun.file(join(dist, path as string)).arrayBuffer());
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bytes.readUInt32BE(16)).toBe(Number(size));
      expect(bytes.readUInt32BE(20)).toBe(Number(size));
    }
  });

  test("HTML references local, existing scripts and styles without inline scripts", async () => {
    for (const page of ["popup", "options", "offscreen", "repl"]) {
      const html = await Bun.file(join(dist, page, "index.html")).text();
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
      for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        expect(match[1]).not.toMatch(/^(?:https?:|\/\/)/);
        expect(await Bun.file(join(dist, page, match[1]!)).exists()).toBe(true);
      }
    }
    expect((await Bun.file(join(dist, "styles.css")).text()).length).toBeGreaterThan(1000);
  });
});
