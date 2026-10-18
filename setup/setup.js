// flow. setup - the wizard. One state object, four steps, and a thin bridge to the setup core.

import { t, initI18n, getLang, setLang, onLang, applyDom } from "./i18n.js";
import { api, live } from "./api.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function el(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style" && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v)) sk.startsWith("--") ? n.style.setProperty(sk, String(sv)) : (n.style[sk] = sv);
    } else if (k === "html") n.innerHTML = v;
    else if (k === "dataset") Object.assign(n.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of [].concat(kids)) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

const INST = [
  { id: "prepare", icon: "gear" },
  { id: "app", icon: "window" },
  { id: "engine", icon: "bolt" },
  { id: "tools", icon: "film" },
  { id: "finish", icon: "flag" },
];

const UNINST = [
  { id: "stop", icon: "power" },
  { id: "app", icon: "trash" },
  { id: "data", icon: "database" },
  { id: "finish", icon: "spark" },
];

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICON_SVG = {
  gear: `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1"/></svg>`,
  window: `<svg ${SVG_ATTRS}><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M3.5 9h17"/><path d="M8.5 14.2l2 1.8 4-4"/></svg>`,
  bolt: `<svg ${SVG_ATTRS}><path d="M13 2.8 5 13h6l-1 8 8-10h-6l1-8.2z"/></svg>`,
  film: `<svg ${SVG_ATTRS}><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M7.5 5v14M16.5 5v14M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4"/></svg>`,
  flag: `<svg ${SVG_ATTRS}><path d="M6 21V4"/><path d="M6 4h11l-2 4 2 4H6"/></svg>`,
  power: `<svg ${SVG_ATTRS}><path d="M12 3v9"/><path d="M7 6.5a7 7 0 1 0 10 0"/></svg>`,
  trash: `<svg ${SVG_ATTRS}><path d="M4 7h16M9.5 7V5h5v2M6.5 7l.8 13h9.4l.8-13M10 11v5M14 11v5"/></svg>`,
  database: `<svg ${SVG_ATTRS}><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>`,
  spark: `<svg ${SVG_ATTRS}><path d="M12 3v6M12 15v6M3 12h6M15 12h6M5.6 5.6l4.2 4.2M14.2 14.2l4.2 4.2M18.4 5.6l-4.2 4.2M9.8 14.2l-4.2 4.2"/></svg>`,
  check: `<svg ${SVG_ATTRS}><path d="M5 12.5l4.2 4.2L19 7"/></svg>`,
};

const state = {
  step: 0,
  mode: "install", // install | repair | update | uninstall
  pre: null,
  preError: null,
  checking: false,
  toolsMode: "none",
  toolsChosen: false,
  manualTools: null,
  options: { dir: "", desktop: true, start: true, launch: true },
  installing: false,
  uninstalling: false,
  closing: false,
  removeData: false,
  cancelling: false,
  cancelled: false,
  error: null,
  outcome: null,
  inst: Object.fromEntries(INST.map((s) => [s.id, { phase: "wait", pct: 0 }])),
  currentStage: "prepare",
  logs: [],
  sceneTimer: 0,
  lastBurst: 0,
  arcLen: 527,
  stageArcLen: 433,
};

let progressRaf = 0;
let pendingProgress = null;

const els = {};

function boot() {
  initI18n();
  Object.assign(els, {
    steps: $("#s-steps"),
    ind: $("#s-ind"),
    stages: $("#s-stages"),
    actions: $("#s-actions"),
    hint: $("#s-foot-hint"),
    lang: $("#lang-btn"),
    recheck: $("#recheck"),
    status: $("#req-status"),
    statusTxt: $("#req-status-txt"),
    toolPaths: $("#tool-paths"),
    toolModes: $("#tool-modes"),
    toolActions: $("#tool-actions"),
    toolNote: $("#tool-note"),
    toolsSub: $("#tools-sub"),
    toolsBadge: $("#tools-badge"),
    instStages: $("#inst-stages"),
    instLog: $("#inst-log"),
    instError: $("#inst-error"),
    instErrorBody: $("#inst-error-body"),
    instState: $("#inst-state"),
    instRing: $("#inst-ring"),
    instArc: $("#ir-arc"),
    instRot: $("#ir-rot"),
    instPct: $("#inst-pct"),
    instLabel: $("#inst-stage-label"),
    shell: $("#setup-shell"),
    cinema: $("#s-cinema"),
    instPill: $("#inst-pill"),
  });
  if (live) document.documentElement.classList.add("is-live");
  state.arcLen = els.instArc?.getTotalLength?.() || 527;
  const stageArc = $("#ir-stage-arc");
  state.stageArcLen = stageArc?.getTotalLength?.() || 433;

  // stages are stacked; the CSS does the crossfade, aria-hidden handles the a11y tree
  $$(".s-stage").forEach((s) => { s.hidden = false; s.setAttribute("aria-hidden", "true"); });
  buildInstallStages();
  bind();
  go(0, true);
  renderFooter();
  check();
  requestAnimationFrame(layoutRail);
  document.fonts?.ready.then(() => layoutRail());
  addEventListener("resize", () => layoutRail());

  onLang(() => {
    renderWelcome();
    renderSystem();
    renderTools();
    renderOptions();
    renderInstallHeader();
    renderInstallStages();
    renderDone();
    renderFooter();
    if (state.error) {
      const et = $("#inst-error-title");
      if (et) et.textContent = t(state.mode === "uninstall" ? "uninst.errorTitle" : "done.errorTitle");
      if (els.instErrorBody) els.instErrorBody.textContent = state.error;
    }
    layoutRail();
  });

  Promise.resolve(api.onCloseRequested(async () => {
    if (state.closing) return true;
    if (state.uninstalling) { askWait(); return false; }
    if (!state.installing) return true;
    const quit = await askQuit();
    if (quit) await api.cancelInstall();
    return quit;
  })).catch(() => {});
}

