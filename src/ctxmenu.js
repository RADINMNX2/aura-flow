// flow. - a real context menu: contextual actions, a keyboard path, one level of submenu,
// and viewport-aware placement. Right-clicking text fields keeps the native menu.

import { $, el, clamp } from "./util.js";
import { dropTip } from "./tips.js";
import { t } from "./i18n.js";

let getItems = null;
let open = null;
let sub = null;
let anchor = null;
let onClose = null;

const isNative = (t) =>
  t.closest?.("input, textarea, select, [contenteditable='true'], a[href]") ||
  document.querySelector(".ovl, .pal");

export function initContextMenu(builder) {
  getItems = builder;

  document.addEventListener("contextmenu", (e) => {
    if (isNative(e.target)) return;
    e.preventDefault();
    openAt(e.clientX, e.clientY, e.target);
  });

  // Shift+F10 / the menu key opens at the focused control, like a native app.
  document.addEventListener("keydown", (e) => {
    if (!(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return;
    e.preventDefault();
    const t = document.activeElement || document.body;
    const r = t.getBoundingClientRect();
    openAt(r.left + Math.min(r.width / 2, 40), r.bottom - 8, t);
  });
}

export function openAt(x, y, target) {
  close();
  dropTip();
  const items = getItems?.({ x, y, target });
  if (!items?.length) return;
  anchor = target;

  const menu = el("div", { class: "ctx", role: "menu", "aria-label": t("ctx.shortcut"), tabindex: "-1" });
  menu.append(...renderItems(items, menu));
  $("#ctx-root").append(menu);
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", keys, true);
  document.addEventListener("scroll", close, true);
  addEventListener("resize", close);
  addEventListener("blur", close);
  open = menu;

  // measure, then place with a real flip
  const r = menu.getBoundingClientRect();
  let left = x, top = y;
  if (left + r.width > innerWidth - 8) {
    left = x - r.width;
    if (left < 8) left = clamp(x, 8, Math.max(8, innerWidth - r.width - 8));
  }
  if (top + r.height > innerHeight - 8) top = Math.max(8, y - r.height);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.transformOrigin = `${Math.round(clamp(x - left, 10, r.width - 10))}px ${Math.round(clamp(y - top, 8, r.height - 8))}px`;
  menu.classList.add("is-in");
  setTimeout(() => menu.querySelector(".ctx-o:not([disabled])")?.focus({ preventScroll: true }), 16);
}

export function close() {
  document.removeEventListener("pointerdown", outside, true);
  document.removeEventListener("keydown", keys, true);
  document.removeEventListener("scroll", close, true);
  removeEventListener("resize", close);
  removeEventListener("blur", close);
  closeSub();
  if (!open) return;
  const m = open;
  open = null;
  anchor = null;
  m.classList.add("is-out");
  setTimeout(() => m.remove(), 130);
  onClose?.();
}

function outside(e) {
  if (open?.contains(e.target) || sub?.contains(e.target)) return;
  close();
}

function renderItems(items, root, inSub = false) {
  const nodes = [];
  for (const it of items) {
    if (!it) continue;
    if (it.kind === "sep") { nodes.push(el("div", { class: "ctx-sep", role: "separator" })); continue; }
    if (it.kind === "group") { nodes.push(el("div", { class: "ctx-g", role: "presentation" }, it.label)); continue; }
    const btn = el("button", {
      class: "ctx-o" + (it.danger ? " is-danger" : "") + (it.checked ? " is-checked" : "") + (it.submenu ? " has-sub" : ""),
      type: "button", role: it.checked != null ? "menuitemradio" : "menuitem",
      "aria-checked": it.checked != null ? String(!!it.checked) : null,
      disabled: it.disabled || null,
      "aria-haspopup": it.submenu ? "menu" : null,
      "aria-expanded": it.submenu ? "false" : null,
      onclick: () => {
        if (it.submenu) { toggleSub(btn, it.submenu); return; }
        close();
        setTimeout(() => it.action?.(), 20);
      },
    }, [
      el("i", { class: `ph ${it.icon || "ph-dot"}` }),
      el("span", { class: "ctx-l" }, it.label),
      it.keys ? el("kbd", {}, it.keys) : null,
      it.submenu ? el("i", { class: "ph ph-caret-right ctx-car" }) : it.checked != null ? el("i", { class: "ph ph-check ctx-ck" }) : null,
    ]);
    if (it.submenu) {
      btn.addEventListener("pointerenter", () => toggleSub(btn, it.submenu));
      btn._sub = it.submenu;
    } else if (btn.classList.contains("has-sub") === false) {
      btn.addEventListener("pointerenter", () => closeSub());
    }
    nodes.push(btn);
  }
  return nodes;
}

function toggleSub(btn, items) {
  if (sub && sub._owner === btn) { closeSub(); return; }
  closeSub();
  const panel = el("div", { class: "ctx ctx-sub", role: "menu", tabindex: "-1" });
  panel._owner = btn;
  btn.classList.add("is-open");
  btn.setAttribute("aria-expanded", "true");
  panel.append(...renderItems(items, panel, true));
  $("#ctx-root").append(panel);
  const r = btn.getBoundingClientRect();
  panel.style.visibility = "hidden";
  const pr = panel.getBoundingClientRect();
  const dir = document.documentElement.dir === "rtl" ? -1 : 1;
  let left = r.right - 4;
  if (dir < 0) left = r.left - pr.width + 4;
  if (left + pr.width > innerWidth - 8) left = r.left - pr.width + 4;
  if (left < 8) left = clamp(r.right + 4, 8, innerWidth - pr.width - 8);
  const top = clamp(r.top - 6, 8, innerHeight - pr.height - 8);
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.visibility = "";
  panel.classList.add("is-in");
  sub = panel;
  // hover out to the owner row keeps it open; moving into the panel keeps it too
  panel.addEventListener("pointerleave", (e) => {
    if (btn.contains(e.relatedTarget)) return;
    setTimeout(() => { if (sub === panel && !panel.matches(":hover")) closeSub(); }, 140);
  });
}

function closeSub() { if (sub) { sub._owner?.classList.remove("is-open"); sub._owner?.setAttribute("aria-expanded", "false"); sub.remove(); sub = null; } }

function visibleRows() {
  const scope = sub || open;
  return scope ? [...scope.querySelectorAll(".ctx-o:not([disabled])")] : [];
}

function keys(e) {
  if (!open) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
  if (e.key === "Tab") { e.preventDefault(); close(); return; }
  if (sub && e.key === "ArrowLeft") { e.preventDefault(); closeSub(); open?.querySelector(".ctx-o:focus")?.focus(); return; }
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
    e.preventDefault();
    const rows = visibleRows();
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : i < 0 ? 0 : (i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
    closeSub();
    rows[next].focus({ preventScroll: true });
    return;
  }
  if (e.key === "ArrowRight") {
    const row = document.activeElement;
    if (row?._sub) { e.preventDefault(); toggleSub(row, row._sub); }
    return;
  }
  if (e.key === "Enter" || e.key === " ") {
    if (document.activeElement?.classList.contains("ctx-o")) return; // native click
    e.preventDefault();
  }
}
