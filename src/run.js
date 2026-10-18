// flow. - the render pane: one SVG ring as the hero, the stage rail, live stats and the
// orchestration that drives them from core events.

import { $, $$, el, round, clock, bytes, dash } from "./util.js";
import { ipc, live } from "./ipc.js";
import { rt, setRt, get } from "./state.js";
import { log } from "./journal.js";
import { toast } from "./toasts.js";
import { showResult } from "./compare.js";
import { setStepMeta } from "./wizard.js";
import { t, onLang } from "./i18n.js";

const STAGES = [
  { id: "probe", labelKey: "run.stage.probe", icon: "ph-magnifying-glass" },
  { id: "extract", labelKey: "run.stage.extract", icon: "ph-file-video" },
  { id: "interp", labelKey: "run.stage.interp", icon: "ph-lightning" },
  { id: "encode", labelKey: "run.stage.encode", icon: "ph-film-strip" },
  { id: "mux", labelKey: "run.stage.mux", icon: "ph-tray-arrow-down" },
];

const SPARK_N = 34;
let spark = [];
let els = {};
let startedAt = 0;
let onDone = null;
let jobFn = null;
let finishing = false;
let phase = "idle";

export function initRun({ job, onFinished }) {
  onDone = onFinished;
  jobFn = job;
  els.ring = $("#ring");
  els.arc = $("#ring-arc");
  els.rot = $("#ring-rot");
  els.pct = $("#ring-pct");
  els.rstage = $("#ring-stage");
  els.steps = $("#steps");
  els.stats = $("#run-stats");
  els.spark = $("#spark");
  els.eta = $("#run-eta");
  els.run = $("#btn-run");
  els.runTxt = $("#btn-run-txt");
  els.cancel = $("#btn-cancel");
  els.hint = $("#run-hint");

  els.stepsHead = el("i", { class: "steps-head", "aria-hidden": "true" });
  els.steps.replaceChildren(els.stepsHead, ...STAGES.map((s) => el("div", { class: "step", role: "listitem", dataset: { id: s.id }, "aria-label": t(s.labelKey), "data-i18n-tip": `tip.stage.${s.id}`, "data-tip": t(`tip.stage.${s.id}`) }, [
    el("span", { class: "step-node" }, [el("i", { class: "ph halo" }), el("i", { class: `ph ${s.icon} ico` }), el("i", { class: "ph ph-check tick" }), el("i", { class: "ph ph-prohibit skip" })]),
    el("span", { class: "step-lbl", "data-i18n": s.labelKey }, t(s.labelKey)),
    el("span", { class: "step-meta" }, ""),
  ])));

  els.spark.innerHTML = `<svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FF2E4C" stop-opacity=".38"/><stop offset="1" stop-color="#FF2E4C" stop-opacity="0"/>
    </linearGradient></defs>
    <path class="spark-area"></path><path class="spark-line"></path>
  </svg><i class="spark-head" aria-hidden="true"></i>`;
  els.area = els.spark.querySelector(".spark-area");
  els.line = els.spark.querySelector(".spark-line");
  els.sparkHead = els.spark.querySelector(".spark-head");
  paintSpark();
  paintRing(0);
  renderStats({});

  els.run.addEventListener("click", () => start());
  els.cancel.addEventListener("click", () => stop());
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.target.closest?.("input, textarea, select, button, .cbx")) return;
    if (rt("wizardStep") !== 2) return;
    if (!els.run.disabled) start();
  });

  ipc.onStage((p) => stage(p));
  ipc.onProgress((p) => progress(p));
  ipc.onLog((p) => log(p.text, p.level || "info"));
  ipc.onDone((p) => { if (rt("running")) finish(p); });

  onLang(relabel);
  return { start, stop, reset };
}

function paintRing(p) {
  const v = round(p, 1);
  els.ring.style.setProperty("--p", v);
  dash(els.arc, v / 100);
  els.rot?.style.setProperty("transform", `rotate(${(v / 100) * 360}deg)`);
  els.ring.setAttribute("aria-valuenow", String(Math.round(v)));
  els.pct.textContent = String(Math.floor(v));
}

function stat(k, id, key) { return el("div", { class: "stat", id }, [el("b", { "data-i18n": key }, k), el("span", {}, "-")]); }