function bind() {
  els.lang.addEventListener("click", () => setLang(getLang() === "en" ? "fa" : "en"));
  $("#win-min").addEventListener("click", () => api.windowAction("minimize"));
  $("#win-close").addEventListener("click", requestClose);
  els.recheck.addEventListener("click", check);
  $("#opt-folder").addEventListener("click", async () => {
    const dir = await api.pickFolder(state.options.dir);
    if (dir) { state.options.dir = dir; renderOptions(); renderFooter(); }
  });
  for (const [id, key] of [["sw-desktop", "desktop"], ["sw-start", "start"], ["sw-launch", "launch"]]) {
    const b = $("#" + id);
    b.addEventListener("click", () => {
      state.options[key] = b.getAttribute("aria-checked") !== "true";
      b.setAttribute("aria-checked", String(state.options[key]));
      const row = b.closest(".opt-sw");
      row?.classList.remove("is-pulse");
      void row?.offsetWidth;
      row?.classList.add("is-pulse");
      setTimeout(() => row?.classList.remove("is-pulse"), 500);
    });
  }
  $("#ip-repair").addEventListener("click", () => { if (!state.installing && !state.uninstalling) go(1); });
  $("#ip-uninstall").addEventListener("click", openUninstallModal);
  $("#done-open").addEventListener("click", openFlow);
  $("#done-folder").addEventListener("click", () => api.showPath(state.outcome?.path || state.options.dir));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if ($(".s-ovl")) return;
      requestClose();
      return;
    }
    if (e.key === "Enter" && !e.target.closest?.("input, textarea, select, button, .s-ovl")) {
      const primary = els.actions.querySelector(".btn-primary:not([disabled])");
      if (primary) { e.preventDefault(); primary.click(); }
    }
  });
  $$(".s-step").forEach((li, i) => {
    li.addEventListener("click", () => {
      if (state.installing || state.uninstalling) return;
      if (i < state.step && i < 4) go(i);
    });
  });
}

/* ── preflight ── */
async function check() {
  if (state.checking) return;
  state.checking = true;
  state.preError = null;
  const scanStarted = performance.now();
  els.recheck.classList.add("is-busy");
  const ri = els.recheck.querySelector("i");
  ri?.classList.add("is-spin");
  $('.s-stage[data-stage="1"]')?.classList.add("is-scanning");
  renderSystem();
  renderStatus();
  renderTools();
  renderFooter();
  try {
    state.pre = await api.preflight();
    if (!state.toolsChosen) {
      state.toolsMode = state.pre?.tools?.ok ? "existing" : "none";
    } else if (state.toolsMode === "existing" && !state.pre?.tools?.ok) {
      state.toolsMode = "none";
    }
    if (!state.options.dir) state.options.dir = state.pre?.installDir || "";
    if (!state.uninstalling && !state.installing) {
      const ins = state.pre?.installed;
      state.mode = ins?.ok
        ? (String(ins.version || "") === String(state.pre?.setupVersion || "") ? "repair" : "update")
        : "install";
    }
    maybeAutoLang();
  } catch (e) {
    state.pre = null;
    state.preError = e?.message || String(e);
    toast("error", t("req.checking"), state.preError);
  } finally {
    const remaining = 950 - (performance.now() - scanStarted);
    if (remaining > 0) await sleep(remaining);
    state.checking = false;
    $('.s-stage[data-stage="1"]')?.classList.remove("is-scanning");
    els.recheck.classList.remove("is-busy");
    ri?.classList.remove("is-spin");
    renderWelcome();
    renderInstallHeader();
    renderSystem();
    renderStatus();
    renderTools();
    renderOptions();
    renderFooter();
    layoutRail();
  }
}

function maybeAutoLang() {
  try {
    if (localStorage.getItem("flow-setup.lang.v1")) return;
    if (getLang() === "en" && /^fa/i.test(state.pre?.os?.locale || "")) setLang("fa");
  } catch {}
}

function toolsReady() {
  if (!state.pre || state.checking || state.preError) return false;
  if (state.toolsMode === "existing") return Boolean(state.pre.tools?.ok);
  if (state.toolsMode === "download") return true;
  if (state.toolsMode === "browse") return Boolean(state.manualTools?.ok);
  return false;
}

function toolPaths() {
  if (state.toolsMode === "existing") return state.pre?.tools || null;
  if (state.toolsMode === "browse") return state.manualTools || null;
  return null;
}

function renderWelcome() {
  const ins = state.pre?.installed;
  const installed = Boolean(ins?.ok) && !state.uninstalling;

  const pre = $("#h-welcome [data-i18n^='welcome.title']");
  const post = $("#h-welcome span:last-of-type");
  const sub = $("#welcome-sub");
  const repair = installed && state.mode === "repair";
  const update = installed && state.mode === "update";
  if (pre) {
    const key = repair ? "welcome.titleRepairPre" : update ? "welcome.titleUpdatePre" : "welcome.titlePre";
    pre.dataset.i18n = key; pre.textContent = t(key);
    if (post) {
      const pkey = repair ? "welcome.titleRepairPost" : update ? "welcome.titleUpdatePost" : "welcome.titlePost";
      post.dataset.i18n = pkey; post.textContent = t(pkey);
    }
  }
  if (sub) {
    const key = repair ? "welcome.repairSub" : update ? "welcome.updateSub" : "welcome.sub";
    sub.dataset.i18n = key; sub.textContent = t(key);
  }

  renderInstalledPill();
}

function renderInstalledPill() {
  const pill = els.instPill;
  if (!pill) return;
  const ins = state.pre?.installed;
  const installed = Boolean(ins?.ok) && !state.uninstalling && !state.installing && state.step < 3;
  pill.hidden = !installed;
  if (!installed) return;
  const version = ins.version || state.pre?.setupVersion || "1.0.0";
  const title = $("#ip-title");
  if (title) title.textContent = t("welcome.installed", { version });
  const path = $("#ip-path");
  if (path) path.textContent = ins.path || state.pre?.installDir || "—";
  const label = $("#ip-repair-label");
  const key = state.mode === "update" ? "welcome.update" : "welcome.repair";
  if (label) { label.dataset.i18n = key; label.textContent = t(key); }
}

function renderSystem() {
  const p = state.pre;
  $("#sys-os").textContent = p ? `${p.os.name}` : "—";
  $("#sys-os-sub").textContent = p ? `${p.os.build} · ${p.os.arch}` : "—";
  $("#sys-wv").textContent = p?.webview2?.ok ? p.webview2.version : p ? t("req.notFound") : "—";
  $("#sys-wv-sub").textContent = p?.webview2?.ok ? "Evergreen" : p ? "runtime missing" : "—";
  $("#sys-disk").textContent = p?.disk ? `${p.disk.freeGb.toFixed(1)} GB` : "—";
  $("#sys-disk-sub").textContent = p?.disk?.root || "—";
  const dm = $("#disk-meter i");
  if (dm) dm.style.width = p?.disk ? `${clamp(p.disk.freeGb / 100, 0.03, 1) * 100}%` : "0%";

  const g = p?.gpu;
  $("#gpu-sub").textContent = g?.ok ? g.driver ? `driver ${g.driver}` : "GPU" : p ? "not detected" : "—";
  $("#gpu-detail").textContent = g?.ok ? `${g.name} · ${(g.memoryMb / 1024).toFixed(0)} GB VRAM` : p ? "nvidia-smi did not answer. The CPU path still works, just slowly." : "—";
  $("#gpu-vram").textContent = g?.ok ? `${(g.memoryMb / 1024).toFixed(0)} GB` : "—";
  const gb = $("#gpu-badge");
  gb.className = "s-badge " + (!p ? "is-wait" : g?.ok && g.vulkan ? "is-good" : "is-bad");
  gb.innerHTML = `<i class="ph ${!p ? "ph-circle-notch" : g?.ok && g.vulkan ? "ph-check" : "ph-warning-octagon"}"></i>`;

  $("#engine-size").textContent = p?.engine?.sizeMb ? `${p.engine.sizeMb.toFixed(1)} MB` : "17.7 MB";
  const eb = $("#engine-badge");
  eb.className = "s-badge " + (p ? "is-good" : "is-wait");
  eb.innerHTML = `<i class="ph ${p ? "ph-check" : "ph-circle-notch"}"></i>`;
}

