export type FileEdit = { oldText: string; newText: string };
type Entry = { path: string; kind: "file" | "directory"; text?: string };

export function normalizePath(value: unknown): string {
  if (typeof value !== "string" || !value || /[\x00-\x1f\\]/.test(value)) throw new Error("Use a nonempty virtual path with forward slashes.");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) throw new Error("Path escapes the workspace."); parts.pop(); }
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

/** Match every replacement against the original. Never apply a partial edit. */
export function replaceExact(text: string, edits: FileEdit[]): string {
  if (!Array.isArray(edits) || !edits.length) throw new Error("Provide at least one edit.");
  const ranges = edits.map(edit => {
    if (!edit || typeof edit.oldText !== "string" || !edit.oldText || typeof edit.newText !== "string") throw new Error("Edits require nonempty oldText and string newText.");
    const start = text.indexOf(edit.oldText);
    if (start < 0 || text.indexOf(edit.oldText, start + 1) >= 0) throw new Error("oldText must match exactly once.");
    return { start, end: start + edit.oldText.length, text: edit.newText };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]!.start < ranges[i - 1]!.end) throw new Error("Edits must not overlap.");
  for (const range of ranges.reverse()) text = text.slice(0, range.start) + range.text + text.slice(range.end);
  return text;
}

/** Dedicated IndexedDB database, separate from credentials. Transactions serialize mutations. */
export class Workspace {
  constructor(private readonly name = "voiceagent-workspace") {}
  async call(operation: string, args: unknown[]): Promise<unknown> {
    const path = normalizePath(args[0] ?? "/");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("entries", { keyPath: "path" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction("entries", "readwrite");
        const store = transaction.objectStore("entries");
        let result: unknown, failure: unknown;
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Workspace transaction aborted."));
        transaction.onerror = () => {};
        const request = store.getAll();
        request.onsuccess = () => {
          try {
            const entries = new Map<string, Entry>((request.result as Entry[]).map(entry => [entry.path, entry]));
            entries.set("/", { path: "/", kind: "directory" });
            const entry = entries.get(path);
            const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
            const mkdir = (p: string) => {
              let current = "";
              for (const part of p.split("/").filter(Boolean)) {
                current += "/" + part;
                if (entries.get(current)?.kind === "file") throw new Error(`A file exists at ${current}.`);
                const dir: Entry = { path: current, kind: "directory" };
                entries.set(current, dir); store.put(dir);
              }
            };
            const file = () => { if (entry?.kind !== "file") throw new Error(`No file at ${path}.`); return entry.text!; };
            const metadata = (e: Entry) => ({ path: e.path, type: e.kind, ...(e.kind === "file" ? { bytes: new TextEncoder().encode(e.text).length } : {}) });
            switch (operation) {
              case "read": result = file(); break;
              case "write":
              case "edit": {
                if (entry?.kind === "directory") throw new Error("Cannot overwrite a directory.");
                const text = operation === "edit" ? replaceExact(file(), args[1] as FileEdit[]) : args[1];
                if (typeof text !== "string") throw new Error("File content must be text.");
                mkdir(parent(path)); store.put({ path, kind: "file", text }); result = path; break;
              }
              case "mkdir": mkdir(path); result = path; break;
              case "list":
                if (entry?.kind !== "directory") throw new Error(`No directory at ${path}.`);
                result = [...entries.values()].filter(e => e.path !== "/" && parent(e.path) === path).map(metadata).sort((a, b) => a.path.localeCompare(b.path)); break;
              case "stat": if (!entry) throw new Error(`No entry at ${path}.`); result = metadata(entry); break;
              case "remove":
                if (!entry || path === "/") throw new Error("Cannot remove a missing entry or the workspace root.");
                if ([...entries.keys()].some(p => p.startsWith(path + "/"))) throw new Error("Directory is not empty.");
                store.delete(path); result = path; break;
              default: throw new Error(`Unknown filesystem operation: ${operation}.`);
            }
          } catch (error) { failure = error; transaction.abort(); }
        };
      });
    } finally { db.close(); }
  }
}
