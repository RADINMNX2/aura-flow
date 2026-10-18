// flow. - dialogs. A dialog is only for a blocking question; anything transient is a toast.

import { $, el, round } from "./util.js";
import { sw, field, combo } from "./controls.js";
import { get, set, rt } from "./state.js";
import { ipc, live } from "./ipc.js";
import { toast } from "./toasts.js";
import { log } from "./journal.js";
import { t, AUTHOR, AUTHOR_URL, VERSION } from "./i18n.js";

let open = null;
let returnFocus = null;

export const isOpen = () => Boolean(open);

function shell({ title, sub, body, actions }) {
  close();
  returnFocus = document.activeElement;
  const root = $("#modal-root");
  const ovl = el("div", { class: "ovl", role: "dialog", "aria-modal": "true", "aria-label": title });
  const panel = el("div", { class: "modal glass spotlight", tabindex: "-1", style: { position: "relative" } }, [
    el("button", { class: "icon-btn sm m-x", type: "button", "aria-label": t("set.close"), onclick: () => close() }, el("i", { class: "ph ph-x" })),
    el("h3", {}, title),
    sub ? el("p", { class: "m-sub" }, sub) : null,
    el("div", { class: "m-body" }, body),
    el("div", { class: "m-acts" }, actions),
  ]);
  ovl.append(panel);
  ovl.addEventListener("pointerdown", (e) => { if (e.target === ovl) close(); });
  root.replaceChildren(ovl);
  open = ovl;
  document.addEventListener("keydown", esc);
  document.addEventListener("keydown", trap);
  (panel.querySelector("input, button:not(.m-x)") || panel).focus({ preventScroll: true });
  return panel;
}

function esc(e) { if (e.key === "Escape") { e.stopPropagation(); close(); } }

function trap(e) {
  if (e.key !== "Tab" || !open) return;
  const items = [...open.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])")]
    .filter((n) => n.offsetParent !== null);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export function close() {
  if (!open) return;
  const node = open;
  open = null;
  document.removeEventListener("keydown", esc);
  document.removeEventListener("keydown", trap);
  node.classList.add("is-out");
  setTimeout(() => node.remove(), 180);
  const back = returnFocus;
  returnFocus = null;
  if (back?.focus && back !== document.body) setTimeout(() => back.focus({ preventScroll: true }), 20);
}

export function confirm({ title, body, okLabel = t("set.doIt"), danger = false, onOk }) {
  const typeBox = danger ? field({ label: t("set.typeGo"), value: "", placeholder: " " }) : null;
  const ok = el("button", { class: `btn ${danger ? "btn-danger" : "btn-primary"}`, type: "button", disabled: danger }, okLabel);
  ok.addEventListener("click", () => { close(); onOk?.(); });
  if (typeBox) typeBox.input.addEventListener("input", () => { ok.disabled = typeBox.input.value.trim().toUpperCase() !== "GO"; });
  shell({ title, sub: body, body: typeBox ? [typeBox] : [], actions: [el("button", { class: "btn btn-ghost", type: "button", onclick: () => close() }, t("set.cancel")), ok] });
}

