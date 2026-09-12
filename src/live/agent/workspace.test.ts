import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import { Workspace, normalizePath, replaceExact } from "./workspace";
import { compileRepl } from "./transform";

const workspace = () => new Workspace(crypto.randomUUID());
test("files survive new workspace instances; write creates parent directories", async () => {
  const name = crypto.randomUUID(), fs = new Workspace(name);
  await fs.call("write", ["/a/b.txt", "héllo"]);
  expect(await new Workspace(name).call("read", ["a/b.txt"])).toBe("héllo");
  expect(await fs.call("list", ["/a"])).toEqual([{ path: "/a/b.txt", type: "file", bytes: 6 }]);
  await expect(fs.call("remove", ["/a"])).rejects.toThrow("not empty");
  await fs.call("remove", ["/a/b.txt"]);
  await fs.call("remove", ["/a"]);
});
test("edits are original-based, unique, nonoverlapping and atomic", async () => {
  const fs = workspace();
  await fs.call("write", ["/file", "alpha beta gamma"]);
  await fs.call("edit", ["/file", [{ oldText: "alpha", newText: "beta" }, { oldText: "beta", newText: "two" }]]);
  expect(await fs.call("read", ["/file"])).toBe("beta two gamma");
  await expect(fs.call("edit", ["/file", [{ oldText: "two", newText: "changed" }, { oldText: "missing", newText: "x" }]])).rejects.toThrow("exactly once");
  expect(await fs.call("read", ["/file"])).toBe("beta two gamma");
  expect(() => replaceExact("aaa", [{ oldText: "aa", newText: "x" }])).toThrow("exactly once");
  expect(() => replaceExact("abcd", [{ oldText: "abc", newText: "x" }, { oldText: "cd", newText: "y" }])).toThrow("overlap");
});
test("concurrent edits serialize without losing successful updates", async () => {
  const fs = workspace();
  await fs.call("write", ["/file", "one two"]);
  await Promise.all([fs.call("edit", ["/file", [{ oldText: "one", newText: "1" }]]), fs.call("edit", ["/file", [{ oldText: "two", newText: "2" }]])]);
  expect(await fs.call("read", ["/file"])).toBe("1 2");
});
test("path traversal and file/directory collisions are rejected", async () => {
  const fs = workspace();
  expect(normalizePath("/a/../b")).toBe("/b");
  expect(() => normalizePath("../../secret")).toThrow("escapes");
  await fs.call("write", ["/a", "keep"]);
  await expect(fs.call("write", ["/a/b", "bad"])).rejects.toThrow("file exists");
  expect(await fs.call("read", ["/a"])).toBe("keep");
});
test("native REPL transform supports persistent declarations, destructuring and await", async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = (code: string) => new AsyncFunction(compileRepl(code))();
  try {
    expect(await run("const replNumber = await Promise.resolve(20); replNumber + 1")).toBe(21);
    expect(await run("replNumber += 2; replNumber")).toBe(22);
    expect(await run("let {a: replA, b: replB = 3} = {a: 2}; replA + replB")).toBe(5);
    expect(await run("replFn(); function replFn(){ return replNumber; }")).toBeUndefined();
    expect(await run("replFn()")).toBe(22);
    expect(await run("class ReplClass { n = 42 }; new ReplClass().n")).toBe(42);
    expect(await run("const replNumber = 9; replNumber")).toBe(9);
    expect(await run("{ let blockLocal = 1; } typeof blockLocal")).toBe("undefined");
    expect(await run("var replText = `a;${await Promise.resolve('b')}`; replText")).toBe("a;b");
  } finally {
    for (const key of ["replNumber", "replA", "replB", "replFn", "ReplClass", "replText"]) delete (globalThis as any)[key];
  }
});
