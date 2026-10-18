// flow. setup - build the static installer frontend into setup/dist.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const src = path.join(root, "setup");
const out = path.join(src, "dist");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "css"), { recursive: true });
fs.mkdirSync(path.join(out, "assets"), { recursive: true });

for (const f of ["setup.css", "motion.css", "setup.js", "i18n.js", "api.js", "mock.js"]) {
  fs.copyFileSync(path.join(src, f), path.join(out, f));
}
let html = fs.readFileSync(path.join(src, "index.html"), "utf8");
html = html
  .replaceAll("/setup/setup.css", "setup.css")
  .replaceAll("/setup/motion.css", "motion.css")
  .replaceAll("/setup/setup.js", "setup.js");
fs.writeFileSync(path.join(out, "index.html"), html);

for (const f of ["base.css", "kit-controls.css"]) {
  fs.copyFileSync(path.join(root, "css", f), path.join(out, "css", f));
}
for (const dir of ["fonts", "phosphor"]) {
  fs.cpSync(path.join(root, "assets", dir), path.join(out, "assets", dir), { recursive: true });
}

let files = 0, bytes = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else { files++; bytes += fs.statSync(p).size; }
  }
})(out);
fs.writeFileSync(path.join(out, "build.json"), JSON.stringify({ built: new Date().toISOString(), files, bytes }, null, 2));
console.log(`setup dist ready: ${files} files, ${Math.round(bytes / 1024)} KB -> ${out}`);
