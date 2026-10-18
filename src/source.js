// flow. - step 1: the drop hero, the file picker and the probe card.
// The thumbnail is a real frame from the file, never a placeholder.

import { $, el, bytes, round, clock } from "./util.js";
import { ipc, live, assetUrl } from "./ipc.js";
import { get } from "./state.js";
import { log } from "./journal.js";
import { toast } from "./toasts.js";
import { setStepMeta, unlock } from "./wizard.js";
import { t, onLang } from "./i18n.js";

const OK_EXT = /\.(mp4|mkv|mov|webm|avi|m4v|mpg|mpeg|flv|ts)$/i;
let onSource = null;
let last = null;

export function initSource({ onSource: cb }) {
  onSource = cb;
  const dz = $("#dz");
  const card = $("#src-card");
  const input = $("#file-input");

  async function take(pathOrFile, name) {
    if (dz.classList.contains("is-loading")) return;
    try {
      dz.classList.add("is-loading");
      const probe = await ipc.probe(pathOrFile);
      const source = { name: probe.name || name || String(pathOrFile?.name || pathOrFile), path: probe.path || probe.name || name, probe };
      render(source);
      onSource?.(source);
      // Let the confirmation burst land before the hero is swapped for the card.
      dz.classList.add("is-taken");
      await new Promise((r) => setTimeout(r, 360));
      dz.classList.remove("is-loading", "is-taken");
      dz.hidden = true;
      card.hidden = false;
      card.classList.remove("is-in");
      void card.offsetWidth;
      card.classList.add("is-in");
      log(`probed ${source.name} - ${probe.width}x${probe.height}, ${probe.duration ? clock(probe.duration) : "-"}, ${probe.fps ? `${round(probe.fps, 3)} fps` : "fps unknown to the mock core"}`, "ok");
      return source;
    } catch (e) {
      dz.classList.remove("is-loading");
      dz.classList.add("is-bad");
      setTimeout(() => dz.classList.remove("is-bad"), 700);
      log(`probe failed: ${e.message}`, "error");
      toast({ kind: "error", title: t("src.readFail"), body: e.message });
      return null;
    }
  }

  function render(source) {
    const p = source.probe;
    last = source;
    card.replaceChildren(node(source));
    card.classList.remove("is-in");
    void card.offsetWidth;
    card.classList.add("is-in");
    $("#to-recipe").disabled = false;
    const hint = $("#src-hint");
    if (hint) hint.textContent = [
      p.frames ? `${p.frames.toLocaleString("en-US")} ${t("src.hintFrames")}` : "",
      p.fps ? `${round(p.fps, 3)} fps` : "",
      p.duration ? clock(p.duration) : "",
    ].filter(Boolean).join(" · ");
    setStepMeta(0, source.name);
    unlock(1); unlock(2);
  }

  function clear() {
    last = null;
    card.hidden = true;
    card.classList.remove("is-in");
    card.replaceChildren();
    dz.hidden = false;
    dz.classList.remove("is-loading", "is-taken", "is-bad", "is-over");
    $("#to-recipe").disabled = true;
    $("#btn-run").disabled = true;
    $("#src-badge").hidden = true;
    const hint = $("#src-hint");
    if (hint) hint.textContent = t("src.wait");
    setStepMeta(0, t("meta.pick"));
    onSource?.(null);
  }

  async function openPicker() {
    if (!live) { input.click(); return; }
    try {
      const picked = await ipc.pick();
      if (!picked) return;
      await take(picked.path, picked.name);
    } catch (e) {
      toast({ kind: "error", title: t("src.readFail"), body: e.message || String(e) });
    }
  }

  async function openPath(path) {
    if (!path) return null;
    const name = String(path).split(/[\\/]/).pop();
    return take(path, name);
  }

  dz.addEventListener("click", (e) => { if (!e.target.closest("button")) openPicker(); });
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); } });
  $("#btn-open").addEventListener("click", (e) => { e.stopPropagation(); openPicker(); });

  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    if (f) await take(f, f.name);
    input.value = "";
  });

  let depth = 0;
  document.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    depth++;
    dz.classList.add("is-over");
  });
  document.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dz.classList.add("is-over");
  });
  document.addEventListener("dragleave", (e) => { e.preventDefault(); if (--depth <= 0) { depth = 0; dz.classList.remove("is-over", "is-bad"); } });
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    dz.classList.remove("is-over");
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (!/^video\//.test(f.type) && !OK_EXT.test(f.name)) {
      dz.classList.add("is-bad");
      setTimeout(() => dz.classList.remove("is-bad"), 900);
      return toast({ kind: "warn", title: t("src.notVideo"), body: f.name });
    }
    await take(f, f.name);
  });

  onLang(() => {
    const hint = $("#src-hint");
    if (!hint) return;
    if (!last) { hint.textContent = t("src.wait"); return; }
    const p = last.probe;
    const streams = document.querySelector("[data-src-streams]");
    if (streams) streams.textContent = streamsText(p);
    hint.textContent = [
      p.frames ? `${p.frames.toLocaleString("en-US")} ${t("src.hintFrames")}` : "",
      p.fps ? `${round(p.fps, 3)} fps` : "",
      p.duration ? clock(p.duration) : "",
    ].filter(Boolean).join(" · ");
  });
  addEventListener("flow:plan", (e) => paintForecast(e.detail));

  function node(source) {
    const p = source.probe;
    const thumb = el("div", { class: "src-thumb" }, el("i", { class: "ld-breathe" }));
    grab(source).then((url) => thumb.replaceChildren(el("img", { src: url, alt: "", width: 420, height: 236 })))
      .catch(() => thumb.replaceChildren(el("i", { class: "ph ph-image", style: { display: "grid", placeItems: "center", height: "100%", fontSize: "22px", color: "var(--ink-3)" } })));

    const facts = el("div", { class: "facts" }, [
      fact(t("src.factResolution"), "src.factResolution", p.width ? `${p.width}×${p.height}` : "-"),
      fact(t("src.factDuration"), "src.factDuration", p.duration ? clock(p.duration) : "-"),
      fact(t("src.factFps"), "src.factFps", p.fps ? `${round(p.fps, 2)}` : "-"),
      fact(t("src.factFrames"), "src.factFrames", p.frames ? p.frames.toLocaleString("en-US") : "-"),
      fact(t("src.factSize"), "src.factSize", (p.size ?? p.bytes) ? bytes(p.size ?? p.bytes) : "-"),
      el("div", { class: "fact" }, [
        el("b", { "data-i18n": "src.factStreams" }, t("src.factStreams")),
        el("span", { "data-src-streams": "" }, streamsText(p)),
      ]),
    ]);

    const film = el("div", { class: "film", "aria-hidden": "true" });
    const filmCells = Array.from({ length: 7 }, () => el("span", { class: "film-cell" }, el("i", { class: "film-load" })));
    film.append(el("div", { class: "film-cells" }, filmCells), el("div", { class: "film-rail" }, [
      el("span", { class: "film-t" }, "00:00"),
      el("span", { class: "film-mark" }, [el("i"), el("em", { "data-i18n": "src.filmNote" }, t("src.filmNote"))]),
      el("span", { class: "film-t" }, p.duration ? clock(p.duration) : "-:--"),
    ]));
    grabFrames(source, 7).then((frames) => {
      frames.forEach((url, i) => { if (url && filmCells[i]) filmCells[i].replaceChildren(el("img", { src: url, alt: "" })); });
    }).catch(() => { filmCells.forEach((c) => c.replaceChildren(el("i", { class: "ph ph-film-strip" }))); });

    const forecast = el("div", { class: "forecast", id: "src-forecast" }, [
      el("div", { class: "fc-k" }, [el("i", { class: "ph ph-chart-line-up" }), el("span", { "data-i18n": "src.forecast" }, t("src.forecast"))]),
      el("div", { class: "fc-grid" }, [
        fcItem("src.fcFrames", "-", "fc-frames"),
        fcItem("src.fcRate", "-", "fc-rate"),
        fcItem("src.fcEst", "-", "fc-est"),
        fcItem("src.fcFactor", "-", "fc-factor"),
      ]),
    ]);

    return el("div", { class: "src-wrap", "data-ctx": "source" }, [
      el("div", { class: "src" }, [
        thumb,
        el("div", { class: "src-main" }, [
          el("div", { class: "src-name", title: source.name }, source.name),
          el("div", { class: "src-path", title: source.path }, source.path),
          facts,
          el("div", { class: "src-acts" }, [
            el("button", { class: "btn btn-sm btn-secondary", type: "button", "data-tip": t("src.replaceTip"), "data-i18n-tip": "src.replaceTip", onclick: () => openPicker() }, [el("i", { class: "ph ph-swap" }), el("span", { "data-i18n": "src.replace" }, t("src.replace"))]),
            el("button", { class: "btn btn-sm btn-ghost", type: "button", "data-tip": t("src.clearTip"), "data-i18n-tip": "src.clearTip", onclick: () => { clear(); toast({ kind: "info", title: t("src.cleared") }); } }, [el("i", { class: "ph ph-x" }), el("span", { "data-i18n": "src.clear" }, t("src.clear"))]),
            live ? el("button", { class: "btn btn-sm btn-ghost", type: "button", "data-tip": t("src.revealTip"), "data-i18n-tip": "src.revealTip", onclick: () => ipc.reveal(source.path) }, [el("i", { class: "ph ph-folder-simple" }), el("span", { "data-i18n": "src.reveal" }, t("src.reveal"))]) : null,
          ]),
        ]),
      ]),
      film,
      forecast,
    ]);
  }

  return { take, clear, openPicker, openPath, refresh: () => last && render(last) };
}

