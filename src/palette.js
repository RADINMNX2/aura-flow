// flow. - Ctrl+K. Every command here is wired to the same handler the button uses; nothing is a stub.

import { $, el, clamp } from "./util.js";
import { t } from "./i18n.js";

let host, box, input, list, active = 0, cmds = [], filtered = [], source = null;

export function initPalette(items) {
  host = $("#palette-root");
  source = items;
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); toggle(); }
  });
}

export function isOpen() { return Boolean(box); }

function toggle() { box ? close() : open(); }

function open() {
  cmds = typeof source === "function" ? source() : source || [];
  box = el("div", { class: "pal" });
  input = el("input", { id: "pal-input", name: "command", type: "text", placeholder: t("pal.placeholder"), "aria-label": t("pal.aria"), oninput: () => render() });
  list = el("div", { class: "pal-list", role: "listbox", "aria-label": t("pal.commands") });
  box.append(el("div", { class: "pal-box glass" }, [
    el("div", { class: "pal-in" }, [el("i", { class: "ph ph-command" }), input]),
    list,
    el("div", { class: "pal-foot" }, [el("span", {}, t("pal.move")), el("span", {}, t("pal.run")), el("span", {}, t("pal.close"))]),
  ]));
  box.addEventListener("pointerdown", (e) => { if (e.target === box) close(); });
  host.replaceChildren(box);
  document.addEventListener("keydown", keys, true);
  render();
  input.focus({ preventScroll: true });
}

export function close() {
  document.removeEventListener("keydown", keys, true);
  if (box) box.style.animation = "ovl-out 0.16s var(--ease) both";
  setTimeout(() => { host?.replaceChildren(); box = null; }, 160);
}

function keys(e) {
  if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); return close(); }
  if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
  if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  if (e.key === "Enter") { e.preventDefault(); run(filtered[active]); }
}

function move(d) {
  const rows = [...list.children].filter((c) => c.classList.contains("pal-o"));
  rows[active]?.classList.remove("is-act");
  active = clamp(active + d, 0, rows.length - 1);
  rows[active]?.classList.add("is-act");
  rows[active]?.scrollIntoView({ block: "nearest" });
}

function run(c) {
  if (!c) return;
  close();
  setTimeout(() => c.run(), 40);
}

function render() {
  const q = input.value.trim().toLowerCase();
  filtered = cmds.filter((c) => !q || `${c.group} ${c.label} ${c.keys || ""}`.toLowerCase().includes(q));
  active = 0;
  list.replaceChildren();
  let group = null;
  for (const c of filtered) {
    if (c.group !== group) { group = c.group; list.append(el("div", { class: "pal-g" }, group)); }
    const row = el("button", { class: "pal-o" + (c === filtered[active] ? " is-act" : ""), type: "button", role: "option", onclick: () => run(c) }, [
      el("i", { class: `ph ${c.icon || "ph-play"}` }),
      el("span", {}, c.label),
      c.keys ? el("kbd", { class: "pal-h" }, c.keys) : null,
    ]);
    list.append(row);
  }
  if (!filtered.length) list.append(el("div", { class: "pal-g" }, t("pal.none")));
}
