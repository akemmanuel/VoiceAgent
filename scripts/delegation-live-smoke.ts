/** Luna's native browser runtime must be tested in Chromium, not substituted with QuickJS.
 * PI_AUTH_FILE=~/.pi/agent/auth.json bun scripts/delegation-live-smoke.ts
 * Load the printed test extension directory in an isolated Chromium profile.
 */
if (!process.env.PI_AUTH_FILE && !process.env.CODEX_AUTH_FILE) throw new Error("Set PI_AUTH_FILE or CODEX_AUTH_FILE to opt into a live Luna test.");
await import("./agent-extension-smoke");
export {};
