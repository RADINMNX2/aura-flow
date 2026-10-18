// flow. - shared helpers. No dependencies, no side effects.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "text") n.textContent = v;
    else if (k === "style" && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === null || sv === undefined) continue;
        if (sk.startsWith("--")) n.style.setProperty(sk, String(sv));
        else n.style[sk] = sv;
      }
    }
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of [].concat(kids)) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round = (v, d = 0) => { const m = 10 ** d; return Math.round(v * m) / m; };

export function bytes(n) {
  if (!Number.isFinite(n)) return "-";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = Math.abs(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function clock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "-:--";
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60);
  if (m >= 60) { const h = Math.floor(m / 60); return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`; }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function clockMs(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00.0";
  const m = Math.floor(sec / 60), r = sec - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
}

export const pct = (v, d = 0) => `${round(v * 100, d)}%`;
export const fps = (v, d = 1) => `${round(v, d)} fps`;

export function plural(n, one, many = one + "s") { return `${n} ${n === 1 ? one : many}`; }

// rAF-throttled: one write per frame no matter how many events arrive.
export function raf(fn) {
  let queued = false, last = null;
  return (...args) => {
    last = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...last); });
  };
}

export function debounce(fn, ms = 220) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function uid(prefix = "id") { return `${prefix}-${Math.random().toString(36).slice(2, 8)}`; }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SVG progress arcs: one dash as long as the real path, offset by the fraction left.
// pathLength is deliberately not used; getTotalLength() is exact per path.
export function dash(el, frac) {
  if (!el) return;
  const len = el.getTotalLength ? el.getTotalLength() : 100;
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  el.style.strokeDasharray = `${len}`;
  el.style.strokeDashoffset = `${len * (1 - f)}`;
}
