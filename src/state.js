// flow. - the store. One object, subscribers per key path, persisted recipe settings.

import { uid } from "./util.js";

const KEY = "aura-flow.settings.v1";

export const DEFAULTS = {
  engine: "rife-ncnn",
  model: "rife-v4.26",
  factor: 4,
  customFps: false,
  targetFps: 60,
  codec: "h264",
  quality: 78,
  preset: "slow",
  keepAudio: true,
  keepSubs: true,
  sceneDetect: true,
  sceneThresh: 0.2,
  tile: 0,
  tta: false,
  gpu: 0,
  tempOn: "input",
  outDir: "",
  journalOpen: false,
};

// A settings file is user-editable and survives crashes: anything that is not a finite
// number where a number belongs falls back to the default instead of poisoning every plan.
function sanitize(obj) {
  const out = { ...DEFAULTS };
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = obj?.[k];
    if (v === null || v === undefined || v === "") continue;
    if (typeof def === "number") {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    } else if (typeof def === "boolean") {
      if (typeof v === "boolean") out[k] = v;
    } else if (typeof def === "string") {
      if (typeof v === "string" && v.length) out[k] = v;
    }
  }
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    const clean = sanitize(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(clean)) {
      try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch { /* ignore */ }
    }
    return clean;
  } catch { return { ...DEFAULTS }; }
}

const settings = load();
const runtime = {
  id: uid("job"),
  source: null,      // { name, path, size, probe }
  models: [],        // scanned from the engine folder
  engines: [],
  running: false,
  stage: "idle",     // idle | probe | extract | interp | encode | mux | done | error | cancelled
  progress: { overall: 0, stageP: 0, done: 0, total: 0, fps: 0, eta: null },
  gpu: { util: 0, vram: 0, vramTotal: 8192, temp: 0 },
  result: null,      // { path, outFps, frames, seconds, bytes, ms }
  coreMode: "mock",  // mock | live
};

const subs = new Map(); // key -> Set<fn>; "*" for everything

function emit(key, value) {
  for (const fn of subs.get(key) || []) { try { fn(value, key); } catch (e) { console.error("[store]", key, e); } }
  for (const fn of subs.get("*") || []) { try { fn(value, key); } catch (e) { console.error("[store]", key, e); } }
}

export function get(key) { return key ? settings[key] : settings; }

// The UI speaks 0-100 quality; x264 speaks CRF where lower is better.
export function crfOf(quality) {
  const q = Math.max(0, Math.min(100, Number(quality) || 0));
  return Math.round(36 - (q / 100) * 24);
}
export function rt(key) { return key ? runtime[key] : runtime; }

export function set(patch) {
  const changed = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (DEFAULTS[k] !== undefined && typeof DEFAULTS[k] === "number" && !Number.isFinite(Number(v))) continue;
    if (settings[k] === v) continue;
    settings[k] = v;
    changed.push(k);
  }
  if (changed.length) {
    persist();
    for (const k of changed) emit(k, settings[k]);
  }
  return changed;
}

export function setRt(patch) {
  for (const [k, v] of Object.entries(patch)) {
    runtime[k] = v;
    emit(k, v);
  }
}

export function on(key, fn) {
  if (!subs.has(key)) subs.set(key, new Set());
  subs.get(key).add(fn);
  return () => subs.get(key).delete(fn);
}

let writeTimer = 0;
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ }
  }, 240);
}