function renderStatus() {
  let mode = "is-good", text = t("req.allGood"), spin = false;
  if (state.checking || !state.pre) {
    mode = "is-wait";
    text = t("req.checking");
    spin = true;
  } else if (state.preError) {
    mode = "is-bad";
    text = state.preError;
  } else if (!toolsReady()) {
    mode = "is-bad";
    text = t("req.needsChoice");
  }
  els.status.className = "req-status " + mode;
  els.statusTxt.textContent = text;
  const spinIcon = els.status.querySelector(".rs-spin");
  if (spinIcon) spinIcon.style.display = spin ? "" : "none";
}

function renderTools() {
  if (!els.toolModes) return;
  const ready = toolsReady();
  const paths = toolPaths();
  const busy = state.checking || !state.pre;

  els.toolsSub.textContent = busy ? t("req.checking") : ready ? t("req.toolsFound") : t("req.toolsMissing");
  els.toolsSub.style.color = !busy && !ready ? "" : "";
  els.toolsBadge.className = "s-badge " + (busy ? "is-wait" : ready ? "is-good" : "is-bad");
  els.toolsBadge.innerHTML = `<i class="ph ${busy ? "ph-circle-notch" : ready ? "ph-check" : "ph-warning-octagon"}"></i>`;

  els.toolPaths.replaceChildren();
  const makePath = (label, data, key) => {
    const ok = Boolean(data?.path);
    return el("div", { class: "tool-path" }, [
      el("i", { class: `ph ${key === "ffmpeg" ? "ph-film-strip" : "ph-magnifying-glass"}` }),
      el("div", {}, [
        el("em", {}, label),
        el("code", { title: data?.path || "" }, ok ? data.path : state.toolsMode === "download" ? t("req.duringSetup") : t("req.notFound")),
      ]),
      el("i", { class: `ph ${ok ? "ph-check-circle tp-ok" : data === null || !ok ? "ph-minus tp-ok" : "ph-minus"}`, style: ok ? "" : "color:var(--ink-3)" }),
    ]);
  };
  if (state.toolsMode === "download") {
    els.toolPaths.append(
      makePath(t("req.ffmpegPath"), { path: "" }, "ffmpeg"),
      makePath(t("req.ffprobePath"), { path: "" }, "ffprobe")
    );
  } else {
    els.toolPaths.append(
      makePath(t("req.ffmpegPath"), paths?.ffmpeg, "ffmpeg"),
      makePath(t("req.ffprobePath"), paths?.ffprobe, "ffprobe")
    );
  }

  els.toolModes.replaceChildren();
  const modes = [
    { id: "existing", label: t("req.modeExisting"), icon: "ph-desktop-tower", disabled: !state.pre?.tools?.ok || busy },
    { id: "browse", label: t("req.choose"), icon: "ph-folder-open" },
    { id: "download", label: t("req.modeDownload"), icon: "ph-download-simple" },
  ];
  for (const m of modes) {
    const b = el("button", {
      class: "tmode" + (state.toolsMode === m.id ? " is-on" : ""),
      type: "button", disabled: m.disabled || null,
      onclick: async () => {
        if (m.id === "existing") { state.toolsMode = "existing"; state.toolsChosen = true; renderTools(); renderStatus(); renderFooter(); }
        else if (m.id === "download") { state.toolsMode = "download"; state.toolsChosen = true; state.manualTools = null; renderTools(); renderStatus(); renderFooter(); }
        else {
          const picked = await api.pickTools();
          if (!picked) return;
          const verdict = await api.validateTools(picked.ffmpeg?.path, picked.ffprobe?.path);
          state.toolsMode = "browse";
          state.toolsChosen = true;
          state.manualTools = verdict.ok
            ? { ffmpeg: verdict.ffmpeg, ffprobe: verdict.ffprobe, ok: true }
            : { ffmpeg: picked.ffmpeg, ffprobe: picked.ffprobe, ok: false, error: verdict.error };
          state.pre = state.pre || {};
          state.pre.tools = { ...(state.pre.tools || {}), ok: verdict.ok, ffmpeg: picked.ffmpeg, ffprobe: picked.ffprobe, source: "picked" };
          renderTools(); renderStatus(); renderFooter();
        }
      },
    }, [el("i", { class: `ph ${m.icon}` }), el("span", {}, m.label)]);
    els.toolModes.append(b);
  }

  els.toolActions.replaceChildren();
  if (state.toolsMode === "browse") {
    els.toolActions.append(el("button", {
      class: "btn btn-xs btn-secondary", type: "button",
      onclick: async () => {
        const picked = await api.pickTools();
        if (!picked) return;
        const verdict = await api.validateTools(picked.ffmpeg?.path, picked.ffprobe?.path);
        state.manualTools = verdict.ok ? { ffmpeg: verdict.ffmpeg, ffprobe: verdict.ffprobe, ok: true } : { ...picked, ok: false, error: verdict.error };
        renderTools(); renderStatus(); renderFooter();
      },
    }, [el("i", { class: "ph ph-arrows-clockwise" }), el("span", {}, t("req.choose"))]));
  }

  const note = els.toolNote;
  note.hidden = false;
  note.className = "rc-note";
  if (state.toolsMode === "download") note.textContent = t("req.downloadNote");
  else if (state.toolsMode === "browse" && state.manualTools && !state.manualTools.ok) { note.classList.add("is-bad"); note.textContent = state.manualTools.error || t("req.invalidTools"); }
  else if (!busy && !ready) note.textContent = t("req.toolsMissing");
  else if (state.toolsMode === "browse") note.textContent = t("req.browseHint");
  else note.hidden = true;
}

