// Local preview without Netlify: serves public/ and the API with in-memory storage.
// Usage: APP_PASSCODE=test node dev-server.mjs   (then open http://localhost:8888)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createHandler } from "./lib/handler.mjs";

const mem = new Map();
const store = {
  async get(k, o = {}) { const v = mem.get(k); if (!v) return null; return o.type === "json" ? JSON.parse(v.data) : v.data; },
  async getWithMetadata(k) { const v = mem.get(k); return v ? { data: v.data, metadata: v.metadata } : null; },
  async setJSON(k, val) { mem.set(k, { data: JSON.stringify(val) }); },
  async set(k, data, o = {}) { mem.set(k, { data, metadata: o.metadata || {} }); },
  async delete(k) { mem.delete(k); },
};
const api = createHandler({ store, passcode: process.env.APP_PASSCODE || "test" });
const types = { ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks);
    const r = await api(new Request(url, { method: req.method, headers: req.headers, body }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  const file = normalize(join("public", url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith("public")) { res.writeHead(404); res.end(); return; }
  try { const data = await readFile(file); res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" }); res.end(data); }
  catch { res.writeHead(404); res.end("Not found"); }
}).listen(process.env.PORT || 8888, () => console.log("Pulse for Two on http://localhost:" + (process.env.PORT || 8888)));
