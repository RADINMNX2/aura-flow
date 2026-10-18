// flow. - the browser harness. It exists so the UI can be built and looked at before the
// Rust core is wired, and it never pretends to be the core: the chrome pill reads "core: mock"
// and the run panel carries a mock badge.
//
// What is REAL here: duration, width and height are read from the dropped file through a
// <video> element; the two dev clips are genuinely rendered 15fps / 60fps files; the throughput
// constant below is a measured number (37.7 interpolated frames/sec at 544x306 with rife-v4.26
// on this machine's GTX 1070), not a guess.
// What is NOT real: process spawning, actual frame I/O, and live GPU counters.

import { clamp, sleep } from "./util.js";

const listeners = new Map();
function fire(event, payload) {
  for (const cb of listeners.get(event) || []) cb(payload);
}

const MEASURED_FPS_AT_300K = 37.7; // interp frames/sec, 544x306, rife-v4.26, GTX 1070
const PIXEL_REF = 544 * 306;

// Fixtures with numbers taken from a real ffprobe run.
const FIXTURES = {
  "GG-src.mp4": { path: "dev/GG-src.mp4", name: "GG.mp4", width: 544, height: 306, fps: 15, frames: 81, duration: 5.4, bytes: 378697, out: "dev/GG-4x.mp4" },
  "GG-4x.mp4": { path: "dev/GG-4x.mp4", name: "GG-4x.mp4", width: 544, height: 306, fps: 60, frames: 324, duration: 5.4, bytes: 926742 },
};

function videoMeta(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => {
      const meta = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
      URL.revokeObjectURL(url);
      v.src = "";
      resolve(meta);
    };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error("the browser could not read this file")); };
    v.src = url;
  });
}