function renderStats(p) {
  const plan = rt("plan");
  const cards = [
    ["frames", "s-frames", "run.statFrames", p.done != null ? `${p.done.toLocaleString("en-US")}${plan ? ` / ${plan.outFrames.toLocaleString("en-US")}` : ""}` : null],
    ["rate", "s-rate", "run.statRate", p.rate ? `${round(p.rate, 1)}` : null],
    ["elapsed", "s-elapsed", "run.statElapsed", p.elapsed != null ? clock(p.elapsed) : null],
    ["written", "s-written", "run.statWritten", p.bytes != null ? bytes(p.bytes) : null],
    ["gpu", "s-gpu", "run.statGpu", p.gpu?.util != null ? `${round(p.gpu.util, 0)}%` : null],
    ["vram", "s-vram", "run.statVram", p.gpu?.vramMb != null ? `${round(p.gpu.vramMb / 1024, 2)} GB` : null],
  ];
  if (!$("#s-frames")) els.stats.replaceChildren(...cards.map(([k, id, key]) => stat(k, id, key)));
  for (const [k, id, , v] of cards) {
    const n = $("#" + id);
    if (!n) continue;
    if (v != null) n.querySelector("span").textContent = v;
    if (k === "rate") n.classList.toggle("is-live", Boolean(rt("running")));
  }
}

function stage({ id, index, of, done }) {
  const node = $(`.step[data-id="${id}"]`, els.steps);
  const label = t(STAGES.find((s) => s.id === id)?.labelKey || id);
  for (const s of $$(".step", els.steps)) if (s !== node) s.classList.remove("is-now");
  if (node && !done) node.classList.add("is-now");
  if (node && done) { node.classList.remove("is-now"); node.classList.add("is-done"); }
  els.steps.classList.add("is-live");
  els.steps.classList.remove("is-complete");
  els.steps.style.setProperty("--sp", String(((index + (done ? 1 : 0)) / of) * 100));
  if (node) node.style.setProperty("--np", done ? "100" : "0");
  if (els.rstage) els.rstage.textContent = done ? t("run.stageDone", { label }) : label;
  if (els.hint && !done) els.hint.textContent = t("run.stageActive", { label });
  els.ring.classList.add("is-run");
  phase = "run";
  setRt({ stage: id, wizardStep: 2 });
  setStepMeta(2, done ? t("run.stageDone", { label }) : label);
}

function progress(p) {
  const overall = round((p.overall ?? 0) * 100, 1);
  paintRing(overall);
  els.ring.classList.add("is-run");
  const elapsed = (performance.now() - startedAt) / 1000;
  els.eta.hidden = false;
  els.eta.textContent = p.eta != null ? t("run.eta", { time: clock(p.eta) }) : "";
  renderStats({ ...p, elapsed });
  if (p.rate) pushSpark(p.rate);
  if (p.gpu) paintGpu(p.gpu);
  const node = $(`.step[data-id="${p.stage}"]`, els.steps);
  if (node) {
    node.querySelector(".step-meta").textContent = `${Math.round((p.stageP || 0) * 100)}%`;
    node.style.setProperty("--np", String(Math.min(100, (p.stageP || 0) * 100)));
  }
  els.steps.style.setProperty("--sp", String(clampStep(p.stage, p.stageP)));
}

function clampStep(id, stageP = 0) {
  const i = STAGES.findIndex((s) => s.id === id);
  if (i < 0) return 0;
  return ((i + Math.min(1, stageP)) / STAGES.length) * 100;
}

function pushSpark(v) {
  spark.push(v);
  if (spark.length > SPARK_N) spark.shift();
  paintSpark();
}

// A real sparkline instead of 34 strobing bars: one path, one gradient fill, one head dot.
// Fewer nodes, less work per tick, and a stable history is readable at a glance.
function paintSpark() {
  if (!els.line) return;
  const vals = spark.slice(-SPARK_N);
  if (!vals.length) {
    els.line.setAttribute("d", "");
    els.area.setAttribute("d", "");
    els.sparkHead.style.opacity = "0";
    return;
  }
  const max = Math.max(1, ...vals);
  const offset = SPARK_N - vals.length;
  const pts = vals.map((v, i) => {
    const x = ((i + offset) / (SPARK_N - 1)) * 100;
    const y = 28 - (Math.max(0, v) / max) * 24;
    return [x, y];
  });
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("");
  els.line.setAttribute("d", line);
  els.area.setAttribute("d", `${line}L${pts[pts.length - 1][0].toFixed(2)},30L${pts[0][0].toFixed(2)},30Z`);
  const [hx, hy] = pts[pts.length - 1];
  els.sparkHead.style.left = `${hx}%`;
  els.sparkHead.style.top = `${(hy / 30) * 100}%`;
  els.sparkHead.style.opacity = max > 0 ? "1" : "0";
}