function renderOptions() {
  $("#opt-path").textContent = state.options.dir || "—";
  const oh = $("#h-opt");
  const os = $("#opt-sub");
  if (oh) oh.textContent = t(state.mode === "repair" ? "opt.repairTitle" : state.mode === "update" ? "opt.updateTitle" : "opt.title");
  if (os) os.textContent = t(state.mode === "repair" ? "opt.repairSub" : state.mode === "update" ? "opt.updateSub" : "opt.sub");
  for (const [id, key] of [["sw-desktop", "desktop"], ["sw-start", "start"], ["sw-launch", "launch"]]) {
    $("#" + id).setAttribute("aria-checked", String(Boolean(state.options[key])));
  }
  const mode = state.toolsMode;
  $("#opt-tools-size").textContent = mode === "download" ? t("opt.toolsDownload") : mode === "existing" ? t("opt.toolsExisting") : t("req.duringSetup");
  const appMb = state.pre?.sizes?.appMb ?? 5.5;
  const engineMb = state.pre?.sizes?.engineMb ?? 17.7;
  const badge = $("#opt-total-badge");
  badge.textContent = mode === "download" ? t("opt.dlBadge") : t("opt.total", { size: Math.round(appMb + engineMb) });
  badge.className = "s-badge is-good";
}

/* ── steps ── */
const MOTION_SELECTOR = ".s-head-row, .w-copy > *, .w-art, .w-trust, .req-status, .sys-card, .req-grid > *, .opt-folder, .opt-switches, .opt-summary, .inst-grid, .inst-error, .done-art, .done-card, .done-actions";

function sceneEnter(stage) {
  if (!stage) return;
  $$(".s-stage").forEach((s) => s.classList.remove("is-enter"));
  stage.querySelectorAll(MOTION_SELECTOR).forEach((n, i) => n.style.setProperty("--mi", String(Math.min(i, 12))));
  void stage.offsetWidth;
  stage.classList.add("is-enter");
  clearTimeout(state.sceneTimer);
  state.sceneTimer = setTimeout(() => stage.classList.remove("is-enter"), 1500);
  const cin = els.cinema;
  if (cin) {
    cin.classList.remove("is-sweep");
    void cin.offsetWidth;
    cin.classList.add("is-sweep");
    setTimeout(() => cin.classList.remove("is-sweep"), 980);
  }
}

function go(n, instant = false) {
  n = clamp(Number(n) || 0, 0, 4);
  if ((state.installing || state.uninstalling) && n !== 3 && n !== 4) return;
  if (n === 1 && !state.checking && !state.pre && !state.preError) check();
  state.step = n;
  $$(".s-stage").forEach((s) => {
    const on = Number(s.dataset.stage) === n;
    s.classList.toggle("is-active", on);
    s.setAttribute("aria-hidden", String(!on));
    if (on) { const sc = s.querySelector(".s-scroll"); if (sc) sc.scrollTop = 0; }
  });
  $$(".s-step").forEach((s, i) => {
    s.classList.toggle("is-now", n < 4 && i === n);
    s.classList.toggle("is-done", i < n || n === 4);
  });
  els.steps.classList.toggle("is-complete", n === 4);
  els.steps.style.setProperty("--rail-fill", `${n === 4 ? 100 : (n / 3) * 100}%`);
  renderInstallHeader();
  renderInstalledPill();
  renderFooter();
  if (n === 1) { renderStatus(); renderTools(); }
  if (n === 2) renderOptions();
  if (n === 4) renderDone();
  if (n === 0) renderWelcome();
  const stage = $(`.s-stage[data-stage="${n}"]`);
  if (instant) requestAnimationFrame(() => sceneEnter(stage));
  else sceneEnter(stage);
  if (n === 4 && state.lastBurst !== state.outcome) {
    state.lastBurst = state.outcome;
    setTimeout(() => burstDone(state.mode === "uninstall"), 320);
  }
  if (n !== 4) state.lastBurst = 0;
  layoutRail();
}

function layoutRail() {
  if (!els.ind || !els.steps) return;
  const now = $(".s-step.is-now");
  if (!now || state.step === 4) { els.ind.style.opacity = "0"; return; }
  els.ind.style.opacity = "1";
  els.ind.style.setProperty("--ind-y", `${now.offsetTop}px`);
  els.ind.style.setProperty("--ind-h", `${now.offsetHeight}px`);
}

function stepHint(n) {
  if (n < 4) return t("chrome.step", { n: n + 1 });
  return t("chrome.local");
}

function renderInstallHeader() {
  const eyebrow = $("#inst-eyebrow");
  const title = $("#h-inst");
  const sub = $("#inst-sub");
  const hint = $("#inst-hint");
  if (!title) return;
  if (hint) hint.textContent = t(state.mode === "uninstall" ? "uninst.hint" : "inst.cancelNote");
  const railStep = $('#s-steps .s-step[data-step="3"]');
  if (railStep) {
    const rb = railStep.querySelector("b");
    const re = railStep.querySelector("em");
    const rKey = state.mode === "repair" ? "rail.repair" : state.mode === "update" ? "rail.update" : "rail.install";
    const rSub = state.mode === "repair" ? "rail.repairSub" : state.mode === "update" ? "rail.updateSub" : "rail.installSub";
    if (rb) { rb.dataset.i18n = rKey; rb.textContent = t(rKey); }
    if (re) { re.dataset.i18n = rSub; re.textContent = t(rSub); }
  }
  if (state.mode === "uninstall") {
    if (eyebrow) eyebrow.textContent = t("uninst.eyebrow");
    title.textContent = t("uninst.pageTitle");
    if (sub) sub.textContent = t("uninst.sub");
  } else if (state.mode === "repair") {
    if (eyebrow) eyebrow.textContent = t("inst.eyebrow");
    title.textContent = t("inst.repairTitle");
    if (sub) sub.textContent = t("inst.repairSub");
  } else if (state.mode === "update") {
    if (eyebrow) eyebrow.textContent = t("inst.eyebrow");
    title.textContent = t("inst.updateTitle");
    if (sub) sub.textContent = t("inst.updateSub");
  } else {
    if (eyebrow) eyebrow.textContent = t("inst.eyebrow");
    title.textContent = t("inst.title");
    if (sub) sub.textContent = t("inst.sub");
  }
}

