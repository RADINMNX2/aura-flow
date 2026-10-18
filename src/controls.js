// flow. - widget builders. Every control ships hover / focus / active / disabled and a real
// keyboard path, and every one of them reports through the same onChange contract.

import { $, el, clamp, round, uid } from "./util.js";
import { t, onLang } from "./i18n.js";

/* ---------- segmented control (2-5 mutually exclusive options) ---------- */
export function seg({ items, value: rawValue, ariaLabel, fluid = false, onChange }) {
  const value = items.some((i) => String(i.value) === String(rawValue)) ? rawValue : items[0]?.value;
  const root = el("span", { class: "seg" + (fluid ? " is-fluid" : ""), role: "radiogroup", "aria-label": ariaLabel });
  const ind = el("i", { class: "seg-ind" });
  root.append(ind);
  const btns = items.map((it) => {
    const b = el("button", {
      class: "seg-btn", type: "button", role: "radio", "aria-checked": String(it.value === value),
      dataset: { value: it.value }, title: it.title || null,
    }, [it.icon ? el("i", { class: `ph ${it.icon}` }) : null, el("span", it.labelKey ? { "data-i18n": it.labelKey } : {}, it.label)]);
    b.addEventListener("click", () => pick(it.value));
    root.append(b);
    return b;
  });

  function pick(v) {
    if (!items.some((i) => String(i.value) === String(v))) return;
    for (const b of btns) b.setAttribute("aria-checked", String(b.dataset.value === String(v)));
    move();
    onChange?.(v);
  }

  function move() {
    const on = btns.find((b) => b.getAttribute("aria-checked") === "true") || btns[0];
    if (!on) return;
    ind.style.width = `${on.offsetWidth}px`;
    ind.style.transform = `translateX(${on.offsetLeft}px)`;
  }

  root.setDisabled = (v, why) => {
    for (const b of btns) {
      const hit = String(b.dataset.value) === String(v);
      b.disabled = hit;
      if (hit) b.dataset.tip = why || "";
    }
  };
  root.setValue = pick;
  root.refresh = move;
  requestAnimationFrame(move);
  new ResizeObserver(move).observe(root);
  return root;
}

