// flow. - entry. Wires the modules together; owns nothing that belongs to a module.

import { $, $$, round } from "./util.js";
import { ipc, live } from "./ipc.js";
import { rt, setRt, get, set } from "./state.js";
import { initI18n, t, getLang, setLang, toggleLang, onLang, applyDom } from "./i18n.js";
import { initTips } from "./tips.js";
import { initSpotlight } from "./spotlight.js";
import { log, initJournal, resetJournal } from "./journal.js";
import { toast } from "./toasts.js";
import { initSource } from "./source.js";
import { initRecipe } from "./recipe.js";
import { initRun, startJob, reset as resetRun, paintGpu } from "./run.js";
import { initCompare } from "./compare.js";
import { initPalette, close as closePalette, isOpen as paletteOpen } from "./palette.js";
import { initWizard, unlock, setStepMeta } from "./wizard.js";
import { settings, about, close as closeModal, isOpen as modalOpen } from "./modal.js";
import { initContextMenu, close as closeContext } from "./ctxmenu.js";

let wizard = null;
let recipe = null;
let source = null;

async function boot() {
  initI18n();
  initTips();
  initSpotlight();
  initJournal();
  initCompare();

  const pill = $("#core-pill");
  const txt = $("#core-txt");
  pill.classList.toggle("is-live", live);
  pill.dataset.i18nTip = live ? "tip.core.live" : "tip.core.mock";
  applyCoreTip();
  txt.textContent = live ? "core: live" : "core: mock";

  wizard = initWizard({
    onEnter: (i) => {
      setRt({ wizardStep: i });
      if (i === 1) recipe?.refresh?.();
      if (i === 2) {
        paintRenderSub();
        if (!rt("running") && !rt("result") && rt("source")) setStepMeta(2, t("meta.run"));
      }
    },
  });
  setRt({ wizardStep: 0 });
  const stepBtns = $$("#wiz-steps .wst");
  stepBtns[1].disabled = true;
  stepBtns[2].disabled = true;

  source = initSource({
    onSource: (s) => {
      setRt({ source: s });
      $("#btn-run").disabled = !s;
      $("#src-badge").hidden = !s;
      if (s) {
        const p = s.probe;
        $("#src-badge").className = "badge badge-cy";
        $("#src-badge").textContent = p.fps ? t("src.badge", { fps: round(p.fps, 2) }) : t("src.badgeNoFps");
        unlock(1); unlock(2);
      } else {
        setStepMeta(0, t("meta.pick"));
        $("#to-recipe").disabled = true;
      }
      paintRenderSub();
      recipe?.showPlan();
    },
  });

  if (live) setupNativeDrop();

  recipe = await initRecipe({ onChange: () => {} });
  initRun({ job: recipe.job, onFinished: () => wizard.relayout() });
  initPalette(commands);
  initContextMenu(contextItems);
  wireChrome();
  if (get("journalOpen")) $("#btn-journal")?.click();
  // One pass over the freshly built controls: data-i18n inside a dynamically created
  // node is not translated by the boot pass that ran before the node existed.
  applyDom();
  paintChromeState();

  onLang(() => {
    closeContext();
    if (paletteOpen()) closePalette();
    if (modalOpen()) closeModal();
    $("#toasts")?.replaceChildren();
    applyCoreTip();
    paintChromeState();
    setTimeout(() => wizard?.relayout(), 80);
  });

  log(`flow. ${live ? "core" : "browser harness"} ready - ${live ? "Rust IPC" : "simulated progress from a measured 37.7 f/s at 544x306"}`, "ok");
  log("drop a clip or press Ctrl+K for commands", "info");
  log("right-click anywhere for the native-feeling context menu", "info");

  if (!live) paintGpu({ util: 0, vramMb: 1180, vramTotalMb: 8192, tempC: 44 });
  else {
    pollGpu();
    ipc.gpus().then((list) => { if (Array.isArray(list)) setRt({ gpus: list }); }).catch(() => {});
  }

  window.flow = {
    ipc, rt, get, set, startJob, resetRun, source: () => source, recipe, toast, live, wizard,
    setStep: (i) => wizard.go(i), lang: getLang, setLang,
  };
}