function openUninstallModal() {
  if (state.installing || state.uninstalling) return;
  const dataMb = Number(state.pre?.dataMb || 0);
  const size = formatMb(dataMb);
  let removeData = false;
  const toggle = el("div", { class: "un-check", role: "checkbox", tabindex: "0", "aria-checked": "false" }, [
    el("span", { class: "uc-box" }, [el("i", { class: "ph ph-check" })]),
    el("span", { class: "uc-txt" }, [
      el("b", {}, t("uninst.data", { size })),
      el("em", {}, t("uninst.dataSub")),
    ]),
  ]);
  const flip = () => {
    removeData = !removeData;
    toggle.classList.toggle("is-on", removeData);
    toggle.setAttribute("aria-checked", String(removeData));
  };
  toggle.addEventListener("click", flip);
  toggle.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
  });
  const body = el("div", { class: "uninstall-confirm" }, [
    el("div", { class: "un-warn" }, [
      el("i", { class: "ph ph-warning" }),
      el("div", {}, [el("b", {}, t("uninst.warnTitle")), el("p", {}, t("uninst.body"))]),
    ]),
    toggle,
    el("p", { class: "un-note" }, t("uninst.keep")),
  ]);
  openModal(t("uninst.title"), body, [
    { label: t("uninst.cancel"), kind: "btn-ghost", onClick: (close) => close() },
    {
      label: t("uninst.confirm"), kind: "btn-danger",
      onClick: (close) => { close(); beginUninstall(removeData); },
    },
  ]);
}

function formatMb(v) {
  if (!Number.isFinite(v) || v <= 0) return "0";
  return v >= 100 ? String(Math.round(v)) : v.toFixed(v >= 10 ? 0 : 1);
}

async function beginUninstall(removeData) {
  if (state.installing || state.uninstalling) return;
  state.mode = "uninstall";
  state.uninstalling = true;
  state.removeData = Boolean(removeData);
  state.error = null;
  state.cancelled = false;
  state.outcome = null;
  state.inst = Object.fromEntries(UNINST.map((s) => [s.id, { phase: "wait", pct: 0 }]));
  state.logs = [];
  els.instLog.replaceChildren();
  els.instLog.classList.remove("is-done");
  els.instError.hidden = true;
  els.instRing.classList.remove("is-done");
  buildInstallStages();
  renderInstallHeader();
  renderInstallStages();
  resetProgressQueue();
  paintRing(0, "stop", 0);
  setInstState("running", t("uninst.starting"));
  els.instLog.append(el("span", { class: "l-dim" }, `${t("uninst.starting")}\n`));
  els.shell.classList.add("is-uninstalling");
  go(3);
  renderFooter();
  try {
    const out = await api.startUninstall(state.removeData, {
      stage: (p) => {
        const s = state.inst[p.id];
        if (!s) return;
        pendingProgress = null;
        if (!p.done && state.currentStage !== p.id) pulseRing();
        s.phase = p.done ? "done" : "active";
        if (p.done) s.pct = 1;
        state.currentStage = p.id;
        renderInstallStages();
        paintRing(p.done ? (p.index + 1) / p.of : p.index / p.of, p.id, p.done ? 1 : 0);
        setInstState("running", t(`uninst.stage.${p.id}`));
      },
      progress: (p) => queueProgress(p),
      log: (level, text) => logLine(level || "info", text),
    });
    if (!out?.ok) throw new Error(out?.error || "the uninstaller did not report success");
    state.uninstalling = false;
    state.outcome = { ...out, kind: "uninstall", mode: "uninstall" };
    for (const s of Object.values(state.inst)) { s.phase = "done"; s.pct = 1; }
    renderInstallStages();
    paintRing(1, "finish", 1);
    setInstState("ok", t("uninst.done"));
    els.instLog.classList.add("is-done");
    els.instRing.classList.remove("is-live");
    els.instRing.classList.add("is-done");
    logLine("ok", t("uninst.doneLog"));
    renderFooter();
    await sleep(1000);
    go(4);
  } catch (e) {
    state.uninstalling = false;
    state.error = e?.message || String(e);
    setInstState("bad", t("uninst.error"));
    const et = $("#inst-error-title");
    if (et) et.textContent = t("uninst.errorTitle");
    els.instError.hidden = false;
    els.instErrorBody.textContent = state.error;
    const active = $(".inst-stage.is-active", els.instStages);
    if (active && state.inst[active.dataset.id]) state.inst[active.dataset.id].phase = "error";
    renderInstallStages();
    els.instLog.classList.add("is-done");
    logLine("error", state.error);
    renderFooter();
  }
}

async function exitUninstall() {
  state.uninstalling = false;
  state.mode = "install";
  state.error = null;
  state.outcome = null;
  els.shell.classList.remove("is-uninstalling");
  buildInstallStages();
  await check();
  go(0);
}

function askWait() {
  if ($(".s-ovl")) return;
  openModal(t("uninst.waitTitle"), el("p", { class: "un-note" }, t("uninst.waitBody")), [
    { label: t("uninst.waitStay"), kind: "btn-primary", onClick: (close) => close() },
  ]);
}

function renderFooter() {
  if (!els.actions) return;
  if (state.step === 3) {
    els.hint.textContent = state.mode === "uninstall" ? t("uninst.hint") : t("inst.cancelNote");
  } else if (state.step === 4 && state.mode === "uninstall") {
    els.hint.textContent = t("uninst.hintDone");
  } else {
    els.hint.textContent = stepHint(state.step);
  }
  els.actions.replaceChildren();
  const add = (label, kind, icon, onClick, disabled = false) => {
    const b = el("button", { class: `btn ${kind}`, type: "button", disabled: disabled || null, onclick: onClick }, [
      icon ? el("i", { class: `ph ${icon}` }) : null,
      el("span", {}, label),
    ]);
    els.actions.append(b);
    return b;
  };

  if (state.step === 0) {
    add(t("welcome.details"), "btn-ghost btn-sm", "ph-info", showDetails);
    const key = state.mode === "update" ? "welcome.update" : state.mode === "repair" ? "welcome.repair" : "welcome.start";
    const icon = state.mode === "update" ? "ph-arrows-clockwise" : state.mode === "repair" ? "ph-wrench" : "ph-rocket-launch";
    add(t(key), "btn-primary btn-lg btn-beam", icon, () => go(1));
  } else if (state.step === 1) {
    add(t("common.back"), "btn-ghost btn-sm", "ph-arrow-left", () => go(0));
    add(t("req.continue"), "btn-primary btn-lg btn-beam", "ph-arrow-right", () => go(2), !toolsReady() || state.checking);
  } else if (state.step === 2) {
    add(t("common.back"), "btn-ghost btn-sm", "ph-arrow-left", () => go(1));
    const key = state.mode === "update" ? "opt.update" : state.mode === "repair" ? "opt.repair" : "opt.install";
    const icon = state.mode === "update" ? "ph-arrows-clockwise" : state.mode === "repair" ? "ph-wrench" : "ph-download-simple";
    add(t(key), "btn-primary btn-lg btn-beam", icon, startInstall, !state.options.dir);
  } else if (state.step === 3) {
    if (state.uninstalling) {
      add(t("uninst.running"), "btn-ghost btn-sm", "ph-circle-notch", () => {}, true);
    } else if (state.error) {
      add(t("common.back"), "btn-ghost btn-sm", "ph-arrow-left", () => { if (state.mode === "uninstall") exitUninstall(); else { state.error = null; go(2); } });
      add(t("common.retry"), "btn-primary btn-lg btn-beam", "ph-arrows-clockwise", () => { if (state.mode === "uninstall") beginUninstall(state.removeData); else startInstall(); });
    } else if (state.cancelled) {
      add(t("common.back"), "btn-ghost btn-sm", "ph-arrow-left", () => { state.cancelled = false; go(2); });
      add(t("common.retry"), "btn-primary btn-lg btn-beam", "ph-arrows-clockwise", startInstall);
    } else if (state.installing) {
      add(t(state.cancelling ? "inst.cancelling" : "inst.cancel"), "btn-ghost btn-sm", "ph-stop", cancelInstall, state.cancelling);
    }
  } else if (state.step === 4) {
    add(t("done.close"), "btn-ghost btn-sm", "ph-x", requestClose);
  }
}

