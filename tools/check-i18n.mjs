// Static i18n audit: both dictionaries must have the same keys, and every literal key used
// in the markup or modules must exist. Dynamic keys (template literals) are checked by name.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const i18n = fs.readFileSync(path.join(root, "src/i18n.js"), "utf8");

function block(name) {
  const start = i18n.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`missing ${name}`);
  const end = i18n.indexOf("\n};", start);
  return i18n.slice(start, end);
}
function keys(src) {
  const out = [];
  for (const m of src.matchAll(/^\s*"([^"]+)"\s*:/gm)) out.push(m[1]);
  return out;
}
const en = keys(block("EN"));
const fa = keys(block("FA"));
const setEn = new Set(en), setFa = new Set(fa);
const dup = (arr) => arr.filter((k, i) => arr.indexOf(k) !== i);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(html|js)$/.test(e.name) && !p.includes("node_modules") && !p.includes("dist")) files.push(p);
  }
})(root);

const used = new Set();
for (const f of files) {
  if (f.endsWith("i18n.js")) continue;
  const s = fs.readFileSync(f, "utf8");
  for (const attr of ["i18n", "i18n-html", "i18n-tip", "i18n-aria", "i18n-placeholder"]) {
    for (const m of s.matchAll(new RegExp(`data-${attr}="([^"]+)"`, "g"))) used.add(m[1]);
  }
  for (const m of s.matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(m[1]);
  for (const m of s.matchAll(/\bt\(\s*`([^`]+)`/g)) {
    const base = m[1].split("${")[0];
    if (base) used.add(base + "*");
  }
}

const problems = [];
for (const k of en) if (!setFa.has(k)) problems.push(`missing in FA: ${k}`);
for (const k of fa) if (!setEn.has(k)) problems.push(`missing in EN: ${k}`);
for (const k of dup(en)) problems.push(`duplicate EN key: ${k}`);
for (const k of dup(fa)) problems.push(`duplicate FA key: ${k}`);
for (const k of used) {
  if (k.endsWith("*")) continue;
  if (k.endsWith(".")) continue;
  if (!setEn.has(k)) problems.push(`used but not in EN: ${k}`);
  if (!setFa.has(k)) problems.push(`used but not in FA: ${k}`);
}

const unused = en.filter((k) => !used.has(k) && ![...used].some((u) => u.endsWith("*") && k.startsWith(u.slice(0, -1))));
console.log(`EN keys: ${en.length} · FA keys: ${fa.length} · literal uses: ${used.size}`);
if (unused.length) console.log("unused (ok for future copy):", unused.join(", "));
if (problems.length) {
  console.error("\nPROBLEMS:\n" + [...new Set(problems)].join("\n"));
  process.exit(1);
}
console.log("i18n is complete and symmetric.");