function applyCoreTip() {
  const pill = $("#core-pill");
  if (pill) pill.dataset.tip = t(live ? "tip.core.live" : "tip.core.mock");
}

function wireChrome() {
  $("#btn-settings").addEventListener("click", () => settings({ onReset: resetAll }));
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href^='http']");
    if (!a || !live) return;
    e.preventDefault();
    ipc.openUrl(a.href);
  });
  $("#btn-about").addEventListener("click", () => about());
  $("#btn-lang").addEventListener("click", () => toggleLang());
  $("#dock-credit").addEventListener("click", (e) => {
    // The credit links to the author's GitHub; the little heart opens the about card.
    if (e.target.closest?.("i")) { e.preventDefault(); about(); }
  });

  $("#to-recipe").addEventListener("click", () => wizard.go(1));
  $("#back-to-source").addEventListener("click", () => wizard.go(0));
  $("#back-to-recipe").addEventListener("click", () => wizard.go(1));
  $("#to-render").addEventListener("click", () => startRender());
  $("#btn-reveal").addEventListener("click", () => {
    const out = rt("result");
    if (!out) return;
    ipc.reveal(out.path).then((r) => { if (r && r.ok === false) toast({ kind: "info", title: t("cmp.mockTitle"), body: t("cmp.mockBody") }); });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.target.closest?.("input, textarea, select, button, .cbx")) {
      if (rt("wizardStep") === 0 && rt("source")) { e.preventDefault(); wizard.go(1); }
      else if (rt("wizardStep") === 1 && !rt("running")) { e.preventDefault(); startRender(); }
    }
    if (e.key === "Escape" && !document.querySelector(".ovl, .pal, .ctx")) {
      if (rt("running")) ipc.cancel();
      else closeModal();
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") { e.preventDefault(); toggleLang(); }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); source?.openPicker(); }
    if ((e.ctrlKey || e.metaKey) && e.key === ",") { e.preventDefault(); settings({ onReset: resetAll }); }
  });
}

// Everything that depends on the language plus the current session state.
function paintChromeState() {
  const s = rt("source");
  const badge = $("#src-badge");
  if (badge && s) badge.textContent = s.probe?.fps ? t("src.badge", { fps: round(s.probe.fps, 2) }) : t("src.badgeNoFps");
  if (!s) {
    setStepMeta(0, t("meta.pick"));
    setStepMeta(1, t("meta.engine"));
    setStepMeta(2, t("meta.run"));
  } else if (!rt("running") && !rt("result")) {
    setStepMeta(2, t("meta.run"));
  }
  paintRenderSub();
}

function paintRenderSub() {
  const sub = $("#render-sub");
  if (!sub) return;
  const s = rt("source");
  if (!s) {
    sub.dataset.i18n = "run.sub";
    sub.textContent = t("run.sub");
    return;
  }
  sub.removeAttribute("data-i18n");
  sub.textContent = `${s.name} · ${s.probe.width}×${s.probe.height} · ${get("factor")}× · ${get("model")}`;
}

function setupNativeDrop() {
  try {
    const webview = window.__TAURI__?.webview?.getCurrentWebview?.();
    if (!webview?.onDragDropEvent) return;
    webview.onDragDropEvent((event) => {
      const p = event.payload || {};
      const dz = $("#dz");
      if (p.type === "enter" || p.type === "over") dz?.classList.add("is-over");
      else if (p.type === "leave") dz?.classList.remove("is-over");
      else if (p.type === "drop") {
        dz?.classList.remove("is-over");
        const file = p.paths?.[0];
        if (file) source?.openPath(file);
      }
    });
  } catch { /* older Tauri build */ }
}

function startRender() {
  if (rt("running")) return;
  const job = recipe.job();
  if (!job.source) return toast({ kind: "warn", title: t("run.noSourceTitle"), body: t("run.noSourceBody2") });
  wizard.go(2);
  setTimeout(() => startJob(job), 120);
}