export const mock = {
  listen(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => listeners.get(event).delete(cb);
  },

  async pick_video() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*,.mkv,.mov,.webm";
    const file = await new Promise((res) => { input.onchange = () => res(input.files?.[0] || null); input.click(); });
    if (!file) return null;
    return { path: file.name, name: file.name, size: file.size, _file: file };
  },

  async pick_dir() { return null; },
  async reveal_path() { return { ok: false, why: "mock core cannot touch the filesystem" }; },

  async probe({ path }) {
    const label = typeof path === "string" ? path : path?.name || "";
    const fx = Object.values(FIXTURES).find((f) => f.name === label || f.path === label || label.endsWith(f.name));
    if (fx) return { ...fx, source: "fixture" };

    const file = path?._file || path;
    if (file instanceof File) {
      const meta = await videoMeta(file);
      // The browser cannot tell us the source frame rate, so it is left null and the
      // recipe shows an explicit "set fps" field instead of inventing a number.
      return { name: file.name, path: file.name, size: file.size, width: meta.width, height: meta.height, duration: meta.duration, fps: null, frames: null, hasAudio: true, hasSubs: false, source: "browser" };
    }
    throw new Error("mock probe: unknown input");
  },

  async scan_engines() {
    const res = await fetch("src/engines.json");
    return await res.json();
  },

  async plan({ job }) {
    const src = job.source?.probe || {};
    const fps = job.fps ?? src.fps ?? 25;
    const frames = src.frames ?? Math.round((src.duration || 0) * fps);
    const outFrames = Math.round(frames * job.factor);
    const px = (src.width || 544) * (src.height || 306);
    const rate = MEASURED_FPS_AT_300K * (PIXEL_REF / px) * (job.engine === "rife-ncnn" ? 1 : 0.45);
    return {
      inFps: fps, outFps: fps * job.factor, inFrames: frames, outFrames,
      estSeconds: outFrames / Math.max(1, rate), rate: Math.max(1, rate),
      tempGb: +(frames * 0.26 + outFrames * 0.26).toFixed(1) / 1024,
    };
  },

  async gpu_sample() {
    return { util: 0, vramMb: 1180, vramTotalMb: 8192, tempC: 44 };
  },

  async cancel_job() {
    mock._cancel = true;
    return { ok: true };
  },

  async start_job({ job }) {
    mock._cancel = false;
    const started = performance.now();
    const plan = await mock.plan({ job });
    const src = job.source.probe;
    const stages = [
      { id: "probe", ms: 120, lines: [`probe ${src.name} - ${src.width}x${src.height} ${src.fps ?? "?"}fps ${plan.inFrames} frames`] },
      { id: "extract", ms: Math.max(240, plan.inFrames * 14), lines: [`ffmpeg -i "${src.path}" frames/%08d.png`, `extracted ${plan.inFrames} frames`] },
      { id: "interp", ms: Math.max(600, plan.estSeconds * 1000 * 0.62), lines: [`rife-ncnn-vulkan -m ${job.model} -n ${plan.outFrames} -g ${job.gpu}`, "loading model weights"] },
      { id: "encode", ms: Math.max(400, plan.outFrames * 9), lines: [`ffmpeg -framerate ${plan.outFps.toFixed(2)} -i interp/%08d.png -c:v ${job.codec} -crf ${job.crf} -preset ${job.preset}`] },
      { id: "mux", ms: 260, lines: [job.keepAudio ? "copied audio + metadata" : "audio dropped by request", "wrote output"] },
    ];

    let overallDone = 0;
    const totalMs = stages.reduce((a, s) => a + s.ms, 0);

    for (let i = 0; i < stages.length; i++) {
      const st = stages[i];
      if (mock._cancel) break;
      fire("flow://stage", { id: st.id, index: i, of: stages.length });
      for (const line of st.lines) fire("flow://log", { level: "info", text: line });

      const t0 = performance.now();
      let last = 0;
      while (performance.now() - t0 < st.ms) {
        await sleep(90);
        const inStage = clamp((performance.now() - t0) / st.ms, 0, 1);
        const done = overallDone + st.ms * inStage;
        const frac = clamp(done / totalMs, 0, 1);
        const elapsed = (performance.now() - started) / 1000;
        const framesDone = st.id === "interp" ? Math.round(plan.outFrames * inStage) : (st.id === "extract" ? Math.round(plan.inFrames * inStage) : plan.outFrames * frac);
        fire("flow://progress", {
          stage: st.id, stageP: inStage, overall: frac,
          done: framesDone, total: plan.outFrames,
          rate: st.id === "interp" ? plan.rate * (0.86 + 0.14 * Math.sin(inStage * 7)) : 0,
          eta: (totalMs - done) / 1000,
          gpu: { util: st.id === "interp" ? 62 + 26 * inStage : st.id === "encode" ? 34 : 12, vramMb: 1180 + (st.id === "interp" ? 1450 : 220), vramTotalMb: 8192, tempC: 44 + (st.id === "interp" ? 21 : 6) * inStage },
        });
        last = inStage;
        if (mock._cancel) break;
      }
      if (mock._cancel) break;
      overallDone += st.ms;
      fire("flow://stage", { id: st.id, index: i, of: stages.length, done: true, last });
    }

    const ms = performance.now() - started;
    if (mock._cancel) {
      fire("flow://log", { level: "warn", text: "cancelled by user" });
      return { ok: false, cancelled: true, ms };
    }
    const out = {
      path: src.out || "dev/GG-4x.mp4",
      name: `${(src.name || "clip").replace(/\.[^.]+$/, "")}-${job.factor}x-${job.model}-${plan.outFps.toFixed(0)}fps.mp4`,
      outFps: plan.outFps, frames: plan.outFrames, seconds: src.duration, ms,
      bytes: Math.round((src.bytes || 380000) * 2.4), codec: job.codec, crf: job.crf,
      a: src.path || "dev/GG-src.mp4", b: src.out || "dev/GG-4x.mp4",
    };
    fire("flow://done", out);
    return { ok: true, out };
  },
};