function fact(k, key, v) { return el("div", { class: "fact" }, [el("b", { "data-i18n": key }, k), el("span", {}, String(v))]); }

function streamsText(p) {
  return `${p.hasAudio ? t("src.stack") : t("src.videoOnly")}${p.hasSubs ? ` + ${t("src.subs")}` : ""}`;
}

function fcItem(key, value, cls) {
  return el("div", { class: "fc-item" }, [el("em", { "data-i18n": key }, t(key)), el("b", { class: cls }, value)]);
}

function paintForecast(p) {
  const box = $("#src-forecast");
  if (!box) return;
  const set = (cls, v) => { const n = box.querySelector("." + cls); if (n) n.textContent = v; };
  if (!p) { ["fc-frames", "fc-rate", "fc-est", "fc-factor"].forEach((c) => set(c, "-")); return; }
  set("fc-frames", p.outFrames?.toLocaleString("en-US") ?? "-");
  set("fc-rate", `${round(p.outFps, 2)} fps`);
  set("fc-est", clock(p.estSeconds));
  set("fc-factor", `${get("factor")}×`);
}

async function videoUrl(source) {
  if (source.probe?._file) return URL.createObjectURL(source.probe._file);
  return assetUrl(source.path || source.probe?.path);
}

async function grab(source) {
  try {
    const t = await ipc.thumb?.(source.path);
    if (t) return t;
  } catch { /* mock core */ }
  const src = await videoUrl(source);
  if (!src) throw new Error("no thumb source");
  return frameFromVideo(src);
}