function resetAll() {
  source?.clear();
  resetRun();
  resetJournal();
  setRt({ source: null, result: null, plan: null, progress: { overall: 0, done: 0, total: 0 } });
  $("#btn-run").disabled = true;
  $("#btn-reveal").hidden = true;
  $("#cmp-stage").hidden = true;
  $("#cmp-es").hidden = false;
  $("#cmp").classList.add("is-empty");
  const side = $("#cmp-side");
  if (side) { side.hidden = true; side.replaceChildren(); }
  $("#src-badge").hidden = true;
  paintChromeState();
  recipe?.showPlan();
  wizard.go(0);
  log("session reset", "info");
}

async function pollGpu() {
  const tick = async () => {
    // While a job runs, the core's progress events already carry GPU samples;
    // don't spawn a second nvidia-smi every tick and fight the render for the GPU.
    if (!rt("running")) {
      try { const g = await ipc.gpu(get("gpu")); if (g) paintGpu(g); } catch { /* core busy */ }
    }
    setTimeout(tick, 2000);
  };
  tick();
}

function commands() {
  return [
    { group: t("cmd.groupSource"), label: t("cmd.open"), icon: "ph-folder-open", keys: "Ctrl O", run: () => source?.openPicker() },
    { group: t("cmd.groupSource"), label: t("cmd.clear"), icon: "ph-x", run: () => source?.clear() },
    { group: t("cmd.groupSteps"), label: t("cmd.goSource"), icon: "ph-film-strip", run: () => wizard.go(0) },
    { group: t("cmd.groupSteps"), label: t("cmd.goRecipe"), icon: "ph-sliders-horizontal", run: () => wizard.go(1) },
    { group: t("cmd.groupSteps"), label: t("cmd.goRender"), icon: "ph-gauge", run: () => wizard.go(2) },
    { group: t("cmd.groupRender"), label: t("cmd.start"), icon: "ph-play", keys: "Enter", run: startRender },
    { group: t("cmd.groupRender"), label: t("cmd.cancel"), icon: "ph-stop", keys: "Esc", run: () => ipc.cancel() },
    { group: t("cmd.groupRender"), label: t("cmd.journal"), icon: "ph-terminal-window", run: () => $("#btn-journal").click() },
    { group: t("cmd.groupRecipe"), label: t("cmd.factor", { n: 2 }), icon: "ph-arrows-out", run: () => recipe?.setFactor(2) },
    { group: t("cmd.groupRecipe"), label: t("cmd.factor", { n: 4 }), icon: "ph-arrows-out", run: () => recipe?.setFactor(4) },
    { group: t("cmd.groupRecipe"), label: t("cmd.factor", { n: 8 }), icon: "ph-arrows-out", run: () => recipe?.setFactor(8) },
    { group: t("cmd.groupRecipe"), label: t("cmd.recommended"), icon: "ph-arrow-counter-clockwise", run: () => $("#btn-recipe-reset").click() },
    { group: t("cmd.groupApp"), label: t("cmd.settings"), icon: "ph-gear-six", keys: "Ctrl ,", run: () => settings({ onReset: resetAll }) },
    { group: t("cmd.groupApp"), label: t("cmd.language"), icon: "ph-translate", keys: "Ctrl ⇧ L", run: () => toggleLang() },
    { group: t("cmd.groupApp"), label: t("cmd.about"), icon: "ph-info", run: () => about() },
    { group: t("cmd.groupApp"), label: t("cmd.reset"), icon: "ph-arrow-counter-clockwise", run: resetAll },
  ];
}

