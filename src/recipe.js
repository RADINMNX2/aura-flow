// flow. - the recipe pane. Three cards: engine, factor, output. Every control writes to the
// store and re-runs plan(); the numbers in the summary are computed by the core (mock or live).

import { $, el, round, clock, bytes } from "./util.js";
import { combo, sw, codecCards, factorRail, qualityBar } from "./controls.js";
import { get, set, rt, setRt, crfOf } from "./state.js";
import { ipc } from "./ipc.js";
import { log } from "./journal.js";
import { dropTip } from "./tips.js";
import { setStepMeta } from "./wizard.js";
import { t, onLang } from "./i18n.js";

const CODECS = [
  { value: "h264", label: "H.264", hintKey: "rcp.h264", hint: "plays everywhere · fastest", icon: "ph-film-strip" },
  { value: "h265", label: "H.265", hintKey: "rcp.h265", hint: "half the size · slower", icon: "ph-film-strip" },
  { value: "av1", label: "AV1", hintKey: "rcp.av1", hint: "smallest · slowest here", icon: "ph-film-strip" },
];
const PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower"].map((p) => ({ value: p, name: p.toUpperCase(), house: p === "slow" }));

let registry = { engines: [] };
let engine = null;
let planTimer = 0;
let planEl = null;
let factorCtl = null;
let planCache = null;