/* ---------- combobox (owned list; the OS popup cannot be styled) ---------- */
export function combo({ items, value, ariaLabel, ariaKey, icon = "ph-list", onChange }) {
  const root = el("div", { class: "cbx" });
  const label = el("span", { class: "cbx-v" });
  const btn = el("button", { class: "cbx-btn", type: "button", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": ariaLabel, "data-i18n-aria": ariaKey || null },
    [el("i", { class: `ph ${icon} cbx-ic` }), label, el("i", { class: "ph ph-caret-down cbx-car" })]);
  root.append(btn);

  let pop = null, active = 0, current = value;

  const textOf = (o) => o.name || o.label || String(o.value);
  const subOf = (o) => o.desc || o.sub || "";

  function render() {
    const sel = items().find((o) => String(o.value ?? o.dir) === String(current));
    label.textContent = sel ? textOf(sel) : t("ctl.none");
  }
  onLang(render);

  function close() {
    pop?.remove(); pop = null;
    root.classList.remove("is-open");
    btn.setAttribute("aria-expanded", "false");
  }

  function open() {
    if (pop) return close();
    const list = items();
    if (!list.length) return;
    pop = el("div", { class: "cbx-pop", role: "listbox", "aria-label": ariaLabel, "data-lenis-prevent": true });
    active = Math.max(0, list.findIndex((o) => String(o.value ?? o.dir) === String(current)));
    list.forEach((o, i) => {
      const row = el("button", {
        class: "cbx-o" + (i === active ? " is-act" : "") + (String(o.value ?? o.dir) === String(current) ? " is-sel" : ""),
        type: "button", role: "option", "aria-selected": String(String(o.value ?? o.dir) === String(current)), dataset: { i },
      }, [
        el("i", { class: `ph ${o.icon || "ph-cube"}` }),
        el("span", { class: "cbx-om" }, [el("b", {}, textOf(o)), subOf(o) ? el("em", {}, subOf(o)) : null]),
        o.sizeMb ? el("em", { class: "mono dim" }, `${round(o.sizeMb, 1)} MB`) : null,
        el("i", { class: "ph ph-check cbx-ck" }),
      ]);
      row.addEventListener("click", () => { choose(o); });
      pop.append(row);
    });
    root.append(pop);
    root.classList.add("is-open");
    btn.setAttribute("aria-expanded", "true");
    btn.focus({ preventScroll: true });
  }

  function choose(o) {
    current = o.value ?? o.dir;
    render();
    close();
    onChange?.(current, o);
  }

  function move(delta) {
    if (!pop) return;
    const rows = [...pop.children];
    rows[active]?.classList.remove("is-act");
    active = clamp(active + delta, 0, rows.length - 1);
    rows[active]?.classList.add("is-act");
    rows[active]?.scrollIntoView({ block: "nearest" });
  }

  btn.addEventListener("click", () => (pop ? close() : open()));
  btn.addEventListener("keydown", (e) => {
    if (["ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); pop ? move(e.key === "ArrowDown" ? 1 : -1) : open(); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (pop) { const o = items()[active]; if (o) choose(o); } else open(); }
    else if (e.key === "Escape") { close(); }
  });
  document.addEventListener("pointerdown", (e) => { if (pop && !root.contains(e.target)) close(); });

  root.setValue = (v) => { current = v; render(); };
  root.refresh = render;
  render();
  return root;
}

/* ---------- labelled switch ---------- */
export function sw({ checked, label, hint, labelKey, hintKey, onChange, id }) {
  const btn = el("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(!!checked), "aria-label": label, "data-i18n-aria": labelKey || null, id: id || uid("sw") });
  btn.addEventListener("click", () => {
    const next = btn.getAttribute("aria-checked") !== "true";
    btn.setAttribute("aria-checked", String(next));
    onChange?.(next);
  });
  btn.setChecked = (v) => btn.setAttribute("aria-checked", String(!!v));
  if (!hint) return btn;
  const row = el("div", { class: "sw-row" }, [el("span", { class: "sw-txt" }, [el("b", labelKey ? { "data-i18n": labelKey } : {}, label), el("em", hintKey ? { "data-i18n": hintKey } : {}, hint)]), btn]);
  row.setChecked = btn.setChecked;
  row.switchBtn = btn;
  return row;
}

/* ---------- slider ---------- */
export function slider({ min, max, step = 1, value, ariaLabel, onChange }) {
  const out = el("span", { class: "f-trail" });
  const input = el("input", { class: "sl", type: "range", min, max, step, value, "aria-label": ariaLabel });
  const paint = () => {
    const v = Number(input.value);
    input.style.setProperty("--fill", ((v - min) / (max - min)) * 100);
    out.textContent = String(v);
  };
  input.addEventListener("input", () => { paint(); onChange?.(Number(input.value)); });
  paint();
  input.setValue = (v) => { input.value = v; paint(); };
  return { node: el("div", { class: "rcp-out" }, [input, out]), input };
}

/* ---------- stepper (a bounded number the user picks) ---------- */
export function stepper({ min = 2, max = 8, step = 1, value, suffix = "x", ariaLabel, onChange }) {
  let current = Number.isFinite(Number(value)) ? Number(value) : min;
  const out = el("output", {}, `${current}${suffix}`);
  const commit = (v) => {
    current = clamp(round(v, 2), min, max);
    out.textContent = `${current}${suffix}`;
    onChange?.(current);
  };
  const mk = (icon, delta, label) => {
    const b = el("button", { type: "button", "aria-label": label }, el("i", { class: `ph ${icon}` }));
    b.addEventListener("click", () => commit(current + delta));
    return b;
  };
  const root = el("div", { class: "stp", role: "group", "aria-label": ariaLabel }, [mk("ph-minus", -step, t("ctl.less")), out, mk("ph-plus", step, t("ctl.more"))]);
  root.setValue = (v) => { current = Number.isFinite(Number(v)) ? Number(v) : min; out.textContent = `${current}${suffix}`; };
  root.value = () => current;
  return root;
}

/* ---------- floating-label field ---------- */
export function field({ label, value = "", icon, placeholder = " ", onChange, readonly = false }) {
  const id = uid("f");
  const input = el("input", { id, name: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"), class: "f-input", type: "text", value, placeholder, readonly: readonly || null, "aria-label": label });
  const lbl = el("label", { class: "f-label", for: id }, label);
  input.addEventListener("input", () => { wrap.classList.add("is-typing"); onChange?.(input.value); });
  input.addEventListener("blur", () => wrap.classList.remove("is-typing"));
  const wrap = el("div", { class: "f-field" + (icon ? " f-field-icon" : "") }, [icon ? el("i", { class: `ph ${icon}` }) : null, input, lbl]);
  wrap.input = input;
  return wrap;
}

/* ---------- factor: one control - quick chips, a precise rail and one big readout ---------- */
export function factorRail({ value = 4, fpsIn = 0, min = 1.2, max = 8, onChange }) {
  let cur = Number.isFinite(Number(value)) ? Number(value) : 4;
  const chips = [2, 3, 4, 5, 8];
  const bigTop = el("b");
  const out = el("span", { class: "frail-out" });
  const range = el("input", { class: "frail-range", type: "range", min, max, step: 0.1, value: cur, "aria-label": t("ctl.factor"), "data-i18n-aria": "ctl.factor" });
  const chipRow = el("div", { class: "frail-chips", role: "group", "aria-label": t("ctl.commonFactors"), "data-i18n-aria": "ctl.commonFactors" });
  const chipInd = el("i", { class: "fchip-ind", "aria-hidden": "true" });
  chipRow.append(chipInd);

  const chipNodes = chips.map((c) => {
    const b = el("button", { class: "fchip", type: "button", dataset: { v: String(c) } }, `${c}×`);
    b.addEventListener("click", () => set(c, true));
    chipRow.append(b);
    return b;
  });

  // Ticks are placed from the range mapping, not evenly: 1.2x sits at 0% and 8x at 100%,
  // so a thumb at 3x must sit exactly under the 3x tick. The 18px thumb travel is accounted for.
  const ticks = el("div", { class: "frail-ticks" }, [2, 3, 4, 5, 6, 7, 8].map((n) => {
    const frac = (n - min) / (max - min);
    return el("span", { style: { left: `calc(9px + (100% - 18px) * ${frac.toFixed(4)})` } }, `${n}×`);
  }));

  function paint() {
    const frac = ((cur - min) / (max - min)) * 100;
    range.value = String(cur);
    range.style.setProperty("--fill", frac.toFixed(2));
    bigTop.textContent = Number.isInteger(cur) ? String(cur) : cur.toFixed(1);
    for (const b of chipNodes) b.classList.toggle("is-on", Number(b.dataset.v) === cur);
    const on = chipNodes.find((b) => Number(b.dataset.v) === cur);
    if (on) {
      chipInd.style.opacity = "1";
      chipInd.style.setProperty("--fw", `${on.offsetWidth}px`);
      chipInd.style.setProperty("--fx", `${on.offsetLeft}px`);
    } else {
      chipInd.style.opacity = "0";
    }
    const fr = Number.isFinite(fpsIn) ? fpsIn : 0;
    out.replaceChildren(el("i", { class: "ph ph-swap" }), el("span", {}, fr ? `${round(fr, 2)} → ${round(fr * cur, 2)} fps` : t("ctl.targetRate", { n: round(cur, 2) })));
  }
  onLang(paint);

  function set(v, fromChip = false) {
    const next = clamp(round(Number(v), 2), min, max);
    if (!Number.isFinite(next)) return;
    cur = next;
    paint();
    onChange?.(cur);
    if (fromChip) range.focus({ preventScroll: true });
  }

  range.addEventListener("input", () => set(range.value));
  const node = el("div", { class: "frail" }, [
    el("div", { class: "frail-top" }, [chipRow, el("span", { class: "frail-big" }, [bigTop, el("em", {}, "×")])]),
    range,
    ticks,
    out,
  ]);
  node.setValue = (v) => { cur = Number(v); paint(); };
  node.setFpsIn = (f) => { fpsIn = f; paint(); };
  node.value = () => cur;
  node.refresh = paint;
  // The pane is hidden at boot, so the first paint measures 0; repaint once it is laid out.
  new ResizeObserver(() => paint()).observe(chipRow);
  paint();
  return node;
}

/* ---------- codec: three equal cards, no dead row ---------- */
export function codecCards({ items, value, onChange }) {
  const root = el("div", { class: "codecs", role: "radiogroup", "aria-label": t("ctl.codecAria"), "data-i18n-aria": "ctl.codecAria" });
  const nodes = items.map((it) => {
    const b = el("button", { class: "codec", type: "button", role: "radio", "aria-checked": String(it.value === value), dataset: { v: it.value } }, [
      el("b", {}, [el("i", { class: `ph ${it.icon || "ph-film-strip"}` }), it.label]),
      el("span", it.hintKey ? { "data-i18n": it.hintKey } : {}, it.hintKey ? t(it.hintKey) : it.hint || ""),
      el("i", { class: "ph ph-check-circle ck" }),
    ]);
    b.addEventListener("click", () => pick(it.value));
    root.append(b);
    return b;
  });
  function pick(v) {
    for (const n of nodes) n.setAttribute("aria-checked", String(n.dataset.v === v));
    onChange?.(v);
  }
  root.setValue = pick;
  return root;
}

/* ---------- quality 0-100 ---------- */
export function qualityBar({ value = 78, crf = 18, onChange }) {
  let cur = clamp(Number(value) || 0, 0, 100);
  const num = el("b");
  const crfEl = el("em");
  const input = el("input", { class: "qbar-range", type: "range", min: 0, max: 100, step: 1, value: cur, "aria-label": t("rcp.quality"), "data-i18n-aria": "rcp.quality" });
  function paint() {
    input.style.setProperty("--q", String(cur));
    input.value = String(cur);
    num.textContent = String(Math.round(cur));
    crfEl.textContent = `≈ CRF ${crf}`;
  }
  input.addEventListener("input", () => {
    cur = Number(input.value);
    paint();
    onChange?.(cur);
  });
  const node = el("div", { class: "qbar" }, [
    el("div", { class: "qbar-top" }, [num, el("span", { class: "rcp-k qbar-k", "data-i18n": "ctl.of100" }, "of 100"), crfEl]),
    input,
    el("div", { class: "qbar-scale" }, [el("span", { "data-i18n": "ctl.qSmall" }, "small file"), el("span", { "data-i18n": "ctl.qBalanced" }, "balanced"), el("span", { "data-i18n": "ctl.qLossless" }, "visually lossless")]),
  ]);
  node.setValue = (v) => { cur = Number(v); paint(); };
  node.setCrf = (c) => { crf = c; paint(); };
  paint();
  return node;
}
