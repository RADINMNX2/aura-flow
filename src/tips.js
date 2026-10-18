// flow. - one delegated tooltip system for every [data-tip] in the app.
// Precision rules: 420ms pointer delay (0ms for keyboard), viewport-aware flip on both axes,
// two-line tips via "Title|Detail", and a real aria-describedby link while visible.

import { $, el, clamp } from "./util.js";

const DELAY = 420;
const GRACE = 120;
let node = null, hideTimer = 0, showTimer = 0, current = null, target = null;

function box() {
  if (node) return node;
  node = $("#tip") || el("div", { class: "tip", id: "tip", role: "tooltip", "aria-hidden": "true" });
  if (!node.parentNode) document.body.append(node);
  return node;
}

function place() {
  if (!target) return;
  const t = box();
  const r = target.getBoundingClientRect();
  const tr = t.getBoundingClientRect();
  const gap = 10;
  const safe = 10;
  const vw = innerWidth;
  const vh = innerHeight;

  // vertical: above by default, below when above clips (and below has more room), clamp last
  const above = r.top - gap - safe;
  const belowRoom = vh - safe - r.bottom - gap;
  const below = tr.height > above && belowRoom >= above;
  let top = below ? r.bottom + gap : r.top - tr.height - gap;
  top = clamp(top, safe, vh - tr.height - safe);

  // horizontal: center, clamp to the viewport, then point the arrow at the real target center
  let left = clamp(r.left + r.width / 2 - tr.width / 2, safe, vw - tr.width - safe);
  const ax = clamp(r.left + r.width / 2 - left, 12, tr.width - 12);

  t.style.left = `${Math.round(left)}px`;
  t.style.top = `${Math.round(top)}px`;
  t.style.setProperty("--ax", `${Math.round(ax)}px`);
  t.classList.toggle("is-below", below);
}

function render(text) {
  const t = box();
  const [head, ...rest] = String(text).split("|");
  const body = rest.join("|").trim();
  t.replaceChildren(
    body ? el("b", {}, head.trim()) : null,
    el("span", {}, body || head.trim())
  );
  t.classList.toggle("is-rich", Boolean(body));
}

function show(elTarget, instant = false) {
  const text = elTarget?.dataset?.tip;
  if (!text) return;
  if (elTarget === target && node?.classList.contains("is-on")) return;
  clearTimeout(hideTimer);
  clearTimeout(showTimer);
  target = elTarget;
  const run = () => {
    render(text);
    box().hidden = false;
    box().setAttribute("aria-hidden", "false");
    place();
    void box().offsetWidth;
    box().classList.add("is-on");
    document.querySelectorAll("[aria-describedby='tip']").forEach((n) => n !== elTarget && n.removeAttribute("aria-describedby"));
    elTarget.setAttribute("aria-describedby", "tip");
    current = text;
  };
  if (instant) run();
  else showTimer = setTimeout(run, DELAY);
}

function hide() {
  clearTimeout(showTimer);
  current = null;
  if (!node) return;
  node.classList.remove("is-on");
  node.setAttribute("aria-hidden", "true");
  target?.removeAttribute("aria-describedby");
  target = null;
  hideTimer = setTimeout(() => { if (node) node.hidden = true; }, GRACE);
}

export function initTips() {
  document.addEventListener("pointerover", (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (!t) { if (target) hide(); return; }
    if (t === target) return;
    show(t);
  });
  document.addEventListener("pointerout", (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (t && !t.contains(e.relatedTarget)) hide();
  });
  document.addEventListener("focusin", (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (t) show(t, true);
  });
  document.addEventListener("focusout", (e) => {
    if (e.target.closest?.("[data-tip]")) hide();
  });
  document.addEventListener("pointerdown", () => hide());
  addEventListener("scroll", () => hide(), true);
  addEventListener("resize", () => hide());
  addEventListener("blur", () => hide());
}

// Tooltips must not survive a re-render of the control that owned them.
export const dropTip = () => { clearTimeout(showTimer); current = null; hide(); };
