// flow. - the journal: what the core actually said, in order, with real timestamps.

import { $, el } from "./util.js";
import { t, onLang } from "./i18n.js";

const MAX_LINES = 400;
let count = 0;
let expanded = false;

export function log(text, level = "info") {
  const pre = $("#journal");
  const badge = $("#journal-count");
  if (!pre) return;
  const now = new Date();
  const stamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  const cls = { info: "j-dim", ok: "j-ok", warn: "j-warn", error: "j-err" }[level] || "j-dim";
  pre.append(el("span", { class: `j-line ${cls}` }, [el("span", { class: "j-t" }, `${stamp}  `), text, "\n"]));
  while (pre.childElementCount > MAX_LINES) pre.firstElementChild.remove();
  count++;
  if (badge) badge.textContent = t("j.lines", { n: count });
  pre.scrollTop = pre.scrollHeight;
  console.log(`[flow:${level}]`, text);
}

export function initJournal() {
  const btn = $("#btn-journal");
  const body = $("#journal-body");
  if (!btn || !body) return;
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") === "true";
    expanded = !open;
    btn.setAttribute("aria-expanded", String(!open));
    body.hidden = open;
    paintButton(btn);
    btn.querySelector("i").className = `ph ph-caret-${open ? "down" : "up"}`;
    if (!open) { const pre = $("#journal"); pre.scrollTop = pre.scrollHeight; }
  });
  onLang(() => {
    paintButton(btn);
    const badge = $("#journal-count");
    if (badge) badge.textContent = t("j.lines", { n: count });
  });
}

function paintButton(btn) {
  const span = btn?.querySelector("span");
  if (!span) return;
  span.textContent = expanded ? t("j.hide") : t("j.open");
}

export const resetJournal = () => { count = 0; const pre = $("#journal"); if (pre) pre.replaceChildren(); };
