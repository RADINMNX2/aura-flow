// flow. - the bridge to the Rust core. One surface, two backends:
//   live  -> Tauri invoke + events            (src-tauri/src/commands.rs)
//   mock  -> the browser harness in mock.js   (shown in the chrome pill, never hidden)
// Nothing else in the app may know which one is running.

import { mock } from "./mock.js";

const internals = typeof window !== "undefined" ? window.__TAURI_INTERNALS__ : null;
const g = typeof window !== "undefined" ? window.__TAURI__ : null;
export const live = Boolean(internals || g?.core?.invoke);
export const mode = live ? "live" : "mock";

async function call(cmd, args) {
  if (!live) {
    if (!mock[cmd]) throw new Error(`mock core has no "${cmd}"`);
    return mock[cmd](args);
  }
  const invoke = g?.core?.invoke || (await import("@tauri-apps/api/core")).invoke;
  return invoke(cmd, args);
}

async function listen(event, cb) {
  if (!live) return mock.listen(event, cb);
  const listenFn = g?.event?.listen || (await import("@tauri-apps/api/event")).listen;
  return listenFn(event, (e) => cb(e.payload));
}

// Absolute local paths -> a URL the webview may load. Async because the Tauri
// asset helper lives in an ES module we only pull in when we are inside Tauri.
export async function assetUrl(path) {
  if (!path) return "";
  const absolute = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
  if (!live) return absolute ? `/local/${encodeURIComponent(path)}` : `/${path.replace(/^\/+/, "")}`;
  const convert = g?.core?.convertFileSrc || (await import("@tauri-apps/api/core")).convertFileSrc;
  return convert(path);
}

export const ipc = {
  mode,
  probe: (path) => call("probe", { path }),
  scan: () => call("scan_engines", {}),
  plan: (job) => call("plan", { job }),
  start: (job) => call("start_job", { job }),
  cancel: () => call("cancel_job", {}),
  pick: () => call("pick_video", {}),
  pickDir: () => call("pick_dir", {}),
  reveal: (path) => call("reveal_path", { path }),
  gpu: (index) => call("gpu_sample", { gpu: Number.isFinite(Number(index)) ? Number(index) : null }),
  gpus: () => call("list_gpus", {}),
  openUrl: (url) => call("open_url", { url: String(url) }),
  onProgress: (cb) => listen("flow://progress", cb),
  onLog: (cb) => listen("flow://log", cb),
  onStage: (cb) => listen("flow://stage", cb),
  onDone: (cb) => listen("flow://done", cb),
};
