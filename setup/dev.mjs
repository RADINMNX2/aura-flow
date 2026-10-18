// flow. setup dev server. Serves the repo so /setup/ and /assets/ share one origin.
import { createServer } from "node:http";
import { createReadStream, statSync, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.PORT || 4212);
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
};

function send(res, path) {
  let st;
  try { st = statSync(path); } catch { res.writeHead(404).end("404 " + path); return; }
  if (st.isDirectory()) { res.writeHead(404).end("404 dir"); return; }
  res.writeHead(200, { "content-type": MIME[extname(path).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache", "content-length": st.size });
  createReadStream(path).pipe(res);
}

createServer((req, res) => {
  let url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (url === "/" || url === "") { res.writeHead(302, { location: "/setup/" }); res.end(); return; }
  if (url === "/setup") { res.writeHead(302, { location: "/setup/" }); res.end(); return; }
  const rel = url.endsWith("/") ? url + "index.html" : url;
  const path = join(ROOT, normalize(rel).replace(/^([/\\])+/, ""));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end("outside root"); return; }
  if (!existsSync(path)) { res.writeHead(404).end("404 " + url); return; }
  send(res, path);
}).listen(PORT, "127.0.0.1", () => console.log(`flow. setup dev on http://127.0.0.1:${PORT}/setup/`));
