// flow. - toasts. Transient feedback only; anything needing an answer is a dialog.
// Rules honoured: hover pauses the timer, swipe dismisses, overflow is removed synchronously
// (an animated overflow guard would spin), and nothing prints a fake percentage.

import { $, el } from "./util.js";
import { t } from "./i18n.js";

const MAX = 4;
const ICONS = { ok: "ph-check-circle", warn: "ph-warning-octagon", error: "ph-x-circle", info: "ph-info" };
const MS = { ok: 4200, info: 4600, warn: 6200, error: 8000 };

function host() {
  const h = $("#toasts");
  if (!h) throw new Error("missing #toasts");
  return h;
}

export function toast({ title, body = "", kind = "info", ms, action, onAction, sticky = false }) {
  const life = sticky ? 0 : (ms ?? MS[kind] ?? 4500);
  const bar = el("i", { class: "t-bar", style: life ? { "--life": `${life}ms` } : null });
  const x = el("button", { class: "t-x", type: "button", "aria-label": t("ui.dismiss") }, el("i", { class: "ph ph-x" }));
  const node = el("div", { class: `toast ${kind}`, role: "status" }, [
    el("span", { class: "t-bub" }, el("i", { class: `ph ${ICONS[kind] || ICONS.info}` })),
    el("div", { class: "t-body" }, [el("b", {}, title), body ? el("span", {}, body) : null, action ? el("button", { class: "btn btn-xs btn-secondary t-undo", type: "button", onclick: () => { onAction?.(); dismiss(node); } }, action) : null]),
    x, bar,
  ]);

  const h = host();
  h.append(node);
  while (h.children.length > MAX) h.firstElementChild.remove();

  // The countdown lives in CSS; the timeout and the bar pause together on hover.
  // No per-toast requestAnimationFrame loop, so four toasts cost the compositor nothing.
  let remaining = life, started = 0, timer = 0;
  const startCountdown = () => {
    if (!remaining) return;
    started = performance.now();
    bar.style.animationPlayState = "running";
    timer = setTimeout(() => dismiss(node), remaining);
  };
  const pauseCountdown = () => {
    if (!remaining) return;
    clearTimeout(timer);
    remaining -= performance.now() - started;
    bar.style.animationPlayState = "paused";
  };
  if (life) { startCountdown(); node.addEventListener("pointerenter", pauseCountdown); node.addEventListener("pointerleave", () => { if (remaining <= 60) dismiss(node); else startCountdown(); }); }

  x.addEventListener("click", () => dismiss(node));

  // horizontal swipe out
  let sx = null;
  node.addEventListener("pointerdown", (e) => { if (e.target.closest("button")) return; sx = e.clientX; node.setPointerCapture(e.pointerId); });
  node.addEventListener("pointermove", (e) => { if (sx === null) return; const d = e.clientX - sx; if (d > 0) node.style.transform = `translateX(${d}px)`; });
  node.addEventListener("pointerup", (e) => {
    if (sx === null) return;
    const d = e.clientX - sx; sx = null;
    if (d > 90) { node.style.transform = ""; return dismiss(node); }
    node.style.transform = "";
  });

  return { node, close: () => dismiss(node) };
}

export function dismiss(node) {
  if (!node?.isConnected) return;
  node.classList.add("is-out");
  node.addEventListener("animationend", () => node.remove(), { once: true });
  setTimeout(() => node.remove(), 400);
}

export const clearToasts = () => { host().replaceChildren(); };
