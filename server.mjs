// flow. dev server. Serves the app with Range support (video scrubbing needs it) and adds
// /local/<encoded absolute path> so the compare viewer can load real clips from this machine
// while the UI is still running in a plain browser.

import { createServer } from "node:http";
import { createReadStream, statSync, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT || 4211);

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".woff2": "font/woff2",
  ".mp4": "video/mp4", ".webm": "video/webm", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendFile(req, res, path) {
  let st;
  try { st = statSync(path); } catch { res.writeHead(404, { "content-type": "text/plain" }); return res.end("404 " + path); }
  if (st.isDirectory()) { res.writeHead(404).end("404 dir"); return; }
  const type = MIME[extname(path).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;
  const headers = { "content-type": type, "cache-control": "no-cache", "accept-ranges": "bytes" };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start >= st.size) { res.writeHead(416, { "content-range": `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": st.size });
  createReadStream(path).pipe(res);
}

createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);

  if (url.startsWith("/local/")) {
    const abs = url.slice("/local/".length);
    if (!/^[a-zA-Z]:[\\/]/.test(abs) && !abs.startsWith("\\\\")) { res.writeHead(403).end("absolute paths only"); return; }
    return sendFile(req, res, normalize(abs));
  }

  const rel = url === "/" ? "index.html" : url.endsWith("/") ? url + "index.html" : url;
  const path = join(ROOT, normalize(rel).replace(/^([/\\])+/, ""));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end("outside root"); return; }
  if (!existsSync(path)) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("404 " + url); }
  sendFile(req, res, path);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`flow. dev on http://127.0.0.1:${PORT}  (root ${ROOT})`);
});
