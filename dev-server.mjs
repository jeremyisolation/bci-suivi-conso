// Serveur local de test : statique + API (stockage fichiers)
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
process.env.LOCAL_BLOBS_DIR ||= path.resolve(".local-blobs");
process.env.APP_SECRET ||= "dev-secret-0123456789";
const { default: api } = await import("./netlify/functions/api.mjs");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await api(new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  const file = path.join("public", url.pathname === "/" ? "index.html" : url.pathname);
  try { const d = await fs.readFile(file); res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" }); res.end(d); }
  catch { res.writeHead(404); res.end("404"); }
}).listen(process.env.PORT || 8888, () => console.log("http://localhost:" + (process.env.PORT || 8888)));
