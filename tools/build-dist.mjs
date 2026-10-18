// Copies the shell into dist/, which is what the Tauri webview loads.
// No bundler: the app is HTML + layered CSS + ES modules by design.
import { cpSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const entry of ["index.html", "css", "src", "assets"]) {
  cpSync(join(ROOT, entry), join(OUT, entry), { recursive: true });
}

// dev/ is deliberately not copied: the browser harness loads its demo clips from the dev server.

let files = 0, bytes = 0;
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else { files++; bytes += statSync(p).size; }
  }
})(OUT);

writeFileSync(join(OUT, "build.json"), JSON.stringify({ files, bytes, at: new Date().toISOString() }, null, 2));
console.log(`dist ready: ${files} files, ${(bytes / 1024).toFixed(0)} KB -> ${relative(ROOT, OUT)}`);
