// Live end-to-end smoke test against the Tauri WebView (WebView2 remote debugging).
// Launch the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
// then: node tools/live-smoke.mjs
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.FLOW_CDP_PORT || 9223;
const OUT_DIR = path.resolve("dev/live-test");
const SHOT = path.resolve("dev/shots/tauri-live-render.png");
fs.mkdirSync(OUT_DIR, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === "page" && /127\.0\.0\.1:4211|tauri/.test(t.url)) || targets.find((t) => t.type === "page");
if (!page) throw new Error("no WebView2 page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails?.text || "exception");
};

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

async function ev(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval failed");
  return r.result.value;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });

// wait for the app to expose its debug surface
for (let i = 0; i < 80; i++) {
  const ready = await ev("!!window.flow && !!window.flow.ipc").catch(() => false);
  if (ready) break;
  await new Promise((r) => setTimeout(r, 250));
}

const boot = await ev(`(async () => ({
  live: window.flow?.live,
  core: document.querySelector('#core-txt')?.textContent,
  lang: document.documentElement.lang,
  engines: (await window.flow.ipc.scan()).engines.map(e => ({ id: e.id, models: e.models.map(m => m.dir) }))
}))()`);
console.log("boot:", JSON.stringify(boot));

const src = path.resolve("dev/GG-src.mp4");
const source = await ev(`(async () => {
  window.flow.setLang('en');
  const s = await window.flow.source().openPath(${JSON.stringify(src)});
  await new Promise(r => setTimeout(r, 1200));
  return {
    ok: !!s,
    name: window.flow.rt('source')?.name,
    probe: window.flow.rt('source')?.probe,
    card: document.querySelector('.src-name')?.textContent,
    strip: document.querySelectorAll('.film-cell img').length,
    facts: [...document.querySelectorAll('.fact')].map(n => n.innerText)
  };
})()`);
console.log("source:", JSON.stringify(source));

const plan = await ev(`(async () => {
  window.flow.recipe.setFactor(4);
  window.flow.set({ outDir: ${JSON.stringify(OUT_DIR)}, preset: 'ultrafast' });
  await new Promise(r => setTimeout(r, 400));
  const job = window.flow.recipe.job();
  const p = await window.flow.ipc.plan(job);
  return { job: { factor: job.factor, engine: job.engine, model: job.model, codec: job.codec, crf: job.crf, preset: job.preset, outDir: job.outDir }, plan: p, hint: document.querySelector('#recipe-hint')?.textContent };
})()`);
console.log("plan:", JSON.stringify(plan));

console.log("running live render...");
const started = Date.now();
const run = await ev(`(async () => {
  const job = window.flow.recipe.job();
  window.flow.setStep(2);
  await new Promise(r => setTimeout(r, 400));
  const p = window.flow.startJob(job);
  await new Promise((resolve, reject) => {
    const t = setInterval(() => { if (!window.flow.rt('running')) { clearInterval(t); resolve(); } }, 300);
    setTimeout(() => { clearInterval(t); reject(new Error('render timeout')); }, 240000);
  });
  await p;
  await new Promise(r => setTimeout(r, 1600));
  const out = window.flow.rt('result');
  return {
    outDirHit: out ? out.path.startsWith(${JSON.stringify(OUT_DIR)}) : false,
    result: out ? { path: out.path, name: out.name, frames: out.frames, outFps: out.outFps, bytes: out.bytes } : null,
    stats: [...document.querySelectorAll('.stat')].map(n => n.innerText),
    journal: [...document.querySelectorAll('#journal .j-line')].slice(-8).map(n => n.textContent.trim()),
    toasts: [...document.querySelectorAll('.toast')].map(n => n.innerText),
    vids: [...document.querySelectorAll('.cmp-v')].map(v => ({ src: (v.currentSrc || '').slice(0, 60), w: v.videoWidth, h: v.videoHeight, ready: v.readyState })),
    cmpHidden: document.querySelector('#cmp-stage')?.hidden
  };
})()`);
console.log("render:", JSON.stringify(run, null, 2));
console.log(`render wall time: ${((Date.now() - started) / 1000).toFixed(1)}s`);

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
console.log("screenshot:", SHOT);
if (consoleErrors.length) console.log("console errors:", consoleErrors);
ws.close();
