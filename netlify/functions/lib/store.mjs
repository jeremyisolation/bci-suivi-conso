// Couche de stockage : Netlify Blobs en production, fichiers locaux en dev (LOCAL_BLOBS_DIR).
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

class FileStore {
  constructor(dir) { this.dir = dir; }
  p(key) { return path.join(this.dir, encodeURIComponent(key)); }
  etagOf(buf) { return crypto.createHash("md5").update(buf).digest("hex"); }
  async getWithMetadata(key, opts = {}) {
    try {
      const buf = await fs.readFile(this.p(key));
      const data = opts.type === "json" ? JSON.parse(buf.toString()) : opts.type === "arrayBuffer" ? buf : buf.toString();
      return { data, etag: this.etagOf(buf), metadata: {} };
    } catch { return null; }
  }
  async get(key, opts = {}) { const r = await this.getWithMetadata(key, opts); return r ? r.data : null; }
  async set(key, data, opts = {}) {
    await fs.mkdir(this.dir, { recursive: true });
    const cur = await this.getWithMetadata(key);
    if (opts.onlyIfNew && cur) return { modified: false };
    if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
    const buf = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(String(data));
    await fs.writeFile(this.p(key), buf);
    return { modified: true, etag: this.etagOf(buf) };
  }
  async setJSON(key, obj, opts) { return this.set(key, JSON.stringify(obj), opts); }
  async delete(key) { try { await fs.unlink(this.p(key)); } catch {} }
  async list({ prefix = "" } = {}) {
    await fs.mkdir(this.dir, { recursive: true });
    const files = await fs.readdir(this.dir);
    return { blobs: files.map(decodeURIComponent).filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: "" })), directories: [] };
  }
}

let cached;
export async function getStoreInstance() {
  if (cached) return cached;
  if (process.env.LOCAL_BLOBS_DIR) {
    cached = new FileStore(process.env.LOCAL_BLOBS_DIR);
  } else {
    const { getStore } = await import("@netlify/blobs");
    cached = getStore({ name: "isocomp", consistency: "strong" });
  }
  return cached;
}

// Liste complète (gère la pagination Netlify)
export async function listAll(store, prefix) {
  if (store instanceof FileStore) return (await store.list({ prefix })).blobs.map((b) => b.key);
  const keys = [];
  for await (const page of store.list({ prefix, paginate: true })) keys.push(...page.blobs.map((b) => b.key));
  return keys;
}

// Lecture parallèle bornée
export async function getMany(store, keys, concurrency = 40) {
  const out = new Array(keys.length);
  let i = 0;
  async function worker() {
    while (i < keys.length) {
      const idx = i++;
      out[idx] = await store.get(keys[idx], { type: "json" });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
  return out.filter(Boolean);
}

// Mise à jour optimiste avec ETag (évite d'écraser une écriture concurrente)
export async function updateJSON(store, key, fn, { create = true, retries = 5 } = {}) {
  for (let a = 0; a < retries; a++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    if (!cur && !create) return null;
    const next = await fn(cur ? cur.data : null);
    if (next === undefined) return cur ? cur.data : null;
    const res = cur ? await store.setJSON(key, next, { onlyIfMatch: cur.etag }) : await store.setJSON(key, next, { onlyIfNew: true });
    if (res.modified) return next;
  }
  throw Object.assign(new Error("Conflit d'écriture, réessayez"), { status: 409 });
}
