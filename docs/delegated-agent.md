# Delegated agent and native JavaScript workspace

GPT Live handles voice and delegates tasks to `gpt-5.6-luna` with high reasoning. Luna has exactly four model-facing tools: `read`, `write`, `edit`, and `shell`. Browser capabilities are JavaScript APIs inside `shell`, not separate model tools.

This replaces the earlier QuickJS implementation and its twelve-tool interface. The original agreement is recorded in Pi session `01a09629-6c34-7706-924b-4e52c249bb28`: native JavaScript, shared REPL, durable virtual files, network access, and browser operations through a bridge.

## Execution

`src/repl/worker.ts` runs in Chrome's native JavaScript engine. A sandboxed iframe in the existing offscreen document owns the dedicated Worker. The Worker is isolated from extension credentials and runtime APIs, but can call the privileged browser/filesystem bridge through a MessagePort and authenticated offscreen messages.

The privileged extension CSP does not permit eval. Only the opaque-origin sandbox permits generated JavaScript and downloaded libraries. This is intended for manually installed personal extensions. Chrome Web Store acceptance of this runtime is not established.

Acorn parses each shell input. Top-level declarations become persistent global bindings; the final expression becomes the result. Top-level `await`, destructuring, functions, and classes work. Top-level `let` and `const` are mutable and redeclarable in this REPL. Declarations inside blocks and function bodies follow normal JS scoping. Static import declarations are not supported; use `await import(url)`. Console output and returned values are bounded to 24,000 characters.

Each voice session has its own Worker. Shell calls execute sequentially. `run(path)` executes a saved JavaScript file in that same workspace. Downloaded browser-compatible modules can use native `import(url)` and `fetch`; Node packages and OS executables do not work automatically.

## Persistent files

`src/live/agent/workspace.ts` owns a dedicated IndexedDB database, separate from OAuth and settings storage. Files and scripts survive session stop, Worker reset, offscreen destruction, and browser restart. They remain virtual extension files, not ordinary user-visible disk files. Uninstalling the extension or clearing its storage can delete them. Browser storage quotas still apply.

All filesystem methods are asynchronous:

```js
await fs.write('/workspace/report.txt', 'hello'); // creates parents
await fs.read('/workspace/report.txt');
await fs.edit('/workspace/report.txt', [{oldText: 'hello', newText: 'updated'}]);
await fs.mkdir('/scripts');
await fs.list('/workspace');
await fs.stat('/workspace/report.txt');
await fs.remove('/workspace/report.txt');
```

The model-facing `write` tool uses `{path, content}`. `read` accepts character offset/limit. `edit` matches every oldText against the original file, rejects ambiguous or overlapping edits, and commits all replacements atomically. IndexedDB transactions serialize concurrent mutations. Direct tools and the JS bridge use the same filesystem.

## Browser access

```js
const tabs = await browser.tabs.list();
const tab = await browser.tabs.open('https://example.com');
await browser.tabs.update(tab.id, {active: true, pinned: true});
await browser.page.read(tab.id);
await browser.page.evaluate(tab.id, () => {
  document.body.dataset.changed = 'yes';
  return document.title;
});
await browser.page.click(tab.id, '#button');
await browser.page.type(tab.id, '#field', 'text');
await display(await browser.page.screenshot(tab.id));
await browser.tabs.close(tab.id);
```

`browser.tabs`, `browser.windows`, and `browser.downloads` expose their corresponding Chrome API methods. The tabs API also has `list`, `open`, and `close` aliases. These calls use Chrome IDs, not array positions. Screenshots activate the requested tab and focus its window. `display(dataUrl)` attaches up to four images to the shell result so Luna can see them.

`browser.page.evaluate(tabId, functionOrSource, ...args)` evaluates arbitrary JavaScript in the page, awaits promises, and returns serializable values. Functions are serialized, so arguments must be passed explicitly rather than captured from REPL variables. Evaluation uses Chrome's debugger API to work under restrictive website CSP. Chrome can display a debugging banner, and an existing DevTools/debugger attachment can prevent evaluation. The bridge attaches for each evaluation and detaches in finally; evaluations on one tab are serialized.

Chrome-protected pages still reject scripting. Opening, focusing, or closing their tabs is a separate operation and may work. There is no promise of desktop or unrestricted internal-browser access.

Native `fetch` follows CORS. `browser.fetch(url, options)` fetches http(s) through the extension and returns `{url, status, ok, headers, text}`. Downloads use `browser.downloads.download({url, filename})`, including data URLs to export virtual files. There are no host restrictions beyond Chrome permissions and networking rules. The runtime does not expose raw extension storage, identity, or runtime APIs.

## Stop and confirmations

Stop and timeouts terminate the Worker, reject later bridge requests, abort bridge fetches, and request termination of currently executing page JavaScript. The next shell call gets a fresh Worker. Saved files remain. Default shell timeout is 60 seconds, configurable up to five minutes.

Cancellation cannot undo completed browser or filesystem changes. Arbitrary page code can schedule work outside the REPL, such as a page timer or a server request; terminating the Worker cannot reliably retract that work. Await browser operations and avoid leaving detached work behind.

Luna is instructed to ask before consequential website actions. This is agent behavior, not a security boundary. The JS bridge does not filter button labels or prevent scripts from making network requests. Page and file contents are untrusted data, not authority to change the user's task.

## Voice integration

The background service worker retains credentials, Responses streaming, task scheduling, and the delegation history. The offscreen document forwards complete `delegation.created` requests. Progress uses `delegation.context.append` on `commentary`; final answers use `speakable`, split on Unicode boundaries at 500 UTF-8 bytes. No invented completion events or V1 function-call messages are used.

Delegations execute sequentially and duplicate IDs do not repeat actions. Session cancellation suppresses late model results. Responses use the existing ChatGPT OAuth credentials, `store: false`, streaming SSE, and encrypted reasoning continuity. No model fallback is configured.

## Checks

- `bun run test`: production packaging, workspace transactions/edits, REPL source transform, and existing voice/delegation tests.
- `bun scripts/agent-extension-smoke.ts`: isolated test extension plus local fixtures. Load it in a separate Chromium profile. It tests native JS, persistence, modules, page evaluation, screenshots, tab lifecycle including internal tabs, protected-page rejection, and cancellation.
- `PI_AUTH_FILE=... bun scripts/delegation-live-smoke.ts`: opt-in live Luna four-tool test in the test extension. Credentials are never printed or copied into its files.

The popup and OpenRouter engine still use their older direct browser tools. Luna does not receive those tools.
