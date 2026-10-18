// Static i18n audit. Two surfaces, two dictionaries: the app (src/i18n.js) and the
// setup wizard (setup/i18n.js). For each one, EN and FA must hold the same keys with no
// duplicates, and every literal key used in that surface's markup or modules must exist.
// Dynamic keys (template literals) are matched by their static prefix.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const SURFACES = [
  { name: "app", dict: "src/i18n.js", roots: ["src", "css", "index.html"] },
  { name: "setup", dict: "setup/i18n.js", roots: ["setup"] },
];

const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".git", ".vite", "gen", "shots", "payload"]);

function readDict(file) {
  const src = fs.readFileSync(path.join(root, file), "utf8");
  const block = (name) => {
    const start = src.indexOf(`const ${name} = {`);
    if (start < 0) throw new Error(`${file}: missing const ${name}`);
    const end = src.indexOf("\n};", start);
    return src.slice(start, end);
  };
  const keys = (text) => [...text.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((m) => m[1]);
  return { en: keys(block("EN")), fa: keys(block("FA")) };
}

function sources(roots) {
  const out = [];
  const visit = (p) => {
    const st = fs.statSync(path.join(root, p));
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(p))) return;
      for (const e of fs.readdirSync(path.join(root, p), { withFileTypes: true })) {
        visit(path.posix.join(p, e.name));
      }
    } else if (/\.(html|js)$/.test(st.isFile() ? path.basename(p) : "") && !p.endsWith("i18n.js")) {
      out.push(p);
    }
  };
  roots.forEach(visit);
  return out.sort();
}

const ATTRS = ["i18n", "i18n-html", "i18n-tip", "i18n-aria", "i18n-placeholder"];
const dup = (arr) => arr.filter((k, i) => arr.indexOf(k) !== i);
let failed = 0;

for (const surface of SURFACES) {
  const { en, fa } = readDict(surface.dict);
  const setEn = new Set(en);
  const setFa = new Set(fa);
  const files = sources(surface.roots);
  const used = new Set();

  for (const f of files) {
    const s = fs.readFileSync(path.join(root, f), "utf8");
    for (const attr of ATTRS) {
      for (const m of s.matchAll(new RegExp(`data-${attr}="([^"]+)"`, "g"))) used.add(m[1]);
    }
    for (const m of s.matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(m[1]);
    for (const m of s.matchAll(/\bi18n\w*\(\s*"([^"]+)"/g)) used.add(m[1]);
    for (const m of s.matchAll(/\bt\(\s*`([^`]+)`/g)) {
      const base = m[1].split("${")[0];
      if (base) used.add(base + "*");
    }
    // Keys handed around as data attributes / variables, e.g. titleKey = "done.removedTitle".
    for (const m of s.matchAll(/(?:Key|key)\s*[:=]\s*"([a-z0-9]+(?:\.[a-z0-9]+)+)"/g)) used.add(m[1]);
  }

  const problems = [];
  for (const k of en) if (!setFa.has(k)) problems.push(`${surface.name}: missing in FA: ${k}`);
  for (const k of fa) if (!setEn.has(k)) problems.push(`${surface.name}: missing in EN: ${k}`);
  for (const k of dup(en)) problems.push(`${surface.name}: duplicate EN key: ${k}`);
  for (const k of dup(fa)) problems.push(`${surface.name}: duplicate FA key: ${k}`);
  for (const k of used) {
    if (k.endsWith("*") || k.endsWith(".")) continue;
    if (!setEn.has(k)) problems.push(`${surface.name}: used but not in EN: ${k}`);
    if (!setFa.has(k)) problems.push(`${surface.name}: used but not in FA: ${k}`);
  }

  const prefixes = [...used].filter((u) => u.endsWith("*")).map((u) => u.slice(0, -1));
  const unused = en.filter((k) => !used.has(k) && !prefixes.some((p) => k.startsWith(p)));
  console.log(
    `${surface.name.padEnd(5)} ${String(en.length).padStart(3)} EN keys · ${String(fa.length).padStart(3)} FA keys · ` +
      `${String(used.size).padStart(3)} literal uses · ${files.length} files`,
  );
  if (unused.length) console.log(`      unused (ok for future copy): ${unused.length} keys`);
  if (problems.length) {
    failed = 1;
    console.error(`\nPROBLEMS (${surface.name}):\n${[...new Set(problems)].join("\n")}`);
  }
}

if (failed) process.exit(1);
console.log("\ni18n is complete and symmetric in both surfaces.");
