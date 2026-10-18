// Verify the bundled RIFE engine pack.
//
//   node tools/verify-payload.mjs [payload-dir]
//
// The engine binary and weights are not in the source tree; CI checks them out
// from the `engine-pack` branch into setup/src-tauri/payload. This script is the
// gate: a release must never ship an engine that differs from these pins.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = path.resolve(process.argv[2] || path.join(root, "setup", "src-tauri", "payload"));

// sha256 + byte length of every file the wizard embeds with include_bytes!.
const PINS = {
  "rife-ncnn-vulkan.exe": ["e9b9d5db05ce5d6c411044527c8428a4be33a7ce27a77ee8a6caf6532eb6182d", 7246848],
  "rife-v4.26/flownet.bin": ["94d58e30b75d7c7609cfa6f3bdad524deddd14f5f75e85c36d2f827ef5c64731", 11360684],
  "rife-v4.26/flownet.param": ["79f16c28903f93f8308f0c4c947f8c7e0c17d99a57b85473e5f298dd578d137b", 67885],
  "rife-ncnn-vulkan.LICENSE.txt": ["05d1efd74427fcca5455814d0bbc89c2b76d35ec12cacd5f8ec1ef2bc377ebca", 1091],
};

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const rows = [];
let bad = 0;

for (const [rel, [hash, size]] of Object.entries(PINS)) {
  const file = path.join(dir, rel);
  if (!fs.existsSync(file)) {
    rows.push(["MISSING", rel, "", ""]);
    bad++;
    continue;
  }
  const actual = sha256(file);
  const actualSize = fs.statSync(file).size;
  const ok = actual === hash && actualSize === size;
  if (!ok) bad++;
  rows.push([ok ? "ok" : "MISMATCH", rel, actual.slice(0, 12), `${actualSize} / ${size}`]);
}

console.log(`payload: ${dir}`);
for (const [state, rel, hash, sizes] of rows) {
  console.log(`  ${state.padEnd(8)} ${rel.padEnd(30)} ${hash.padEnd(12)} ${sizes}`);
}
if (bad) {
  console.error(`\n${bad} file(s) failed verification - refusing to build the release.`);
  process.exit(1);
}
console.log(`\nRIFE 4.26 pack verified against the pinned sha256 (${Object.keys(PINS).length} files).`);
