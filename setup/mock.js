// flow. setup - browser harness. Honest mock: the UI is real, the machine answers are sample data,
// and every install step is simulated on a timer. The Tauri shell replaces this one-for-one.

const q = new URLSearchParams(location.search);
const missing = q.has("missing");
const repairMode = q.has("repair");
const installed = q.has("installed") || repairMode;
const slow = q.has("slow") ? 4 : 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cancelled = false;

const FOLDERS = {
  default: "C:\\Users\\RADIN\\AppData\\Local\\Programs\\flow",
  alt: "C:\\Users\\RADIN\\Videos\\flow",
  tools: "C:\\Users\\RADIN\\bin",
};

export const mock = {
  async preflight() {
    await sleep(450);
    return {
      setupVersion: "1.0.0",
      os: { name: "Windows 11 Pro", version: "23H2", build: "22631.4317", arch: "x64", locale: "fa-IR" },
      webview2: { ok: true, version: "131.0.2903.86" },
      gpu: { ok: true, name: "NVIDIA GeForce GTX 1070", memoryMb: 8192, driver: "581.15", vulkan: true },
      engine: { ok: true, name: "RIFE 4.26", sizeMb: 17.7, bundled: true },
      tools: missing
        ? { ok: false, source: "none", ffmpeg: null, ffprobe: null }
        : {
            ok: true,
            source: "detected",
            ffmpeg: { path: FOLDERS.tools + "\\ffmpeg.exe", version: "7.1" },
            ffprobe: { path: "C:\\Users\\RADIN\\AppData\\Local\\Flowframes\\FlowframesData\\pkgs\\av\\ffprobe.exe", version: "4.4.1" },
          },
      disk: { freeGb: 128.4, root: "C:\\" },
      installDir: FOLDERS.default,
      installed: installed ? { ok: true, version: repairMode ? "1.0.0" : "0.9.4", path: FOLDERS.default } : null,
      dataMb: 49.3,
      sizes: { appMb: 5.5, engineMb: 17.7, downloadMb: 115 },
    };
  },

  async pickFolder(current) {
    await sleep(150);
    return current === FOLDERS.alt ? FOLDERS.default : FOLDERS.alt;
  },

  async pickTools() {
    await sleep(200);
    return {
      ffmpeg: { path: FOLDERS.tools + "\\ffmpeg.exe", version: "7.1" },
      ffprobe: { path: "C:\\Users\\RADIN\\AppData\\Local\\Flowframes\\FlowframesData\\pkgs\\av\\ffprobe.exe", version: "4.4.1" },
    };
  },

  async validateTools(ffmpeg, ffprobe) {
    await sleep(500);
    const bad = !ffmpeg || !ffprobe || /nope|invalid|fake/i.test(ffmpeg + ffprobe);
    return bad
      ? { ok: false, error: "ffprobe did not answer with a version; pick a matching ffmpeg + ffprobe pair." }
      : { ok: true, ffmpeg: { path: ffmpeg, version: "7.1" }, ffprobe: { path: ffprobe, version: "4.4.1" } };
  },

  async startInstall(options, handlers) {
    cancelled = false;
    const stages = ["prepare", "app", "engine", "tools", "finish"];
    const durations = [700, 1500, 1400, options.toolsMode === "download" ? 2600 : 700, 700].map((d) => d * slow);
    handlers.log("info", "flow setup 1.0.0 - browser harness");
    handlers.log("info", `target ${options.dir}`);
    for (let i = 0; i < stages.length; i++) {
      if (cancelled) return { ok: false, cancelled: true };
      const id = stages[i];
      handlers.stage({ id, index: i, of: stages.length, done: false });
      handlers.log("info", `${id} started`);
      const t0 = performance.now();
      let loggedWeights = false, loggedTools = false;
      while (performance.now() - t0 < durations[i]) {
        if (cancelled) return { ok: false, cancelled: true };
        const p = Math.min(1, (performance.now() - t0) / durations[i]);
        handlers.progress({ stage: id, stageP: p, overall: (i + p) / stages.length, rate: 0, eta: null });
        if (i === 2 && !loggedWeights && p > 0.35) { loggedWeights = true; handlers.log("info", "rife-v4.26 - 10.9 MB weights"); }
        if (i === 3 && !loggedTools && p > 0.5) {
          loggedTools = true;
          handlers.log("info", options.toolsMode === "download" ? "downloading ffmpeg-release-essentials.zip" : "writing toolchain.json");
        }
        await sleep(70);
      }
      handlers.stage({ id, index: i, of: stages.length, done: true });
      handlers.log("ok", `${id} done`);
    }
    const out = {
      ok: true,
      path: options.dir,
      exe: options.dir + "\\flow-studio.exe",
      version: "1.0.0",
      engine: "RIFE 4.26",
      tools: options.toolsMode === "download" ? "downloaded" : "existing",
      update: !!installed,
    };
    handlers.log("ok", `installed ${out.exe}`);
    return out;
  },

  async cancelInstall() {
    cancelled = true;
    return { ok: true };
  },

  async startUninstall(removeData, handlers) {
    const stages = ["stop", "app", "data", "finish"];
    const durations = [600, 1800, removeData ? 1500 : 700, 700].map((d) => d * slow);
    handlers.log("info", "flow setup 1.0.0 - removal harness");
    handlers.log("info", `closing ${FOLDERS.default}\\flow-studio.exe`);
    for (let i = 0; i < stages.length; i++) {
      const id = stages[i];
      handlers.stage({ id, index: i, of: stages.length, done: false });
      handlers.log("info", `${id} started`);
      const t0 = performance.now();
      while (performance.now() - t0 < durations[i]) {
        const p = Math.min(1, (performance.now() - t0) / durations[i]);
        handlers.progress({ stage: id, stageP: p, overall: (i + p) / stages.length });
        await sleep(70);
      }
      handlers.stage({ id, index: i, of: stages.length, done: true });
      handlers.log("ok", `${id} done`);
    }
    handlers.log("ok", removeData ? "local data deleted" : "engine and tools kept");
    return {
      ok: true,
      path: FOLDERS.default,
      dataDeleted: Boolean(removeData),
      dataKept: !removeData,
      dataMb: 49.3,
    };
  },

  async openApp() { return { ok: false, why: "browser harness" }; },
  async showPath() { return { ok: false, why: "browser harness" }; },
  async windowAction() { return { ok: false, why: "browser harness" }; },
  async onCloseRequested() { return () => {}; },
};
