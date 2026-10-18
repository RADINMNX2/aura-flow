// Copies the only third-party runtime assets out of node_modules, so the app ships offline.
// Fonts are committed in assets/fonts (the three woff2 files); icons, Lenis and GSAP are vendored.
import { cpSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NM = join(ROOT, "node_modules");

// Phosphor: only the two weights the house style uses.
const PKG = join(NM, "@phosphor-icons", "web", "src");
for (const weight of ["regular", "fill"]) {
  const face = weight === "fill" ? "Phosphor-Fill" : "Phosphor";
  const dir = join(ROOT, "assets", "phosphor", weight);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(PKG, weight, face + ".woff2"), join(dir, face + ".woff2"));
  writeFileSync(join(dir, "style.css"), readFileSync(join(PKG, weight, "style.css"), "utf8"));
  console.log("phosphor/" + weight);
}

// Lenis: smooth scroll, vendored as an ES module.
mkdirSync(join(ROOT, "assets", "lenis"), { recursive: true });
cpSync(join(NM, "lenis", "dist", "lenis.mjs"), join(ROOT, "assets", "lenis", "lenis.mjs"));
console.log("lenis");

// GSAP: the UMD build is the only one that runs without a bundler.
mkdirSync(join(ROOT, "assets", "gsap"), { recursive: true });
cpSync(join(NM, "gsap", "dist", "gsap.min.js"), join(ROOT, "assets", "gsap", "gsap.min.js"));
console.log("gsap");
