import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const extensionDir = join(root, "dist");
const profileDir = join(root, ".chrome-dev");

if (!(await Bun.file(join(extensionDir, "manifest.json")).exists())) {
  throw new Error("dist/manifest.json does not exist. Run `bun run build` first.");
}

const configuredBrowser = process.env.BROWSER_PATH;
const candidates = process.platform === "win32"
  ? [
      configuredBrowser,
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ]
  : process.platform === "darwin"
    ? [
        configuredBrowser,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ]
    : [
        configuredBrowser,
        Bun.which("google-chrome"),
        Bun.which("google-chrome-stable"),
        Bun.which("chromium"),
        Bun.which("chromium-browser"),
        Bun.which("microsoft-edge"),
      ];

let browserPath: string | undefined;
for (const candidate of candidates) {
  if (candidate && await Bun.file(candidate).exists()) {
    browserPath = candidate;
    break;
  }
}

if (!browserPath) {
  throw new Error("Chrome or Edge was not found. Set BROWSER_PATH to the browser executable.");
}

await mkdir(profileDir, { recursive: true });
console.log(`Opening ${browserPath}`);
console.log(`Extension directory: ${extensionDir}`);
console.log("If the popup does not open automatically, pin VoiceAgent and click its toolbar icon.");

const browser = Bun.spawn([
  browserPath,
  `--user-data-dir=${profileDir}`,
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  "chrome://extensions/",
], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "inherit",
});

const exitCode = await browser.exited;
if (exitCode !== 0) process.exit(exitCode);
