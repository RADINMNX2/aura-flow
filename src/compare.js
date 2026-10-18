// flow. - the compare viewer. Two real files, kept in sync, with a draggable split.
// The scrub bars are measured, not decorative: the app samples the source at N points and
// plots the mean luma change between neighbours, so a spike really is motion.

import { $, el, clamp, round, clockMs, clock, bytes } from "./util.js";
import { assetUrl, live, ipc } from "./ipc.js";
import { log } from "./journal.js";
import { seg } from "./controls.js";
import { t, onLang } from "./i18n.js";
import { rt } from "./state.js";

const BARS = 44;
let mode = "side";
let bound = false;
let va, vb, stage, slab, handle, wave, timeEl, tagA, tagB, revealBtn;
let urls = { a: "", b: "" };
let playing = false;

export function initCompare() {
  va = $("#v-a"); vb = $("#v-b"); stage = $("#cmp-stage"); slab = $("#cmp-slab");
  handle = $("#cmp-handle"); wave = $("#wave"); timeEl = $("#scrub-t");
  tagA = $("#tag-a"); tagB = $("#tag-b"); revealBtn = $("#btn-reveal");

  const applyMode = (v) => {
    mode = v;
    const box = stage?.parentElement;
    if (!box) return;
    box.classList.remove("is-side", "is-a", "is-b");
    if (v !== "split") box.classList.add(`is-${v}`);
  };
  const modes = seg({
    ariaLabel: t("cmp.mode"),
    items: [{ value: "split", label: "Split", labelKey: "cmp.split" }, { value: "side", label: "Side", labelKey: "cmp.side" }, { value: "a", label: "Source", labelKey: "cmp.a" }, { value: "b", label: "Flow", labelKey: "cmp.b" }],
    value: "side",
    onChange: applyMode,
  });
  $("#cmp-mode").replaceChildren(modes);
  applyMode("side");

  // split drag
  const setSplit = (p) => {
    const v = clamp(p, 0, 100);
    stage.style.setProperty("--split", v);
    handle.setAttribute("aria-valuenow", String(Math.round(v)));
  };
  const fromEvent = (e) => {
    const r = stage.getBoundingClientRect();
    setSplit(((e.clientX - r.left) / r.width) * 100);
  };
  handle.addEventListener("pointerdown", (e) => { e.preventDefault(); handle.setPointerCapture(e.pointerId); const mv = (ev) => fromEvent(ev); const up = () => { handle.removeEventListener("pointermove", mv); handle.removeEventListener("pointerup", up); }; handle.addEventListener("pointermove", mv); handle.addEventListener("pointerup", up); });
  handle.addEventListener("keydown", (e) => {
    const cur = Number(handle.getAttribute("aria-valuenow"));
    if (e.key === "ArrowLeft") { e.preventDefault(); setSplit(cur - 4); }
    if (e.key === "ArrowRight") { e.preventDefault(); setSplit(cur + 4); }
  });

  $("#btn-play").addEventListener("click", toggle);

  onLang(() => {
    $("#cmp-mode")?.setAttribute("aria-label", t("cmp.mode"));
    paintPlayLabel();
    const rerender = () => {
      const out = rt("result");
      if (out) {
        tagA.removeAttribute("data-i18n");
        tagB.removeAttribute("data-i18n");
        tagA.textContent = out.sourceFps ? t("cmp.tagSource", { fps: round(out.sourceFps, 2) }) : t("cmp.tagSourcePlain");
        tagB.textContent = out.outFps ? t("cmp.tagFlow", { fps: round(out.outFps, 2) }) : t("cmp.tagFlowPlain");
        renderSide(out);
      }
    };
    rerender();
  });

  if (!bound) {
    bound = true;
    va.addEventListener("timeupdate", paintTime);
    va.addEventListener("loadedmetadata", () => {
      sizeSlab(); sync();
      if (va.duration) { const t = Math.min(va.duration * 0.25, 2.2); va.currentTime = vb.currentTime = t; paintTime(); }
    });
    vb.addEventListener("loadedmetadata", sync);
    addEventListener("resize", () => { sizeSlab(); });
  }
}

function sizeSlab() {
  if (!stage) return;
  slab.style.setProperty("--vw", `${stage.clientWidth}px`);
}
new ResizeObserver(() => sizeSlab()).observe(document.documentElement);