function showDetails() {
  const body = el("div", { class: "details" }, [
    detailRow("ph-app-window", t("details.app")),
    detailRow("ph-lightning", t("details.engine")),
    detailRow("ph-film-strip", t("details.tools")),
    el("p", { class: "detail-note" }, t("details.where")),
    el("p", { class: "detail-privacy" }, [el("i", { class: "ph ph-shield-check" }), t("details.privacy")]),
  ]);
  openModal(t("details.title"), body, [{ label: t("details.ok"), kind: "btn-primary", onClick: (close) => close() }]);
}

function detailRow(icon, text) {
  return el("div", { class: "detail-row" }, [el("i", { class: `ph ${icon}` }), el("span", {}, text)]);
}

function openModal(title, body, actions = []) {
  const ovl = el("div", { class: "s-ovl", role: "dialog", "aria-modal": "true", "aria-label": title });
  const modal = el("div", { class: "s-modal" }, [
    el("h3", {}, title),
    el("div", { class: "detail-body" }, body),
    el("div", { class: "m-acts" }, actions.map((a) => el("button", {
      class: `btn ${a.kind || "btn-ghost"}`, type: "button",
      onclick: () => a.onClick?.(close),
    }, a.label))),
  ]);
  const close = () => { ovl.classList.add("is-out"); setTimeout(() => ovl.remove(), 160); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  ovl.addEventListener("pointerdown", (e) => { if (e.target === ovl) close(); });
  ovl.append(modal);
  $("#s-modal-root").replaceChildren(ovl);
  document.addEventListener("keydown", onKey);
  (modal.querySelector("button") || modal).focus?.({ preventScroll: true });
  return close;
}

function askQuit() {
  return new Promise((resolve) => {
    const ovl = el("div", { class: "s-ovl", role: "dialog", "aria-modal": "true" });
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ovl.remove(); };
    const stay = el("button", { class: "btn btn-primary", type: "button" }, t("close.stay"));
    const quit = el("button", { class: "btn btn-ghost", type: "button" }, t("close.quit"));
    stay.addEventListener("click", () => finish(false));
    quit.addEventListener("click", () => finish(true));
    ovl.append(el("div", { class: "s-modal" }, [
      el("h3", {}, t("close.title")),
      el("p", {}, t("close.body")),
      el("div", { class: "m-acts" }, [stay, quit]),
    ]));
    $("#s-modal-root").replaceChildren(ovl);
    stay.focus({ preventScroll: true });
  });
}

async function requestClose() {
  if (state.uninstalling) { askWait(); return; }
  if (state.installing) {
    const quit = await askQuit();
    if (!quit) return;
    await api.cancelInstall();
  }
  state.closing = true;
  if (live) await api.windowAction("close");
  else toast("info", t("common.browserOnly"), t("common.browserOnlyBody"));
}

/* ── install ── */
function stageNs() {
  return state.mode === "uninstall" ? "uninst" : "inst";
}

function buildInstallStages() {
  const stages = state.mode === "uninstall" ? UNINST : INST;
  const ns = stageNs();
  els.instStages.replaceChildren(...stages.map((s, i) => el("li", { class: "inst-stage", dataset: { id: s.id }, style: { "--si": i } }, [
    el("span", { class: "is-dot" }, [
      el("span", { class: "is-ico", html: ICON_SVG[s.icon] || "" }),
      el("span", { class: "is-ck", html: ICON_SVG.check }),
    ]),
    el("span", { class: "is-txt" }, [
      el("b", { "data-i18n": `${ns}.stage.${s.id}`, "data-label-ns": ns, "data-label-lang": getLang() }, t(`${ns}.stage.${s.id}`)),
      el("em", { "data-i18n": `${ns}.stage.${s.id}Note`, "data-label-ns": ns, "data-label-lang": getLang() }, t(`${ns}.stage.${s.id}Note`)),
      el("span", { class: "is-bar" }, [el("i")]),
    ]),
    el("span", { class: "is-pct" }, "—"),
  ])));
  renderInstallStages();
}

function renderInstallStages() {
  const ns = stageNs();
  const lang = getLang();
  $$(".inst-stage", els.instStages).forEach((li) => {
    const s = state.inst[li.dataset.id];
    if (!s) return;
    li.className = "inst-stage" + (s.phase === "active" ? " is-active" : s.phase === "done" ? " is-done" : s.phase === "error" ? " is-error" : " is-wait");
    const pct = li.querySelector(".is-pct");
    if (pct) pct.textContent = s.phase === "done" ? "100%" : s.phase === "active" ? `${Math.round(s.pct * 100)}%` : s.phase === "error" ? t("inst.error") : "—";
    const bar = li.querySelector(".is-bar i");
    if (bar) bar.style.width = `${s.phase === "done" ? 100 : s.phase === "active" ? Math.round(s.pct * 100) : 0}%`;
    for (const [sel, key] of [["b", ""], ["em", "Note"]]) {
      const node = li.querySelector(`.is-txt ${sel}`);
      if (!node) continue;
      if (node.dataset.labelNs === ns && node.dataset.labelLang === lang) continue;
      node.dataset.labelNs = ns;
      node.dataset.labelLang = lang;
      node.textContent = t(`${ns}.stage.${li.dataset.id}${key}`);
    }
  });
}

function applyProgress(p) {
  const s = state.inst[p.stage];
  if (!s) return;
  if (p.stageP != null) {
    s.pct = clamp(p.stageP, 0, 1);
    if (s.phase === "wait") s.phase = "active";
  }
  renderInstallStages();
  paintRing(p.overall ?? 0, p.stage, p.stageP ?? s.pct);
  if (state.mode !== "uninstall" && p.overall >= 1) setInstState("ok", t("inst.doneBtn"));
}