function frameFromVideo(src) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "metadata"; v.crossOrigin = "anonymous";
    v.onloadeddata = () => { v.currentTime = Math.max(0.05, (v.duration || 1) * 0.25); };
    v.onseeked = () => {
      const c = document.createElement("canvas");
      c.width = 528; c.height = Math.max(1, Math.round(528 * (v.videoHeight / v.videoWidth || 0.56)));
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      try { resolve(c.toDataURL("image/jpeg", 0.74)); } catch (e) { reject(e); }
    };
    v.onerror = () => reject(new Error("frame grab failed"));
    v.src = src;
  });
}

// Seven real frames, sampled from the clip itself. This is what the editor will read, so the
// strip is honest rather than a decorative gradient.
async function grabFrames(source, count = 7) {
  const src = await videoUrl(source);
  if (!src) throw new Error("no strip source");
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
  v.src = src;
  await new Promise((res, rej) => {
    v.onloadeddata = res;
    v.onerror = () => rej(new Error("strip load failed"));
    setTimeout(rej, 8000);
  });
  const c = document.createElement("canvas");
  c.width = 240; c.height = Math.max(1, Math.round(240 * (v.videoHeight / v.videoWidth || 0.56)));
  const ctx = c.getContext("2d");
  const out = [];
  const dur = v.duration || 1;
  for (let i = 0; i < count; i++) {
    const t = Math.min(dur - 0.04, dur * (0.06 + (i / count) * 0.88));
    await new Promise((res) => { v.onseeked = res; v.currentTime = Math.max(0, t); });
    ctx.drawImage(v, 0, 0, c.width, c.height);
    try { out.push(c.toDataURL("image/jpeg", 0.7)); } catch { out.push(""); }
  }
  v.src = "";
  return out;
}
