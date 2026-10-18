// Evaluate one expression in the running Tauri WebView.
//   node tools/live-query.mjs "await window.flow.ipc.gpus()"
// Requires the app to be launched with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
const expr = process.argv.slice(2).join(" ") || "1+1";
const port = process.env.FLOW_CDP_PORT || 9223;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve } = pending.get(m.id);
    pending.delete(m.id);
    resolve(m);
  }
};
const result = await new Promise((resolve) => {
  const i = ++id;
  pending.set(i, { resolve });
  ws.send(JSON.stringify({
    id: i,
    method: "Runtime.evaluate",
    params: { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true, userGesture: true },
  }));
});
if (result.result?.exceptionDetails) {
  console.error(result.result.exceptionDetails.exception?.description || result.result.exceptionDetails.text);
  process.exit(1);
}
console.log(JSON.stringify(result.result?.result?.value, null, 2));
ws.close();