function contextItems({ target }) {
  const kind = target.closest?.("[data-ctx]")?.dataset.ctx || "";
  const s = rt("source");
  const out = rt("result");
  const items = [];
  const copy = async (text, name) => {
    try {
      await navigator.clipboard.writeText(String(text));
      toast({ kind: "ok", title: t("ctx.copyDone"), body: t("ctx.copyDoneBody", { name }) });
    } catch (e) {
      toast({ kind: "warn", title: t("ui.copyFail"), body: e.message });
    }
  };

  if (kind === "source") {
    items.push({ kind: "group", label: t("cmd.groupSource") });
    items.push({ label: t("ctx.open"), icon: "ph-folder-open", keys: "Ctrl O", action: () => source?.openPicker() });
    if (s) {
      if (live) items.push({ label: t("ctx.reveal"), icon: "ph-folder-simple", action: () => ipc.reveal(s.path) });
      items.push({ label: t("ctx.copyPath"), icon: "ph-copy", action: () => copy(s.path, s.name) });
      items.push({ label: t("ctx.copyName"), icon: "ph-copy-simple", action: () => copy(s.name, s.name) });
      items.push({ kind: "sep" });
      items.push({ label: t("ctx.clear"), icon: "ph-x", danger: true, action: () => { source?.clear(); toast({ kind: "info", title: t("src.cleared") }); } });
    }
  } else if (kind === "compare" && out) {
    const playing = $("#btn-play i")?.classList.contains("ph-pause");
    items.push({ kind: "group", label: t("cmp.title") });
    items.push({ label: playing ? t("cmp.pause") : t("ctx.play"), icon: playing ? "ph-pause" : "ph-play", action: () => $("#btn-play").click(), disabled: $("#btn-play")?.disabled });
    items.push({ label: t("ctx.showOutput"), icon: "ph-folder-open", action: () => ipc.reveal(out.path) });
    items.push({ label: t("ctx.copyOut"), icon: "ph-copy", action: () => copy(out.path, out.name || out.path) });
  } else if (kind === "recipe") {
    items.push({ kind: "group", label: t("cmd.groupRecipe") });
    items.push({ label: t("ctx.recommended"), icon: "ph-arrow-counter-clockwise", action: () => $("#btn-recipe-reset").click() });
    for (const n of [2, 3, 4, 5, 8]) {
      items.push({ label: t("ctx.factor", { n }), icon: "ph-arrows-out", checked: get("factor") === n, action: () => recipe?.setFactor(n) });
    }
  } else if (kind === "render") {
    items.push({ kind: "group", label: t("cmd.groupRender") });
    items.push({ label: t("cmd.start"), icon: "ph-play", keys: "Enter", disabled: !s || rt("running"), action: startRender });
    if (rt("running")) items.push({ label: t("run.cancel"), icon: "ph-stop", danger: true, action: () => ipc.cancel() });
    if (out) items.push({ label: t("ctx.showOutput"), icon: "ph-folder-open", action: () => ipc.reveal(out.path) });
    items.push({ label: t("ctx.journal"), icon: "ph-terminal-window", action: () => $("#btn-journal").click() });
  }

  if (kind !== "source") {
    items.push({ kind: "sep" });
    items.push({ kind: "group", label: t("ctx.navigate") });
    items.push({ label: t("nav.source"), icon: "ph-film-strip", action: () => wizard.go(0) });
    items.push({ label: t("nav.recipe"), icon: "ph-sliders-horizontal", disabled: !s, action: () => wizard.go(1) });
    items.push({ label: t("nav.render"), icon: "ph-gauge", disabled: !s, action: () => wizard.go(2) });
  }

  items.push({ kind: "sep" });
  items.push({ kind: "group", label: t("cmd.groupApp") });
  items.push({ label: t("ctx.palette"), icon: "ph-command", keys: "Ctrl K", action: () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })) });
  items.push({
    label: t("ctx.language"), icon: "ph-translate", submenu: [
      { label: t("ctx.langEn"), icon: "ph-globe-hemisphere-west", checked: getLang() === "en", action: () => setLang("en") },
      { label: t("ctx.langFa"), icon: "ph-globe-hemisphere-east", checked: getLang() === "fa", action: () => setLang("fa") },
    ],
  });
  items.push({ label: t("ctx.settings"), icon: "ph-gear-six", action: () => settings({ onReset: resetAll }) });
  items.push({ label: t("ctx.about"), icon: "ph-info", action: () => about() });
  items.push({ kind: "sep" });
  items.push({ label: t("ctx.reset"), icon: "ph-arrow-counter-clockwise", danger: true, action: resetAll });
  return items;
}

boot().catch((e) => {
  console.error(e);
  log(`boot failed: ${e.message}`, "error");
  toast({ kind: "error", title: "Boot failed", body: e.message });
});