export function settings({ onReset }) {
  const tempRow = el("div", { class: "m-set" }, [
    el("div", {}, [el("b", {}, t("set.temp")), el("em", {}, t("set.tempHint"))]),
    combo({ ariaLabel: t("set.tempAria"), icon: "ph-hard-drives", value: get("tempOn"), items: () => [
      { value: "input", name: t("set.tempInput"), dir: "input", desc: t("set.tempDefault") },
      { value: "app", name: t("set.tempApp"), dir: "app" },
    ], onChange: (v) => { set({ tempOn: v }); log(`temp folder policy -> ${v}`); } }),
  ]);

  const outBtn = el("button", { class: "btn btn-sm btn-secondary m-pick", type: "button" }, [el("i", { class: "ph ph-folder-simple" }), el("span", {})]);
  const outClear = el("button", { class: "icon-btn sm", type: "button", "aria-label": t("set.outClear") }, el("i", { class: "ph ph-x" }));
  const paintOut = () => {
    const dir = get("outDir");
    const span = outBtn.querySelector("span");
    if (span) span.textContent = dir ? dir.split(/[\\/]/).pop() : t("set.outSource");
    outBtn.title = dir || t("set.outSource");
    outClear.hidden = !dir;
  };
  outBtn.addEventListener("click", async () => {
    if (!live) { toast({ kind: "info", title: t("cmp.mockTitle"), body: t("set.pickMock") }); return; }
    try {
      const dir = await ipc.pickDir();
      if (dir) { set({ outDir: dir }); paintOut(); }
    } catch (e) { toast({ kind: "warn", title: t("set.out"), body: e.message || String(e) }); }
  });
  outClear.addEventListener("click", () => { set({ outDir: "" }); paintOut(); });
  paintOut();
  const outRow = el("div", { class: "m-set" }, [
    el("div", {}, [el("b", {}, t("set.out")), el("em", {}, t("set.outHint"))]),
    el("div", { class: "m-pick-wrap" }, [outBtn, outClear]),
  ]);

  const gpuList = rt("gpus") || [];
  const gpuRow = el("div", { class: "m-set" }, [
    el("div", {}, [el("b", {}, t("set.gpu")), el("em", {}, t("set.gpuHint"))]),
    combo({
      ariaLabel: t("set.gpuAria"), icon: "ph-cpu", value: String(get("gpu")),
      items: () => gpuList.length
        ? gpuList.map((g) => ({ value: String(g.index), name: `GPU ${g.index} · ${g.name}`, dir: String(g.index), desc: g.memoryMb ? `${round(g.memoryMb / 1024, 1)} GB` : "" }))
        : [{ value: "0", name: t("set.gpuMock"), dir: "0" }],
      onChange: (v) => set({ gpu: Number(v) }),
    }),
  ]);

  const ttaRow = el("div", { class: "m-set" }, [el("div", {}, [el("b", {}, t("set.journal")), el("em", {}, t("set.journalHint"))]), sw({ checked: get("journalOpen"), label: t("set.journalOpen"), onChange: (v) => { set({ journalOpen: v }); const b = $("#btn-journal"); if (v && b && b.getAttribute("aria-expanded") !== "true") b.click(); } })]);

  const acts = [
    el("button", { class: "btn btn-ghost", type: "button", onclick: () => { close(); onReset?.(); } }, t("cmd.reset")),
    el("button", { class: "btn btn-primary", type: "button", onclick: () => close() }, t("set.done")),
  ];
  shell({ title: t("set.title"), sub: t("set.sub"), body: [tempRow, outRow, gpuRow, ttaRow], actions: acts });
}

export function about() {
  const github = el("a", { class: "btn btn-secondary btn-sm", href: AUTHOR_URL, target: "_blank", rel: "noreferrer" }, [el("i", { class: "ph ph-github-logo" }), t("about.github")]);
  const body = el("div", { class: "about" }, [
    el("div", { class: "about-hero" }, [
      el("span", { class: "about-mark" }, el("i", { class: "ph-fill ph-waveform" })),
      el("div", {}, [
        el("b", { class: "about-name" }, "flow."),
        el("em", {}, t("about.version", { v: VERSION })),
      ]),
      el("span", { class: "badge badge-mint" }, "MIT"),
    ]),
    el("p", { class: "about-sub" }, t("about.sub")),
    el("div", { class: "about-card" }, [
      aboutRow("ph-user-circle", t("about.authorLabel"), AUTHOR),
      aboutRow("ph-identification-badge", t("about.roleLabel"), t("about.role")),
      aboutRow("ph-stack", t("about.stackLabel"), t("about.stackShort")),
      aboutRow("ph-code", t("about.licenseLabel"), "MIT"),
    ]),
  ]);
  shell({ title: t("about.title"), body: [body], actions: [
    github,
    el("button", { class: "btn btn-primary", type: "button", onclick: () => close() }, t("about.done")),
  ] });
}

function aboutRow(icon, label, value) {
  return el("div", { class: "about-row" }, [
    el("i", { class: `ph ${icon}` }),
    el("span", {}, label),
    el("em", {}, value),
  ]);
}