function queueProgress(p) {
  pendingProgress = p;
  if (progressRaf) return;
  progressRaf = requestAnimationFrame(() => {
    progressRaf = 0;
    const next = pendingProgress;
    pendingProgress = null;
    if (next) applyProgress(next);
  });
}

function resetProgressQueue() {
  pendingProgress = null;
  if (progressRaf) { cancelAnimationFrame(progressRaf); progressRaf = 0; }
}

function paintRing(frac, stageId, stageFrac) {
  const f = clamp(frac, 0, 1);
  const stages = state.mode === "uninstall" ? UNINST : INST;
  const idx = Math.max(0, stages.findIndex((s) => s.id === stageId));
  const sf = clamp(stageFrac != null ? stageFrac : (state.inst[stageId]?.pct ?? 0), 0, 1);
  const arc = els.instArc;
  if (arc) {
    arc.style.strokeDasharray = String(state.arcLen);
    arc.style.strokeDashoffset = String(state.arcLen * (1 - f));
  }
  const arc2 = $("#ir-stage-arc");
  if (arc2) {
    arc2.style.strokeDasharray = String(state.stageArcLen);
    arc2.style.strokeDashoffset = String(state.stageArcLen * (1 - sf));
  }
  if (els.instRot) els.instRot.style.transform = `rotate(${f * 360}deg)`;
  const rot2 = $("#ir-stage-rot");
  if (rot2) rot2.style.transform = `rotate(${sf * 360}deg)`;
  els.instPct.textContent = String(Math.floor(f * 100));
  if (stageId) els.instLabel.textContent = t(`${stageNs()}.stage.${stageId}`);
  const step = $("#inst-step");
  if (step) step.textContent = `${idx + 1} / ${stages.length}`;
  els.instRing.classList.add("is-live");
}

function pulseRing() {
  const ring = els.instRing;
  if (!ring) return;
  ring.classList.remove("is-pulse");
  void ring.offsetWidth;
  ring.classList.add("is-pulse");
  setTimeout(() => ring.classList.remove("is-pulse"), 760);
}

function logLine(level, text) {
  state.logs.push({ level, text });
  if (state.logs.length > 300) state.logs.shift();
  const span = el("span", { class: `l-${level}` }, `${text}\n`);
  els.instLog.append(span);
  while (els.instLog.childElementCount > 300) els.instLog.firstElementChild.remove();
  els.instLog.scrollTop = els.instLog.scrollHeight;
}

async function startInstall() {
  if (state.installing) return;
  if (!toolsReady()) { go(1); toast("error", t("req.needsChoice"), t("req.toolsMissing")); return; }
  if (!state.options.dir) { go(2); return; }
  state.installing = true;
  state.cancelling = false;
  state.cancelled = false;
  state.error = null;
  state.outcome = null;
  state.inst = Object.fromEntries(INST.map((s) => [s.id, { phase: "wait", pct: 0 }]));
  state.logs = [];
  els.instLog.replaceChildren();
  els.instLog.classList.remove("is-done");
  els.instError.hidden = true;
  els.instRing.classList.remove("is-done");
  renderInstallHeader();
  buildInstallStages();
  renderInstallStages();
  resetProgressQueue();
  paintRing(0, "prepare", 0);
  setInstState("running", t("inst.starting"));
  els.instLog.append(el("span", { class: "l-dim" }, `${t("inst.starting")}\n`));
  go(3);
  renderFooter();
  const opts = {
    dir: state.options.dir,
    desktop: state.options.desktop,
    startMenu: state.options.start,
    launch: state.options.launch,
    toolsMode: state.toolsMode,
    ffmpeg: state.manualTools?.ffmpeg?.path || state.pre?.tools?.ffmpeg?.path || null,
    ffprobe: state.manualTools?.ffprobe?.path || state.pre?.tools?.ffprobe?.path || null,
  };
  try {
    const out = await api.startInstall(opts, {
      stage: (p) => {
        const s = state.inst[p.id];
        if (!s) return;
        pendingProgress = null;
        if (!p.done && state.currentStage !== p.id) pulseRing();
        s.phase = p.done ? "done" : "active";
        if (p.done) s.pct = 1;
        state.currentStage = p.id;
        renderInstallStages();
        paintRing(p.done ? (p.index + 1) / p.of : p.index / p.of, p.id, p.done ? 1 : 0);
        setInstState("running", t(`inst.stage.${p.id}`));
        if (p.done) els.instRing.classList.add("is-live");
      },
      progress: (p) => queueProgress(p),
      log: (level, text) => logLine(level || "info", text),
    });
    if (!out?.ok && out?.cancelled) {
      state.installing = false;
      state.cancelling = false;
      state.cancelled = true;
      setInstState("bad", t("inst.cancelled"));
      logLine("warn", t("inst.cancelled"));
      renderFooter();
      return;
    }
    if (!out?.ok) throw new Error(out?.error || "install did not report success");
    const doneMode = state.mode;
    state.outcome = { ...out, mode: doneMode };
    state.installing = false;
    state.cancelling = false;
    state.pre = state.pre || {};
    state.pre.installed = { ok: true, version: out.version || state.pre.setupVersion || "1.0.0", path: out.path };
    state.mode = "repair";
    for (const s of Object.values(state.inst)) { s.phase = "done"; s.pct = 1; }
    renderInstallStages();
    paintRing(1, "finish", 1);
    setInstState("ok", t("inst.doneBtn"));
    els.instRing.classList.remove("is-live");
    els.instRing.classList.add("is-done");
    els.instLog.classList.add("is-done");
    renderFooter();
    await sleep(900);
    go(4);
  } catch (e) {
    state.installing = false;
    state.cancelling = false;
    state.error = e?.message || String(e);
    setInstState("bad", t("inst.error"));
    const et = $("#inst-error-title");
    if (et) et.textContent = t("done.errorTitle");
    els.instError.hidden = false;
    els.instErrorBody.textContent = state.error;
    const active = $(".inst-stage.is-active", els.instStages);
    if (active) state.inst[active.dataset.id].phase = "error";
    renderInstallStages();
    logLine("error", state.error);
    renderFooter();
  }
}

async function cancelInstall() {
  if (!state.installing || state.cancelling) return;
  state.cancelling = true;
  setInstState("running", t("inst.cancelling"));
  renderFooter();
  try {
    const r = await api.cancelInstall();
    if (r && r.ok === false) {
      state.cancelling = false;
      toast("warn", t("inst.cancel"), r.why || "");
      renderFooter();
    }
  } catch (e) { state.cancelling = false; logLine("warn", e?.message || String(e)); renderFooter(); }
}

