// flow. - the wizard: three panes, one scroll surface, Lenis smoothing, view transitions.

import { $, $$, clamp, dash } from "./util.js";
import Lenis from "../assets/lenis/lenis.mjs";

const REDUCE = matchMedia("(prefers-reduced-motion: reduce)").matches;
let lenis = null;
let step = 0;
let panes = [];
let navButtons = [];
let onStep = null;
let ghost = false;

export function initWizard({ onEnter } = {}) {
  onStep = onEnter;
  panes = $$(".pane");
  navButtons = $$("#wiz-steps .wst");
  const scroller = $("#wiz-scroll");

  if (!REDUCE) {
    lenis = new Lenis({ wrapper: scroller, content: $("#wiz-inner"), duration: 0.85, smoothWheel: true, wheelMultiplier: 1, touchMultiplier: 1.2 });
    const raf = (t) => { lenis.raf(t); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    // Lenis adds a class; keep the native scrollbar for the keyboard path.
  }

  navButtons.forEach((b, i) => {
    b.addEventListener("click", () => {
      if (b.disabled || i === step) return;
      go(i);
    });
  });

  addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, select")) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const rtl = document.documentElement.dir === "rtl";
    const fwd = rtl ? "ArrowLeft" : "ArrowRight";
    const backKey = rtl ? "ArrowRight" : "ArrowLeft";
    if (e.key === fwd && step < 2 && !panes[step].querySelector(".dz-hero:not([hidden])")) go(step + 1);
    if (e.key === backKey && step > 0) go(step - 1);
  });

  addEventListener("resize", layoutSteps);
  apply(0, true);
  requestAnimationFrame(layoutSteps);
  document.fonts?.ready.then(() => layoutSteps());
  return { go, next, back, step: () => step, unlock, relayout: layoutSteps, resize: () => lenis?.resize() };
}

function next() { if (step < 2) go(step + 1); }
function back() { if (step > 0) go(step - 1); }

function apply(i, silent = false) {
  step = i;
  panes.forEach((p, k) => {
    const on = k === i;
    p.hidden = !on;
    p.classList.toggle("is-active", on);
    if (on && !silent && !document.startViewTransition) {
      p.classList.remove("is-in");
      void p.offsetWidth;
      p.classList.add("is-in");
    }
  });
  navButtons.forEach((b, k) => {
    b.classList.toggle("is-now", k === i);
    b.classList.toggle("is-done", k < i);
    if (k === i) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
  });
  layoutSteps();
  const nav = $("#wiz-steps");
  if (nav && !silent) {
    nav.classList.remove("is-sweep");
    void nav.offsetWidth;
    nav.classList.add("is-sweep");
    setTimeout(() => nav.classList.remove("is-sweep"), 700);
  }
  lenis?.resize();
  lenis?.scrollTo(0, { immediate: true });
  if (!lenis) $("#wiz-scroll").scrollTop = 0;
  onStep?.(i);
}

export function go(i) {
  i = clamp(i, 0, 2);
  if (i === step || !panes.length) return;
  if (i > 0 && document.querySelector("#pane-source .dz-hero:not([hidden])")) return; // no source yet
  if (REDUCE || !document.startViewTransition || ghost) { apply(i); return; }
  ghost = true;
  const vt = document.startViewTransition(() => apply(i));
  vt.finished.finally(() => { ghost = false; });
}

export function unlock(i) {
  const b = navButtons[i];
  if (b) b.disabled = false;
}

export function setStepMeta(i, text) {
  const el = document.querySelector(`#wst-sub-${i}`);
  if (!el || el.textContent === text) return;
  el.textContent = text;
  el.style.opacity = text ? "" : "0";
  el.classList.remove("is-new");
  void el.offsetWidth;
  el.classList.add("is-new");
}

function layoutSteps() {
  const nav = $("#wiz-steps");
  const btn = navButtons[step];
  if (!nav || !btn) return;
  nav.style.setProperty("--ind-w", `${btn.offsetWidth}px`);
  nav.style.setProperty("--ind-x", `${btn.offsetLeft}px`);
}
