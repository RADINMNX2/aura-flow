// Screenshot a running WebView2 (Tauri app or setup) over CDP.
//   node tools/live-shot.mjs 9225 dev/shots/setup-done.png
import fs from "node:fs";
import path from "node:path";

const port = process.argv[2] || "9225";
const out = path.resolve(process.argv[3] || "dev/shots/live.png");
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await send("Page.enable");
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
if (!shot.result?.data) throw new Error(JSON.stringify(shot));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log("saved", out);
ws.close();