export function paintGpu(g) {
  const set = (id, p) => { const n = $(id); if (n) n.style.setProperty("--p", p); };
  set("#gpu-strip .meter.cy", g.util);
  set("#gpu-strip .meter.neutral", (g.vramMb / g.vramTotalMb) * 100);
  set("#gpu-strip .meter.mint", (g.tempC / 95) * 100);
  const txt = (id, v) => { const n = $(id); if (n) n.textContent = v; };
  txt("#gpu-util", `${round(g.util, 0)}%`);
  txt("#gpu-vram", `${round(g.vramMb / 1024, 1)} / ${round(g.vramTotalMb / 1024, 0)} GB`);
  txt("#gpu-temp", `${round(g.tempC, 0)}°C`);
}

async function start() {
  if (rt("running")) return;
  const j = jobFn?.();
  if (!j?.source) { toast({ kind: "warn", title: t("run.noSourceTitle"), body: t("run.noSourceBody") }); return; }
  await startJob(j);
}

async function stop() {
  if (!rt("running")) return;
  await ipc.cancel();
}

export async function startJob(job) {
  if (rt("running")) return;
  finishing = false;
  reset();
  setRt({ running: true });
  startedAt = performance.now();
  els.run.disabled = true;
  els.run.setAttribute("aria-busy", "true");
  phase = "run";
  if (get("journalOpen")) {
    const jb = $("#btn-journal");
    if (jb && jb.getAttribute("aria-expanded") !== "true") jb.click();
  }
  els.runTxt.dataset.i18n = "run.working";
  els.runTxt.textContent = t("run.working");
  els.cancel.hidden = false;
  $("#core-pill")?.classList.add("is-busy");
  const src = job.source?.probe;
  const sub = $("#render-sub");
  if (sub && src) { sub.removeAttribute("data-i18n"); sub.textContent = `${job.source.name} · ${src.width}×${src.height} · ${job.factor}× · ${job.model}`; }
  if (els.hint) { els.hint.removeAttribute("data-i18n"); els.hint.textContent = t("run.starting"); }
  log(`job start - ${job.engine}/${job.model} at ${job.factor}× (${live ? "live core" : "mock core"})`, "info");
  try {
    const res = await ipc.start(job);
    if (res?.ok) finish(res.out);
    else if (res?.cancelled) cancelled();
  } catch (e) {
    fail(e.message);
  }
}

function finish(out) {
  if (finishing) return;
  finishing = true;
  const secs = (performance.now() - startedAt) / 1000;
  setRt({ running: false, result: out });
  els.ring.classList.remove("is-run");
  els.ring.classList.add("is-done");
  paintRing(100);
  phase = "done";
  els.rstage.textContent = t("run.done");
  els.run.disabled = false;
  els.run.removeAttribute("aria-busy");
  els.runTxt.dataset.i18n = "run.again";
  els.runTxt.textContent = t("run.again");
  els.cancel.hidden = true;
  els.eta.hidden = true;
  if (els.hint) { els.hint.removeAttribute("data-i18n"); els.hint.textContent = out?.name || t("run.done"); }
  $("#core-pill")?.classList.remove("is-busy");
  for (const s of $$(".step", els.steps)) { s.classList.remove("is-now"); if (!s.classList.contains("is-skip")) s.classList.add("is-done"); }
  els.steps.style.setProperty("--sp", "100");
  els.steps.classList.remove("is-live");
  els.steps.classList.add("is-complete");
  for (const s of $$(".step", els.steps)) s.style.setProperty("--np", "100");
  const w = $("#s-written span"); if (w && out?.bytes) w.textContent = bytes(out.bytes);
  setStepMeta(2, `${round(out?.outFps || 0, 2)} fps · ${clock(out?.seconds || 0)}`);
  toast({
    kind: "ok",
    title: t("run.doneTitle"),
    body: t("run.doneBody", { frames: out?.frames?.toLocaleString?.("en-US") || "-", fps: round(out?.outFps || 0, 2), time: clock(secs) }),
    action: t("run.showFile"),
    onAction: () => ipc.reveal(out.path),
  });
  showResult(out);
  onDone?.(out);
}

