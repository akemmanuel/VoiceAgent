import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(root, "public"), dist, { recursive: true });

const result = await Bun.build({
  entrypoints: ["src/popup/index.tsx", "src/options/index.tsx", "src/background/index.ts"].map(path => join(root, path)),
  root: join(root, "src"),
  outdir: dist,
  naming: "[dir]/[name].[ext]",
  target: "browser",
  format: "esm",
  minify: true,
  splitting: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) throw new AggregateError(result.logs, "Extension bundle failed");

for (const page of ["popup", "options"]) {
  await Bun.write(join(dist, page, "index.html"), Bun.file(join(root, "src", page, "index.html")));
}

const css = Bun.spawn([
  "bun", "x", "--no-install", "@tailwindcss/cli",
  "-i", "src/styles/globals.css", "-o", "dist/styles.css", "--minify",
], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await css.exited !== 0) throw new Error("Tailwind compilation failed");
console.log("Built extension in dist/. Reload it from your browser's Extensions page.");