export async function initRecipe({ onChange } = {}) {
  try {
    registry = await ipc.scan();
  } catch (e) {
    registry = { engines: [] };
    log(`engine scan failed: ${e.message}`, "error");
  }
  if (!Array.isArray(registry?.engines) || !registry.engines.length) {
    const grid = $("#rcp-grid");
    grid.replaceChildren(card("rcp.engine", "ph-cpu", [
      el("div", { class: "rcp-note" }, [
        el("i", { class: "ph ph-warning-octagon" }),
        el("div", {}, [el("b", { "data-i18n": "rcp.noEngine" }, t("rcp.noEngine")), el("em", { "data-i18n": "rcp.noEngineHint" }, t("rcp.noEngineHint"))]),
      ]),
    ]));
    log(t("rcp.noEngine"), "warn");
    const job = () => ({
      source: rt("source"), engine: "rife-ncnn", model: "", factor: get("factor"),
      codec: get("codec"), quality: get("quality"), crf: crfOf(get("quality")), preset: get("preset"),
      keepAudio: get("keepAudio"), keepSubs: get("keepSubs"), sceneDetect: get("sceneDetect"),
      tta: get("tta"), gpu: get("gpu"), outDir: get("outDir") || null,
    });
    return { job, showPlan: async () => {}, refresh: () => {}, engine: () => null, setFactor: () => {} };
  }
  const byId = (id) => registry.engines.find((e) => e.id === id) || registry.engines[0];
  engine = byId(get("engine"));
  if (get("engine") !== engine.id) set({ engine: engine.id });
  if (!engine.models.some((m) => m.dir === get("model"))) set({ model: (engine.models.find((m) => m.default) || engine.models[0]).dir });

  const modelBadge = el("span", { class: "badge badge-dashed" }, t("rcp.weights"));
  const engineSum = el("div", { class: "engine-sum" });

  const engineBox = combo({
    ariaLabel: "Interpolation engine", ariaKey: "rcp.engine", icon: engine.icon,
    items: () => registry.engines.map((e) => ({ value: e.id, name: e.name, desc: e.backend, icon: e.icon })),
    value: engine.id,
    onChange: (v) => {
      engine = byId(v);
      const def = engine.models.find((m) => m.default) || engine.models[0];
      set({ engine: v, model: def.dir });
      modelBox.setValue(def.dir);
      renderBadge();
      renderEngineSum();
      refresh();
      log(`engine -> ${engine.name} (${engine.backend})`);
    },
  });

  const modelBox = combo({
    ariaLabel: "Model", ariaKey: "rcp.model", icon: "ph-cube",
    items: () => engine.models.map((m) => ({ ...m, value: m.dir })),
    value: get("model"),
    onChange: (v) => { set({ model: v }); renderBadge(); renderEngineSum(); refresh(); log(`model -> ${v}`); },
  });

  factorCtl = factorRail({
    value: get("factor"), fpsIn: rt("source")?.probe?.fps || 0,
    onChange: (v) => { set({ factor: v }); refresh(); },
  });
  factorCtl.dataset.tip = t("tip.factor");
  factorCtl.dataset.i18nTip = "tip.factor";

  planEl = el("div", { class: "fsum" });

  const quality = qualityBar({ value: get("quality"), crf: crfOf(get("quality")), onChange: (v) => { set({ quality: v }); quality.setCrf(crfOf(v)); } });
  quality.dataset.tip = t("tip.quality");
  quality.dataset.i18nTip = "tip.quality";

  const codecs = codecCards({ items: CODECS, value: get("codec"), onChange: (v) => { set({ codec: v }); refresh(); } });
  codecs.dataset.tip = t("tip.codec");
  codecs.dataset.i18nTip = "tip.codec";

  const presetBox = combo({ ariaLabel: "Encoder preset", ariaKey: "rcp.speed", icon: "ph-timer", items: () => PRESETS.map((p) => ({ ...p, desc: p.house ? t("rcp.houseDefault") : "" })), value: get("preset"), onChange: (v) => set({ preset: v }) });
  presetBox.dataset.tip = t("tip.preset");
  presetBox.dataset.i18nTip = "tip.preset";
  engineBox.dataset.tip = t("tip.engine");
  engineBox.dataset.i18nTip = "tip.engine";
  modelBox.dataset.tip = t("tip.model");
  modelBox.dataset.i18nTip = "tip.model";

  const ttaRow = sw({ checked: get("tta"), label: "TTA pass", labelKey: "rcp.tta", hintKey: "rcp.ttaHint", hint: "about twice the time, cleaner edges", onChange: (v) => { set({ tta: v }); refresh(); } });
  const switches = el("div", { class: "sw-grid" }, [
    sw({ checked: get("keepAudio"), label: "Keep audio", labelKey: "rcp.keepAudio", hintKey: "rcp.keepAudioHint", hint: "copied, never re-encoded", onChange: (v) => set({ keepAudio: v }) }),
    sw({ checked: get("keepSubs"), label: "Keep subtitles", labelKey: "rcp.keepSubs", hintKey: "rcp.keepSubsHint", hint: "soft subs are muxed through", onChange: (v) => set({ keepSubs: v }) }),
    sw({ checked: get("sceneDetect"), label: "Scene detection", labelKey: "rcp.scene", hintKey: "rcp.sceneHint", hint: "no blending across cuts", onChange: (v) => { set({ sceneDetect: v }); refresh(); } }),
    ttaRow,
  ]);

  const grid = $("#rcp-grid");
  grid.replaceChildren(
    card("rcp.engine", "ph-cpu", [
      row("rcp.engine", engineBox),
      row("rcp.model", modelBox, modelBadge),
      engineSum,
      el("p", { class: "engine-note" }, [el("i", { class: "ph ph-shield-check" }), el("span", { "data-i18n": "rcp.engineNote" }, t("rcp.engineNote"))]),
    ]),
    card("rcp.factor", "ph-swatches", [factorCtl, planEl]),
    card("rcp.output", "ph-film-strip", [
      row("rcp.codec", codecs),
      el("div", { class: "rcp-duo" }, [
        el("div", { class: "rcp-row" }, [el("div", { class: "rcp-k", "data-i18n": "rcp.quality" }, t("rcp.quality")), quality]),
        el("div", { class: "rcp-row" }, [el("div", { class: "rcp-k", "data-i18n": "rcp.speed" }, t("rcp.speed")), presetBox]),
      ]),
      switches,
    ], { wide: true }),
  );

  $("#btn-recipe-reset").addEventListener("click", () => {
    set({ factor: 4, quality: 78, preset: "slow", codec: "h264", tta: false, keepAudio: true, keepSubs: true, sceneDetect: true });
    factorCtl.setValue(4);
    quality.setValue(78); quality.setCrf(crfOf(78));
    codecs.setValue("h264"); presetBox.setValue("slow");
    refresh();
    log(t("rcp.reset"));
  });

  renderBadge();
  renderEngineSum();
  refresh();
  onLang(() => { renderBadge(); renderEngineSum(); showPlan(); });
  onChange?.();
  return { job, showPlan, refresh: () => factorCtl.refresh?.(), engine: () => engine, setFactor: (v) => { factorCtl.setValue(v); set({ factor: v }); refresh(); } };

  /* ---- helpers ---- */
  function renderBadge() {
    const m = engine.models.find((x) => x.dir === get("model"));
    modelBadge.className = "badge " + (m?.fixed ? "badge-am" : "badge-cy");
    modelBadge.textContent = m
      ? `${m.sizeMb ? round(m.sizeMb, 1) + " MB" : t("rcp.weights")}${m.fixed ? ` · ${t("rcp.modelOnly", { n: m.fixed[0] })}` : ""}`
      : t("rcp.noWeights");
    if (m?.fixed && !m.fixed.includes(get("factor"))) { factorCtl.setValue(m.fixed[0]); set({ factor: m.fixed[0] }); }
    dropTip();
  }

  function renderEngineSum() {
    const m = engine.models.find((x) => x.dir === get("model"));
    const rife = engine.id.startsWith("rife");
    ttaRow.classList.toggle("is-off", !rife);
    if (ttaRow.switchBtn) ttaRow.switchBtn.disabled = !rife;
    ttaRow.dataset.tip = rife ? t("tip.tta") : t("tip.ttaRifeOnly");
    ttaRow.dataset.i18nTip = rife ? "tip.tta" : "tip.ttaRifeOnly";
    if (!rife && get("tta")) { set({ tta: false }); ttaRow.setChecked(false); }
    engineSum.replaceChildren(
      el("i", { class: `ph ${engine.icon}` }),
      el("span", { style: { minWidth: "0" } }, [el("b", {}, `${engine.name} · ${engine.backend}`), el("em", {}, `${m?.name || t("rcp.noModel")} · ${m?.sizeMb ? round(m.sizeMb, 1) + " MB" : t("rcp.missing")} · ${engine.needsPython ? t("rcp.pytorchRuntime") : t("rcp.noRuntime")}`)]),
      el("span", { class: "badge " + (engine.needsPython ? "badge-am" : "badge-mint") }, engine.needsPython ? t("rcp.pytorch") : t("rcp.vulkan")),
    );
    setStepMeta(1, stepMeta());
    factorCtl.setFpsIn(rt("source")?.probe?.fps || 0);
  }

  function stepMeta() {
    const m = engine.models.find((x) => x.dir === get("model"));
    const f = round(get("factor"), 2);
    return engine.id.startsWith("rife") ? `${f}× · ${m?.name || t("rcp.model")}` : `${engine.name} · ${f}×`;
  }

  function refresh() {
    clearTimeout(planTimer);
    planTimer = setTimeout(showPlan, 120);
    setStepMeta(1, stepMeta());
  }

  async function showPlan() {
    const src = rt("source");
    if (!src) {
      planEl.replaceChildren(el("em", {}, t("rcp.noSource")));
      return;
    }
    try {
      const p = await ipc.plan(job());
      planCache = p;
      setRt({ plan: p });
      dispatchEvent(new CustomEvent("flow:plan", { detail: p }));
      planEl.replaceChildren(
        statChip("rcp.planFrames", `${p.inFrames.toLocaleString("en-US")} → ${p.outFrames.toLocaleString("en-US")}`),
        statChip("rcp.planRate", `${round(p.inFps, 2)} → ${round(p.outFps, 2)}`),
        statChip("rcp.planEst", clock(p.estSeconds)),
        statChip("rcp.planTemp", bytes(p.outFrames * 320_000)),
      );
      const hint = $("#recipe-hint");
      if (hint) hint.textContent = t("rcp.hint", { frames: p.outFrames.toLocaleString("en-US"), fps: round(p.outFps, 2), time: clock(p.estSeconds) });
      factorCtl.setFpsIn(src.probe?.fps || 0);
      setStepMeta(1, stepMeta());
      setStepMeta(0, src.name);
    } catch (e) {
      planEl.replaceChildren(el("em", {}, e.message));
    }
  }

  function job() {
    const q = get("quality");
    return {
      source: rt("source"), engine: engine.id, model: get("model"), factor: get("factor"),
      codec: get("codec"), quality: q, crf: crfOf(q), preset: get("preset"),
      keepAudio: get("keepAudio"), keepSubs: get("keepSubs"), sceneDetect: get("sceneDetect"),
      tta: get("tta"), gpu: get("gpu"), outDir: get("outDir") || null,
    };
  }
}

function statChip(key, v) {
  return el("span", { class: "fsum-item" }, [el("em", { "data-i18n": key }, t(key)), el("b", {}, String(v))]);
}

function card(titleKey, icon, kids, { wide = false } = {}) {
  return el("section", { class: "rcp-card" + (wide ? " wide" : "") }, [
    el("div", { class: "rcp-card-head" }, el("h3", {}, [el("i", { class: `ph ${icon}` }), el("span", { "data-i18n": titleKey }, t(titleKey))])),
    ...kids,
  ]);
}

function row(k, control, extra) {
  return el("div", { class: "rcp-row" }, [
    el("div", { class: "rcp-k" }, [el("span", { "data-i18n": k }, t(k)), extra || null]),
    control,
  ]);
}
