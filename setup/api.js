// flow. setup - one bridge, two backends. The Tauri shell and the browser harness answer
// exactly the same surface so the wizard can be designed and tested in a tab.

import { mock } from "./mock.js";

const g = typeof window !== "undefined" ? window.__TAURI__ : null;
export const live = Boolean(window.__TAURI_INTERNALS__ || g?.core?.invoke);

async function invoke(cmd, args = {}) {
  const fn = g?.core?.invoke || (await import("@tauri-apps/api/core")).invoke;
  return fn(cmd, args);
}

async function listen(event, cb) {
  const fn = g?.event?.listen || (await import("@tauri-apps/api/event")).listen;
  return fn(event, (e) => cb(e.payload));
}

const currentWindow = () => g?.window?.getCurrentWindow?.() || null;

export const api = {
  async preflight() {
    return live ? invoke("preflight") : mock.preflight();
  },
  async pickFolder(current) {
    return live ? invoke("pick_folder", { current }) : mock.pickFolder(current);
  },
  async pickTools() {
    return live ? invoke("pick_tools") : mock.pickTools();
  },
  async validateTools(ffmpeg, ffprobe) {
    return live ? invoke("validate_tools", { ffmpeg, ffprobe }) : mock.validateTools(ffmpeg, ffprobe);
  },
  async startInstall(options, handlers) {
    if (!live) return mock.startInstall(options, handlers);
    const offs = [];
    offs.push(await listen("setup://stage", (p) => handlers.stage(p)));
    offs.push(await listen("setup://progress", (p) => handlers.progress(p)));
    offs.push(await listen("setup://log", (p) => handlers.log(p.level, p.text)));
    try {
      return await invoke("start_install", { options });
    } finally {
      offs.forEach((off) => { try { off?.(); } catch {} });
    }
  },
  async cancelInstall() {
    return live ? invoke("cancel_install") : mock.cancelInstall();
  },
  async startUninstall(removeData, handlers) {
    if (!live) return mock.startUninstall(removeData, handlers);
    const offs = [];
    offs.push(await listen("setup://stage", (p) => handlers.stage(p)));
    offs.push(await listen("setup://progress", (p) => handlers.progress(p)));
    offs.push(await listen("setup://log", (p) => handlers.log(p.level, p.text)));
    try {
      return await invoke("start_uninstall", { removeData });
    } finally {
      offs.forEach((off) => { try { off?.(); } catch {} });
    }
  },
  async openApp(path) {
    return live ? invoke("open_app", { path }) : mock.openApp(path);
  },
  async showPath(path) {
    return live ? invoke("reveal_path", { path }) : mock.showPath(path);
  },
  async windowAction(action) {
    if (!live) return mock.windowAction(action);
    const w = currentWindow();
    if (action === "minimize") return w?.minimize();
    if (action === "close") return w?.close();
    return { ok: true };
  },
  async onCloseRequested(handler) {
    if (!live) return mock.onCloseRequested();
    const w = currentWindow();
    if (!w?.onCloseRequested) return () => {};
    return w.onCloseRequested(async (event) => {
      const allow = await handler();
      if (!allow) event.preventDefault();
    });
  },
};