function cancelled() {
  setRt({ running: false });
  phase = "cancelled";
  els.ring.classList.remove("is-run");
  els.run.disabled = false;
  els.run.removeAttribute("aria-busy");
  els.runTxt.dataset.i18n = "run.start";
  els.runTxt.textContent = t("run.start");
  els.cancel.hidden = true;
  els.rstage.textContent = t("run.cancelled");
  $("#core-pill")?.classList.remove("is-busy");
  els.steps.classList.remove("is-live");
  const now = $(".step.is-now", els.steps);
  now?.classList.remove("is-now");
  now?.classList.add("is-bad");
  if (els.hint) { els.hint.removeAttribute("data-i18n"); els.hint.textContent = t("run.cancelled"); }
  log(t("run.cancelTitle"), "warn");
  toast({ kind: "warn", title: t("run.cancelTitle"), body: t("run.cancelBody") });
}

function fail(msg) {
  setRt({ running: false });
  phase = "failed";
  els.run.disabled = false;
  els.run.removeAttribute("aria-busy");
  els.runTxt.dataset.i18n = "run.start";
  els.runTxt.textContent = t("run.start");
  els.rstage.textContent = t("run.failed");
  const now = $(".step.is-now", els.steps);
  now?.classList.remove("is-now");
  now?.classList.add("is-bad");
  log(msg, "error");
  toast({ kind: "error", title: t("run.failTitle"), body: msg });
}

export function reset() {
  finishing = false;
  phase = "idle";
  els.ring.classList.remove("is-run", "is-done");
  paintRing(0);
  els.rstage.textContent = t("run.idle");
  els.eta.hidden = true;
  els.cancel.hidden = true;
  els.runTxt.dataset.i18n = "run.start";
  els.runTxt.textContent = t("run.start");
  if (els.hint) { els.hint.setAttribute("data-i18n", "run.ready"); els.hint.textContent = t("run.ready"); }
  els.steps.classList.remove("is-live", "is-complete");
  for (const s of $$(".step", els.steps)) { s.classList.remove("is-now", "is-done", "is-bad", "is-skip"); s.style.setProperty("--np", "0"); s.querySelector(".step-meta").textContent = ""; }
  els.steps.style.setProperty("--sp", "0");
  spark = [];
  pushSpark(0);
}

// Re-render every computed string after a language swap. The stage names, button label,
// current hint and ring caption all carry state, so data-i18n alone cannot cover them.
function relabel() {
  for (const node of $$(".step", els.steps)) {
    const s = STAGES.find((x) => x.id === node.dataset.id);
    if (!s) continue;
    node.setAttribute("aria-label", t(s.labelKey));
    node.querySelector(".step-lbl").textContent = t(s.labelKey);
  }
  const result = rt("result");
  if (phase === "run") {
    const id = rt("stage");
    const s = STAGES.find((x) => x.id === id);
    if (s) {
      els.rstage.textContent = t(s.labelKey);
      if (els.hint) { els.hint.removeAttribute("data-i18n"); els.hint.textContent = t("run.stageActive", { label: t(s.labelKey) }); }
      setStepMeta(2, t(s.labelKey));
    }
    els.runTxt.dataset.i18n = "run.working";
    els.runTxt.textContent = t("run.working");
  } else if (phase === "done") {
    els.rstage.textContent = t("run.done");
    els.runTxt.dataset.i18n = "run.again";
    els.runTxt.textContent = t("run.again");
    if (els.hint) { els.hint.removeAttribute("data-i18n"); els.hint.textContent = result?.name || t("run.done"); }
    if (result) setStepMeta(2, `${round(result.outFps || 0, 2)} fps · ${clock(result.seconds || 0)}`);
  } else if (phase === "cancelled") {
    els.rstage.textContent = t("run.cancelled");
    if (els.hint) { els.hint.removeAttribute("data-i18n"); els.hint.textContent = t("run.cancelled"); }
    setStepMeta(2, t("run.cancelled"));
  } else if (phase === "failed") {
    els.rstage.textContent = t("run.failed");
    setStepMeta(2, t("run.failed"));
  } else {
    els.rstage.textContent = t("run.idle");
    els.runTxt.dataset.i18n = "run.start";
    els.runTxt.textContent = t("run.start");
    if (els.hint) { els.hint.setAttribute("data-i18n", "run.ready"); els.hint.textContent = t("run.ready"); }
    setStepMeta(2, result ? `${round(result.outFps || 0, 2)} fps · ${clock(result.seconds || 0)}` : t("meta.run"));
  }
}
