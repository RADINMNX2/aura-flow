// flow. setup - package the single-file installer.
// Uses the freshly built app NSIS as payload, then embeds the frontend and the RIFE pack.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));
const payload = path.join(root, "setup", "src-tauri", "payload");
// Versions come from the two tauri.conf.json files, the same way build.rs reads them,
// so a release bump renames the payload instead of silently reusing the old one.
const conf = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8")).version;
const appVersion = conf(path.join("src-tauri", "tauri.conf.json"));
const setupVersion = conf(path.join("setup", "src-tauri", "tauri.conf.json"));
const nsisName = `flow_${appVersion}_x64-setup.exe`;
const nsis = path.join(root, "target", "release", "bundle", "nsis", nsisName);
const appExe = path.join(root, "target", "release", "flow-studio.exe");

if (!fs.existsSync(nsis) || !fs.existsSync(appExe)) {
  console.error(`Build the app first: npm run build  (missing ${nsisName})`);
  process.exit(1);
}
fs.mkdirSync(payload, { recursive: true });
fs.copyFileSync(nsis, path.join(payload, nsisName));
const appOut = path.join(root, "release", `flow-${appVersion}-windows-x64-setup.exe`);
fs.mkdirSync(path.dirname(appOut), { recursive: true });
fs.copyFileSync(nsis, appOut);
console.log("payload: app installer synced (release copy refreshed)");

// The RIFE MIT pack is not committed. Pull it from an existing Flowframes install once,
// or point FLOW_RIFE_DIR at a compatible rife-ncnn folder.
const required = ["rife-ncnn-vulkan.exe", "rife-v4.26/flownet.bin", "rife-v4.26/flownet.param", "rife-ncnn-vulkan.LICENSE.txt"];
const missing = required.filter((f) => !fs.existsSync(path.join(payload, f)));
if (missing.length) {
  const source = process.env.FLOW_RIFE_DIR || path.join(process.env.LOCALAPPDATA || "", "Flowframes", "FlowframesData", "pkgs", "rife-ncnn");
  if (fs.existsSync(path.join(source, "rife-ncnn-vulkan.exe"))) {
    fs.copyFileSync(path.join(source, "rife-ncnn-vulkan.exe"), path.join(payload, "rife-ncnn-vulkan.exe"));
    fs.mkdirSync(path.join(payload, "rife-v4.26"), { recursive: true });
    fs.copyFileSync(path.join(source, "rife-v4.26", "flownet.bin"), path.join(payload, "rife-v4.26", "flownet.bin"));
    fs.copyFileSync(path.join(source, "rife-v4.26", "flownet.param"), path.join(payload, "rife-v4.26", "flownet.param"));
    const license = path.join(process.env.LOCALAPPDATA || "", "Flowframes", "FlowframesData", "pkgs", "licenses", "rife-ncnn-vulkan.txt");
    if (fs.existsSync(license)) fs.copyFileSync(license, path.join(payload, "rife-ncnn-vulkan.LICENSE.txt"));
    console.log("payload: RIFE pack synced from", source);
  } else {
    console.error("Missing RIFE payload and no Flowframes pack found. Set FLOW_RIFE_DIR or install Flowframes.");
    process.exit(1);
  }
}

const dist = spawnSync(process.execPath, [path.join(root, "setup", "tools", "build.mjs")], { stdio: "inherit" });
if (dist.status !== 0) process.exit(dist.status || 1);

// Cargo can leave a stale "fresh" verdict for the bin after clean, so the embedded
// frontend/dist change never lands. Remove the outputs and bump the entry source
// timestamp so the release bin is always recompiled + relinked.
for (const stale of [
  path.join(root, "target", "release", "flow-setup.exe"),
  path.join(root, "target", "release", "deps", "flow_setup.exe"),
  path.join(root, "target", "release", "deps", "flow_setup.pdb"),
]) {
  try { fs.rmSync(stale, { force: true }); } catch {}
}
const now = new Date();
fs.utimesSync(path.join(root, "setup", "src-tauri", "src", "main.rs"), now, now);
const build = spawnSync(
  "cargo",
  ["build", "-p", "flow-setup", "--release", "--features", "custom-protocol"],
  { stdio: "inherit", cwd: root },
);
if (build.status !== 0) process.exit(build.status || 1);

const exe = path.join(root, "target", "release", "flow-setup.exe");
const release = path.join(root, "release");
fs.mkdirSync(release, { recursive: true });
const out = path.join(release, `flow-setup-${setupVersion}-windows-x64.exe`);
for (let i = 0; i < 6; i++) {
  try { fs.rmSync(out, { force: true }); fs.copyFileSync(exe, out); break; }
  catch (e) { if (i === 5) throw e; spawnSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 500"], { stdio: "ignore" }); }
}
const mb = (fs.statSync(out).size / 1048576).toFixed(1);
console.log(`setup ready: ${out} (${mb} MB)`);