export async function showResult(out) {
  $("#cmp-es")?.hidden === false && ($("#cmp-es").hidden = true);
  stage.hidden = false;
  $(".cmp")?.classList.remove("is-empty");
  revealBtn.hidden = false;
  urls = { a: out.a || out.source || "", b: out.path || out.b || "" };
  const [ua, ub] = [await assetUrl(urls.a), await assetUrl(urls.b)];
  va.src = ua; vb.src = ub;
  va.load(); vb.load();
  tagA.removeAttribute("data-i18n");
  tagB.removeAttribute("data-i18n");
  tagA.textContent = out.sourceFps ? t("cmp.tagSource", { fps: round(out.sourceFps, 2) }) : t("cmp.tagSourcePlain");
  tagB.textContent = out.outFps ? t("cmp.tagFlow", { fps: round(out.outFps, 2) }) : t("cmp.tagFlowPlain");
  renderSide(out);
  sizeSlab();
  // A neutral track is painted first so the playhead always has something to sit on;
  // the measured scan replaces it as soon as the sampling finishes.
  paintWave(Array(BARS - 1).fill(0.12));
  scanEnergy(ua).then(paintWave).catch(() => paintWave(Array(BARS - 1).fill(0.34)));
  log(`compare ready: ${out.name || out.path}`, "ok");
}

function renderSide(out) {
  const side = $("#cmp-side");
  if (!side) return;
  side.hidden = false;
  const row = (k, key, v) => el("div", { class: "side-row" }, [el("b", { "data-i18n": key }, k), el("span", {}, String(v))]);
  side.replaceChildren(
    el("div", { class: "side-k", "data-i18n": "cmp.output" }, t("cmp.output")),
    el("div", { class: "side-file", title: out.name || out.path }, out.name || out.path),
    el("div", { class: "side-rows" }, [
      row(t("cmp.frames"), "cmp.frames", out.frames?.toLocaleString?.("en-US") || "-"),
      row(t("cmp.fps"), "cmp.fps", out.outFps ? round(out.outFps, 2) : "-"),
      row(t("cmp.size"), "cmp.size", out.bytes ? bytes(out.bytes) : "-"),
      row(t("cmp.length"), "cmp.length", out.seconds ? clock(out.seconds) : "-"),
      row(t("cmp.codec"), "cmp.codec", (out.codec || "-") + (out.crf ? ` · crf ${out.crf}` : "")),
    ]),
    el("button", { class: "btn btn-sm btn-secondary", type: "button", onclick: () => ipc.reveal(out.path) }, [el("i", { class: "ph ph-folder-open" }), el("span", { "data-i18n": "cmp.showFolder" }, t("cmp.showFolder"))]),
  );
}

function paintWave(energy) {
  wave.replaceChildren(...energy.map((a) => el("i", { style: { "--a": clamp(a, 0.06, 1) } })));
  wave.onclick = (e) => {
    const r = wave.getBoundingClientRect();
    const p = (e.clientX - r.left) / r.width;
    seek(p);
  };
}

function seek(p) {
  const d = va.duration || 0;
  va.currentTime = vb.currentTime = d * clamp(p, 0, 0.999);
  paintTime();
}

function toggle() {
  if (!va.src) return;
  playing = !playing;
  const icon = $("#btn-play i");
  icon.className = `ph-fill ph-${playing ? "pause" : "play"}`;
  paintPlayLabel();
  playing ? (va.play(), vb.play()) : (va.pause(), vb.pause());
}

function paintPlayLabel() {
  const btn = $("#btn-play");
  if (!btn) return;
  const key = playing ? "cmp.pause" : "cmp.play";
  btn.setAttribute("aria-label", t(key));
  btn.dataset.i18nAria = key;
}

function sync() {
  // The two files differ in frame rate but not in duration; drift is corrected on every tick.
  if (Math.abs(va.currentTime - vb.currentTime) > 0.06) vb.currentTime = va.currentTime;
}

function paintTime() {
  if (!timeEl || !va.duration) return;
  timeEl.textContent = `${clockMs(va.currentTime)} / ${clockMs(va.duration)}`;
  const p = va.currentTime / va.duration;
  wave.style.setProperty("--t", p * 100);
  [...wave.children].forEach((b, i) => b.classList.toggle("is-past", i / wave.children.length <= p));
  if (playing) sync();
}

// Sample the clip at BARS points and measure the mean luma step between neighbours.
async function scanEnergy(url) {
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
  v.src = url;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error("no scan")); setTimeout(rej, 6000); });
  const c = document.createElement("canvas");
  c.width = 48; c.height = 27;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const out = [];
  let prev = null;
  for (let i = 0; i < BARS; i++) {
    const t = (v.duration || 1) * (i / BARS) + 0.02;
    await new Promise((res) => { v.onseeked = res; v.currentTime = Math.min(t, v.duration - 0.04); });
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let p = 0; p < d.length; p += 4) sum += 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    const mean = sum / (d.length / 4);
    if (prev !== null) out.push(Math.abs(mean - prev) / 26);
    prev = mean;
  }
  v.src = "";
  const max = Math.max(0.08, ...out);
  log(`motion scan: ${out.length} samples, peak ${round(max * 100, 0)}`, "info");
  return out.map((x) => clamp(x / max, 0.06, 1));
}