function setInstState(kind, text) {
  const n = els.instState;
  n.className = "inst-state" + (kind === "ok" ? " is-ok" : "");
  const icon = n.querySelector("i");
  if (icon) icon.className = `ph ${kind === "ok" ? "ph-check-circle" : kind === "bad" ? "ph-warning-octagon" : "ph-circle-notch"}`;
  const span = n.querySelector("span");
  if (span) span.textContent = text;
}

function renderDone() {
  if (!els.actions) return;
  const out = state.outcome;
  const un = state.mode === "uninstall";
  const title = $("#h-done");
  const sub = $("#done-sub");
  const eyebrow = $("#done-eyebrow");
  const update = Boolean(out?.update);
  const doneMode = out?.mode || state.mode;
  let titleKey = "done.title", subKey = "done.sub", eyebrowKey = "done.eyebrow";
  if (un) { titleKey = "done.removedTitle"; subKey = "done.removedSub"; eyebrowKey = "done.removedEyebrow"; }
  else if (doneMode === "repair") { titleKey = "done.repairTitle"; subKey = "done.repairSub"; }
  else if (doneMode === "update" || update) { titleKey = "done.updateTitle"; subKey = "done.updateSub"; }
  if (title) { title.dataset.i18n = titleKey; title.textContent = t(titleKey); }
  if (sub) { sub.dataset.i18n = subKey; sub.textContent = t(subKey); }
  if (eyebrow) { eyebrow.dataset.i18n = eyebrowKey; eyebrow.textContent = t(eyebrowKey); }

  const k1 = $("#done-k1"), k2 = $("#done-k2"), k3 = $("#done-k3"), k4 = $("#done-k4");
  const art = $("#done-art");
  const icon = $("#done-icon");
  if (un) {
    if (k1) { k1.dataset.i18n = "done.removedPath"; k1.textContent = t("done.removedPath"); }
    if (k2) { k2.dataset.i18n = "done.data"; k2.textContent = t("done.data"); }
    if (k3) { k3.dataset.i18n = "done.shortcuts"; k3.textContent = t("done.shortcuts"); }
    if (k4) { k4.dataset.i18n = "done.uninstaller"; k4.textContent = t("done.uninstaller"); }
    $("#done-path").textContent = out?.path || "—";
    $("#done-version").textContent = out?.dataDeleted ? t("done.dataDeleted") : t("done.dataKept");
    $("#done-engine").textContent = t("done.removed");
    $("#done-tools").textContent = t("done.removed");
    art?.classList.add("is-removed");
    if (icon) icon.className = "ph ph-trash";
  } else {
    if (k1) { k1.dataset.i18n = "done.path"; k1.textContent = t("done.path"); }
    if (k2) { k2.dataset.i18n = "done.version"; k2.textContent = t("done.version"); }
    if (k3) { k3.dataset.i18n = "done.engine"; k3.textContent = t("done.engine"); }
    if (k4) { k4.dataset.i18n = "done.tools"; k4.textContent = t("done.tools"); }
    $("#done-path").textContent = out?.path || state.options.dir || "—";
    $("#done-version").textContent = out?.version || state.pre?.setupVersion || "1.0.0";
    $("#done-engine").textContent = out?.engine || "RIFE 4.26";
    $("#done-tools").textContent = out?.tools === "downloaded" ? t("opt.toolsDownload") : t("opt.toolsExisting");
    art?.classList.remove("is-removed");
    if (icon) icon.className = "ph ph-check";
  }

  const open = $("#done-open");
  if (open) {
    const span = open.querySelector("span");
    const ic = open.querySelector("i");
    if (span) span.textContent = un ? t("done.installAgain") : t("done.open");
    if (ic) ic.className = un ? "ph ph-download-simple" : "ph-fill ph-play";
  }
  const folder = $("#done-folder");
  if (folder) folder.hidden = un;
  const credit = $(".done-credit");
  if (credit) credit.hidden = un;
}

async function openFlow() {
  if (state.mode === "uninstall") { await resetAfterUninstall(); return; }
  const target = state.outcome?.exe || state.outcome?.path || state.options.dir;
  const r = await api.openApp(target);
  if (r && r.ok === false) toast("info", t("common.browserOnly"), r.why || t("common.browserOnlyBody"));
}

async function resetAfterUninstall() {
  state.mode = "install";
  state.outcome = null;
  state.error = null;
  state.cancelled = false;
  state.options.dir = "";
  state.lastBurst = 0;
  els.shell.classList.remove("is-uninstalling");
  els.instRing.classList.remove("is-done");
  els.instLog.classList.remove("is-done");
  buildInstallStages();
  await check();
  go(0);
}

/* ── done particle burst ─────────────────────────────────────────────── */
function burstDone(removed) {
  const c = $("#done-fx");
  if (!c) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;
  const host = c.parentElement;
  if (!host) return;
  const rect = host.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = Math.max(1, Math.round(rect.width * dpr));
  c.height = Math.max(1, Math.round(rect.height * dpr));
  c.style.width = `${rect.width}px`;
  c.style.height = `${rect.height}px`;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const palette = removed
    ? ["#FFB057", "#FF5068", "#FFD9A8", "#E01433"]
    : ["#3BE8B0", "#8CF5D6", "#FF5068", "#FFB057", "#FFFFFF"];
  const count = removed ? 30 : 48;
  const parts = Array.from({ length: count }, (_, i) => {
    const a = (Math.PI * 2 * i) / count + Math.random() * 0.4;
    const speed = (removed ? 1.2 : 2.2) + Math.random() * (removed ? 2.2 : 3.4);
    return {
      x: cx, y: cy,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - (removed ? 0.4 : 1.2),
      g: removed ? 0.05 : 0.035,
      life: 0,
      ttl: 55 + Math.random() * 30,
      size: 1 + Math.random() * 2.4,
      color: palette[i % palette.length],
    };
  });
  let frame = 0;
  const tick = () => {
    frame++;
    ctx.clearRect(0, 0, rect.width, rect.height);
    let alive = false;
    for (const p of parts) {
      if (p.life >= p.ttl) continue;
      alive = true;
      p.life++;
      p.vy += p.g;
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.985;
      p.vy *= 0.985;
      const a = 1 - p.life / p.ttl;
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.6 + a * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (alive && frame < 140) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, rect.width, rect.height);
  };
  requestAnimationFrame(tick);
}

/* ── toasts ── */
function toast(kind, title, body = "") {
  const host = $("#s-toasts");
  const node = el("div", { class: "s-toast" + (kind === "ok" ? " is-ok" : "") }, [
    el("i", { class: `ph ${kind === "ok" ? "ph-check-circle" : "ph-warning-octagon"}` }),
    el("div", {}, [el("b", {}, title), body ? el("span", {}, body) : null]),
  ]);
  host.append(node);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => node.remove(), 5200);
}

boot();
