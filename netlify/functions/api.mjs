// API unique de l'application Suivi Sacs — Netlify Function (format v2)
import crypto from "node:crypto";
import { getStoreInstance, listAll, getMany, updateJSON } from "./lib/store.mjs";

// Matières : codes = préfixes du « Produit à Poser » Salesforce (ex. SUPAR7 → SUPA, R7)
// bagsPerM2 = sacs par m² pour un R7 ; le prévu est proportionnel au R du produit
const DEFAULT_MATERIALS = [
  { id: "supafil", name: "SUPAFIL (Cover+)", codes: ["SUPACOVER+", "MIKITSUPA", "SUPA"], bagsPerM2: 0.21 },
  { id: "meca", name: "MECA", codes: ["MECA"], bagsPerM2: 0.21, aConfirmer: true },
  { id: "roche", name: "ROCHE", codes: ["ROCHE"], bagsPerM2: 0.21, aConfirmer: true },
  { id: "igloo", name: "IGLOO", codes: ["IGLOO"], bagsPerM2: 0.21, aConfirmer: true },
  { id: "mesange", name: "MESANGE", codes: ["MESANGE"], bagsPerM2: 0.21, aConfirmer: true },
  { id: "ouatitude", name: "OUATTITUDE", codes: ["OUATTITUDE"], bagsPerM2: 0.21, aConfirmer: true },
];
const DEFAULT_CONFIG = {
  targetCm: 33,
  depots: ["BEYNOST", "FIRMINY"],
  materials: DEFAULT_MATERIALS,
  thresholds: { warn: 10, alert: 20 }, // % d'écart
  sfMaxGap: 20, // tolérance Salesforce en %
  dateDebut: "2026-10-08", // les dossiers terminés avant cette date sont de l'historique
  typesSuivis: ["Soufflage Combles (dont insufflation)"],
};

const ROLES = ["admin", "resp", "equipe"];

// ---------- utilitaires ----------
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, message, code) => json({ error: message, code }, status);
const httpError = (status, message) => Object.assign(new Error(message), { status });

function secret() {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 12) throw httpError(500, "Variable APP_SECRET absente ou trop courte (12 caractères min.) dans Netlify");
  return s;
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");
function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  if (p.exp < Date.now()) return null;
  return p;
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}
function checkPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"));
}
const norm = (s) => String(s ?? "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
const monthOf = (d) => d.slice(0, 7);
const publicUser = ({ salt, hash, ...u }) => u;

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 36) break;
  }
  return out;
}

async function getConfig(store) {
  const c = (await store.get("config", { type: "json" })) || {};
  const out = { ...DEFAULT_CONFIG, ...c, thresholds: { ...DEFAULT_CONFIG.thresholds, ...(c.thresholds || {}) } };
  // ancienne config sans codes produits → matières par défaut
  if (!Array.isArray(c.materials) || !c.materials.some((m) => Array.isArray(m.codes) && m.codes.length)) out.materials = DEFAULT_MATERIALS;
  return out;
}
async function getUsers(store) {
  return (await store.get("users", { type: "json" }))?.list || [];
}

function requireRole(user, ...roles) {
  if (!user) throw httpError(401, "Non connecté");
  if (!roles.includes(user.role)) throw httpError(403, "Accès non autorisé pour ce rôle");
}
// "Equipe1.iso@bci-solutions.fr", "Équipe 1", "EQUIPE 1" → "equipe1"
const teamKey = (s) => norm(String(s ?? "").split("@")[0]).replace(/\.iso$/, "").replace(/[^a-z0-9]/g, "");
const sameTeam = (user, ch) => !!teamKey(user.team) && teamKey(user.team) === teamKey(ch.equipe);

// ---------- routes ----------
export default async (req) => {
  try {
    const store = await getStoreInstance();
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method;
    const body = ["POST", "PUT"].includes(method) && !(req.headers.get("content-type") || "").startsWith("image/")
      ? await req.json().catch(() => ({}))
      : null;

    const auth = req.headers.get("authorization")?.replace(/^Bearer /, "");
    const user = auth ? verifyToken(auth) : null;

    const [r0, r1, r2, r3] = parts;

    // --- statut / installation ---
    if (r0 === "status" && method === "GET") {
      const users = await getUsers(store);
      return json({ needsSetup: users.length === 0 });
    }
    if (r0 === "setup" && method === "POST") {
      if (body.secret !== secret()) return fail(403, "Code d'installation incorrect");
      if (!body.login || !body.password || body.password.length < 8) return fail(400, "Identifiant et mot de passe (8 caractères min.) requis");
      const res = await updateJSON(store, "users", (cur) => {
        if (cur?.list?.length) throw httpError(409, "Application déjà installée");
        return { list: [{ login: slug(body.login), name: body.name || body.login, role: "admin", team: "", active: true, ...hashPassword(body.password) }] };
      });
      return json({ ok: true, users: res.list.length });
    }
    if (r0 === "login" && method === "POST") {
      const users = await getUsers(store);
      const u = users.find((x) => x.login === slug(body.login) && x.active !== false);
      if (!u || !checkPassword(body.password || "", u)) return fail(401, "Identifiant ou mot de passe incorrect");
      const days = u.role === "equipe" ? 60 : 14;
      const token = signToken({ login: u.login, name: u.name, role: u.role, team: u.team || "", exp: Date.now() + days * 864e5 });
      return json({ token, user: publicUser(u) });
    }

    if (!user) return fail(401, auth ? "Session expirée ou invalide, reconnectez-vous" : "Non connecté", "AUTH");

    if (r0 === "me" && method === "GET") {
      const u = (await getUsers(store)).find((x) => x.login === user.login && x.active !== false);
      if (!u) return fail(401, "Compte supprimé ou désactivé", "AUTH");
      return json(publicUser(u));
    }

    // --- configuration ---
    if (r0 === "config") {
      if (method === "GET") return json(await getConfig(store));
      if (method === "PUT") {
        requireRole(user, "admin");
        const c = { ...(await getConfig(store)), ...body };
        c.materials = (c.materials || []).filter((m) => m.name).map((m) => ({
          id: m.id || slug(m.name), name: m.name, bagsPerM2: num(m.bagsPerM2) || 0, aConfirmer: !!m.aConfirmer,
          codes: (Array.isArray(m.codes) ? m.codes : String(m.codes || "").split(",")).map((x) => String(x).trim().toUpperCase()).filter(Boolean),
        }));
        c.typesSuivis = (Array.isArray(c.typesSuivis) ? c.typesSuivis : []).map((x) => String(x).trim()).filter(Boolean);
        if (!isDate(c.dateDebut)) c.dateDebut = DEFAULT_CONFIG.dateDebut;
        c.depots = (c.depots || []).map((d) => String(d).trim().toUpperCase()).filter(Boolean);
        await store.setJSON("config", c);
        return json(c);
      }
    }

    // --- utilisateurs ---
    if (r0 === "users") {
      requireRole(user, "admin");
      if (method === "GET") return json((await getUsers(store)).map(publicUser));
      if (method === "POST") {
        const login = slug(body.login);
        if (!login) return fail(400, "Identifiant requis");
        if (!ROLES.includes(body.role)) return fail(400, "Rôle invalide");
        if (body.role === "equipe" && !body.team) return fail(400, "Nom d'équipe requis (identique à la planif)");
        const res = await updateJSON(store, "users", (cur) => {
          const list = cur?.list || [];
          const i = list.findIndex((x) => x.login === login);
          if (i < 0 && (!body.password || body.password.length < 6)) throw httpError(400, "Mot de passe requis (6 caractères min.)");
          const base = i >= 0 ? list[i] : {};
          const next = { ...base, login, name: body.name || login, role: body.role, team: body.team || "", active: body.active !== false };
          if (body.password) Object.assign(next, hashPassword(body.password));
          if (i >= 0) list[i] = next; else list.push(next);
          if (!list.some((x) => x.role === "admin" && x.active !== false)) throw httpError(400, "Il doit rester au moins un administrateur actif");
          return { list };
        });
        return json(res.list.map(publicUser));
      }
      if (method === "DELETE" && r1) {
        const res = await updateJSON(store, "users", (cur) => {
          const list = (cur?.list || []).filter((x) => x.login !== r1);
          if (!list.some((x) => x.role === "admin")) throw httpError(400, "Impossible de supprimer le dernier administrateur");
          return { list };
        });
        return json(res.list.map(publicUser));
      }
    }

    // --- import planif (par paquets envoyés par le navigateur) ---
    if (r0 === "import" && method === "POST") {
      requireRole(user, "admin", "resp");
      const config = await getConfig(store);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return fail(400, "Aucune ligne à importer");
      if (rows.length > 300) return fail(400, "300 lignes max. par paquet");
      const batch = body.batch || `${new Date().toISOString()}_${user.login}`;
      const result = { created: 0, updated: 0, moved: 0, unchanged: 0, skipped: [], locked: 0 };
      const idx = (await store.get("idx", { type: "json" })) || {};
      const idxUpdates = {};
      const FIELDS = ["date", "ref", "rdv", "client", "adresse", "ville", "cp", "equipe", "materiau", "produit", "rValue", "surfacePrevue", "sacsPrevus", "typeOpp", "statutSF", "etatSuivi", "dateRealSF"];
      const sameData = (a, b) => FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));
      const tasks = rows.map((row, i) => async () => {
        const date = row.date;
        if (!isDate(date)) return result.skipped.push({ ligne: row.ligne || i + 1, raison: "date invalide" });
        if (!row.client && !row.ref && !row.adresse) return result.skipped.push({ ligne: row.ligne || i + 1, raison: "ni référence, ni client, ni adresse" });
        const surface = num(row.surfacePrevue);
        const mat = config.materials.find((m) => m.name === row.materiau) || config.materials.find((m) => norm(m.name) === norm(row.materiau)) || config.materials[0];
        let sacs = num(row.sacsPrevus);
        if (sacs === null && surface !== null && mat) sacs = Math.ceil(surface * mat.bagsPerM2);
        const id = slug(row.id || row.rdv || row.ref) || slug(`${date}-${row.client}-${row.adresse}`) || crypto.randomUUID();
        const month = monthOf(date);
        const planif = {
          id, month, date, ref: String(row.ref ?? "").trim(), rdv: String(row.rdv ?? "").trim(), client: String(row.client ?? "").trim(),
          adresse: String(row.adresse ?? "").trim(), ville: String(row.ville ?? "").trim(), cp: String(row.cp ?? "").trim(),
          equipe: String(row.equipe ?? "").trim(), materiau: mat ? mat.name : String(row.materiau ?? ""), produit: String(row.produit ?? "").trim(),
          rValue: num(row.rValue), surfacePrevue: surface, sacsPrevus: sacs, typeOpp: String(row.typeOpp ?? "").trim(),
          statutSF: String(row.statutSF ?? "").trim(), etatSuivi: String(row.etatSuivi ?? "").trim(), dateRealSF: isDate(row.dateRealSF) ? row.dateRealSF : null,
        };
        const oldMonth = idx[id];
        // replanifié sur un autre mois : on déplace la fiche (avec sa saisie)
        if (oldMonth && oldMonth !== month) {
          const old = await store.get(`ch/${oldMonth}/${id}`, { type: "json" });
          if (old?.validation) { result.locked++; return; }
          if (old) {
            await store.setJSON(`ch/${month}/${id}`, { ...old, ...planif, updatedAt: new Date().toISOString(), importBatch: batch });
            await store.delete(`ch/${oldMonth}/${id}`);
            idxUpdates[id] = month; result.moved++; return;
          }
        }
        const key = `ch/${month}/${id}`;
        await updateJSON(store, key, (cur) => {
          if (cur?.validation) { result.locked++; return undefined; }
          if (cur && sameData(cur, planif)) { result.unchanged++; return undefined; }
          if (cur) { result.updated++; return { ...cur, ...planif, updatedAt: new Date().toISOString(), importBatch: batch }; }
          result.created++;
          return { ...planif, saisie: null, validation: null, importedAt: new Date().toISOString(), importBatch: batch };
        });
        if (idx[id] !== month) idxUpdates[id] = month;
      });
      for (let i = 0; i < tasks.length; i += 20) await Promise.all(tasks.slice(i, i + 20).map((t) => t()));
      if (Object.keys(idxUpdates).length) await updateJSON(store, "idx", (cur) => ({ ...(cur || {}), ...idxUpdates }));
      return json(result);
    }

    // --- dossiers à planifier (sans date) : remplacés à chaque import ---
    if (r0 === "backlog") {
      requireRole(user, "admin", "resp");
      if (method === "GET") return json((await store.get("backlog", { type: "json" })) || { items: [], at: null });
      if (method === "PUT") {
        const items = (Array.isArray(body.items) ? body.items : []).slice(0, 3000);
        const data = { items, at: new Date().toISOString(), by: user.name };
        await store.setJSON("backlog", data);
        return json({ ok: true, count: items.length });
      }
    }

    // --- chantiers ---
    if (r0 === "chantiers") {
      if (method === "GET" && !r1) {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to") || from;
        if (!isDate(from) || !isDate(to)) return fail(400, "Période invalide");
        const keys = [];
        for (const m of monthsBetween(monthOf(from), monthOf(to))) keys.push(...(await listAll(store, `ch/${m}/`)));
        let items = (await getMany(store, keys)).filter((c) => c.date >= from && c.date <= to);
        if (user.role === "equipe") items = items.filter((c) => sameTeam(user, c));
        items.sort((a, b) => a.date.localeCompare(b.date) || a.equipe.localeCompare(b.equipe) || a.client.localeCompare(b.client));
        return json(items);
      }
      if (method === "DELETE" && r1 === "non-saisis") {
        requireRole(user, "admin");
        const keys = await listAll(store, "ch/");
        const items = await getMany(store, keys);
        const del = items.filter((c) => !c.saisie && !c.validation);
        for (let i = 0; i < del.length; i += 25) await Promise.all(del.slice(i, i + 25).map((c) => store.delete(`ch/${c.month}/${c.id}`)));
        const idx = (await store.get("idx", { type: "json" })) || {};
        del.forEach((c) => delete idx[c.id]);
        await store.setJSON("idx", idx);
        return json({ deleted: del.length });
      }
      // équipes : chantiers passés non saisis (rattrapage)
      if (method === "GET" && r1 === "a-saisir") {
        const today = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
        const keys = [];
        for (const m of monthsBetween(monthOf(from), monthOf(today))) keys.push(...(await listAll(store, `ch/${m}/`)));
        let items = (await getMany(store, keys)).filter((c) => c.date >= from && c.date < today && !c.saisie && !c.exclu);
        if (user.role === "equipe") items = items.filter((c) => sameTeam(user, c));
        return json(items.sort((a, b) => a.date.localeCompare(b.date)));
      }
      if (r1 && r2) {
        const key = `ch/${r1}/${r2}`;
        if (method === "GET" && !r3) {
          const c = await store.get(key, { type: "json" });
          if (!c) return fail(404, "Chantier introuvable");
          if (user.role === "equipe" && !sameTeam(user, c)) return fail(403, "Ce chantier n'est pas affecté à votre équipe");
          return json(c);
        }
        if (method === "PUT" && r3 === "saisie") {
          const config = await getConfig(store);
          const s = {
            depot: String(body.depot || "").toUpperCase(),
            sacsCharges: num(body.sacsCharges), sacsSouffles: num(body.sacsSouffles),
            surfaceMesuree: num(body.surfaceMesuree), epFinale: num(body.epFinale),
            commentaire: String(body.commentaire || "").slice(0, 1000),
            photos: Array.isArray(body.photos) ? body.photos.slice(0, 6) : [],
            by: user.login, byName: user.name, at: new Date().toISOString(),
          };
          if (!config.depots.includes(s.depot)) return fail(400, "Dépôt de départ requis");
          if (s.sacsSouffles === null || s.sacsSouffles < 0) return fail(400, "Nombre de sacs soufflés requis");
          if (s.sacsCharges !== null && s.sacsCharges < 0) return fail(400, "Sacs chargés invalides");
          if (s.sacsCharges !== null && s.sacsSouffles > s.sacsCharges) return fail(400, "Sacs soufflés supérieurs aux sacs chargés : vérifiez la saisie");
          if (s.surfaceMesuree === null || s.surfaceMesuree <= 0) return fail(400, "Surface mesurée requise");
          const res = await updateJSON(store, key, (cur) => {
            if (!cur) throw httpError(404, "Chantier introuvable");
            if (user.role === "equipe" && !sameTeam(user, cur)) throw httpError(403, "Ce chantier n'est pas affecté à votre équipe");
            if (cur.validation) throw httpError(409, "Chantier déjà validé : saisie verrouillée");
            const history = [...(cur.saisieHistory || [])];
            if (cur.saisie) history.push(cur.saisie);
            return { ...cur, saisie: s, saisieHistory: history.slice(-10) };
          }, { create: false });
          return json(res);
        }
        // saisie bureau en tableau : réel + déclaré SF + exclusion, en un seul appel, sans verrou
        if (method === "PUT" && r3 === "ligne") {
          requireRole(user, "admin", "resp");
          const config = await getConfig(store);
          const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
          for (const k of ["surfaceMesuree", "sacsSouffles", "sacsDeclares"]) {
            if (has(k) && body[k] !== "" && body[k] !== null && (num(body[k]) === null || num(body[k]) < 0)) return fail(400, "Valeur numérique invalide");
          }
          if (has("depot") && body.depot && !config.depots.includes(String(body.depot).toUpperCase())) return fail(400, "Dépôt inconnu");
          const now = new Date().toISOString();
          const res = await updateJSON(store, key, (cur) => {
            if (!cur) throw httpError(404, "Chantier introuvable");
            const next = { ...cur };
            if (has("exclu")) next.exclu = !!body.exclu;
            if (has("note")) next.note = String(body.note || "").slice(0, 500);
            if (has("surfaceMesuree") || has("sacsSouffles") || has("depot")) {
              const prev = cur.saisie || {};
              const sa = {
                ...prev,
                depot: has("depot") ? String(body.depot || "").toUpperCase() || prev.depot || config.depots[0] : prev.depot || config.depots[0],
                surfaceMesuree: has("surfaceMesuree") ? num(body.surfaceMesuree) : prev.surfaceMesuree ?? null,
                sacsSouffles: has("sacsSouffles") ? num(body.sacsSouffles) : prev.sacsSouffles ?? null,
                sacsCharges: prev.sacsCharges ?? null, photos: prev.photos || [], commentaire: prev.commentaire || "",
                by: user.login, byName: user.name, at: now,
              };
              next.saisie = sa.surfaceMesuree === null && sa.sacsSouffles === null ? null : sa;
            }
            if (has("sacsDeclares")) {
              const d = num(body.sacsDeclares);
              next.validation = d === null ? null : { ...(cur.validation || {}), sacsDeclares: d, by: user.login, byName: user.name, at: now };
            }
            return next;
          }, { create: false });
          return json(res);
        }
        if (method === "PUT" && r3 === "validation") {
          requireRole(user, "admin", "resp");
          const declares = num(body.sacsDeclares);
          if (declares === null || declares < 0) return fail(400, "Nombre de sacs déclarés dans Salesforce requis");
          const res = await updateJSON(store, key, (cur) => {
            if (!cur) throw httpError(404, "Chantier introuvable");
            return { ...cur, validation: { sacsDeclares: declares, note: String(body.note || "").slice(0, 500), by: user.login, byName: user.name, at: new Date().toISOString() } };
          }, { create: false });
          return json(res);
        }
        if (method === "DELETE" && r3 === "validation") {
          requireRole(user, "admin");
          const res = await updateJSON(store, key, (cur) => (cur ? { ...cur, validation: null, unlockedBy: user.login, unlockedAt: new Date().toISOString() } : undefined), { create: false });
          return json(res);
        }
        if (method === "DELETE" && !r3) {
          requireRole(user, "admin");
          await store.delete(key);
          return json({ ok: true });
        }
      }
    }

    // --- photos ---
    if (r0 === "photos") {
      if (method === "POST") {
        const ct = req.headers.get("content-type") || "";
        if (!ct.startsWith("image/")) return fail(400, "Image attendue");
        const buf = await req.arrayBuffer();
        if (buf.byteLength > 4 * 1024 * 1024) return fail(413, "Photo trop lourde (4 Mo max.)");
        const id = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
        await store.set(`photo/${id}`, buf);
        return json({ id });
      }
      if (method === "GET" && r1) {
        const buf = await store.get(`photo/${r1}`, { type: "arrayBuffer" });
        if (!buf) return fail(404, "Photo introuvable");
        return new Response(buf, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
      }
    }

    // --- stock calculé par dépôt et matière ---
    if (r0 === "stock" && method === "GET") {
      requireRole(user, "admin", "resp");
      const config = await getConfig(store);
      const [mvs, chs] = await Promise.all([
        listAll(store, "mv/").then((k) => getMany(store, k)),
        listAll(store, "ch/").then((k) => getMany(store, k)),
      ]);
      const rows = {};
      const resolveMat = (x) => {
        const k = norm(x).replace(/[^a-z0-9+]/g, "");
        const m = config.materials.find((m) => m.name === x) || config.materials.find((m) => (m.codes || []).some((c) => k.startsWith(norm(c))));
        return m ? m.name : x;
      };
      const row = (depot, matRaw, mat = resolveMat(matRaw)) => (rows[`${depot}|${mat}`] ||= {
        depot, materiau: mat, entrees: 0, souffleTotal: 0, souffleValide: 0, souffleNonValide: 0, declareValide: 0,
        nbChantiers: 0, inventaire: null,
      });
      for (const d of config.depots) for (const m of config.materials) row(d, m.name);
      const invs = [];
      for (const mv of mvs) {
        if (mv.type === "inventaire") { invs.push(mv); continue; }
        row(mv.depot, mv.materiau).entrees += mv.qty;
      }
      for (const c of chs) {
        if (!c.saisie || c.exclu) continue;
        const r = row(c.saisie.depot, c.materiau);
        r.nbChantiers++;
        r.souffleTotal += c.saisie.sacsSouffles || 0;
        if (c.validation) { r.souffleValide += c.saisie.sacsSouffles || 0; r.declareValide += c.validation.sacsDeclares || 0; }
        else r.souffleNonValide += c.saisie.sacsSouffles || 0;
      }
      for (const r of Object.values(rows)) {
        r.officiel = r.entrees - r.declareValide - r.souffleNonValide;
        r.stock2 = r.declareValide - r.souffleValide;
        r.physique = r.entrees - r.souffleTotal;
        const last = invs.filter((i) => i.depot === r.depot && resolveMat(i.materiau) === r.materiau).sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at))[0];
        if (last) {
          const entreesAt = mvs.filter((m) => m.type !== "inventaire" && m.depot === r.depot && resolveMat(m.materiau) === r.materiau && m.date <= last.date).reduce((s, m) => s + m.qty, 0);
          const souffleAt = chs.filter((c) => c.saisie && !c.exclu && c.saisie.depot === r.depot && resolveMat(c.materiau) === r.materiau && c.date <= last.date).reduce((s, c) => s + (c.saisie.sacsSouffles || 0), 0);
          const theorique = entreesAt - souffleAt;
          r.inventaire = { date: last.date, compte: last.qty, theorique, ecart: last.qty - theorique };
        }
      }
      return json(Object.values(rows));
    }

    // --- mouvements de stock ---
    if (r0 === "mouvements") {
      requireRole(user, "admin", "resp");
      if (method === "GET") {
        const keys = await listAll(store, "mv/");
        return json((await getMany(store, keys)).sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at)));
      }
      if (method === "POST") {
        const config = await getConfig(store);
        const types = ["initial", "livraison", "ajustement", "inventaire"];
        const mv = {
          id: `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
          type: body.type, depot: String(body.depot || "").toUpperCase(), materiau: body.materiau,
          qty: num(body.qty), date: body.date, note: String(body.note || "").slice(0, 300), by: user.login, byName: user.name, at: new Date().toISOString(),
        };
        if (!types.includes(mv.type)) return fail(400, "Type de mouvement invalide");
        if (!config.depots.includes(mv.depot)) return fail(400, "Dépôt invalide");
        if (!config.materials.some((m) => m.name === mv.materiau)) return fail(400, "Matière invalide");
        if (mv.qty === null) return fail(400, "Quantité requise");
        if (mv.type !== "ajustement" && mv.qty < 0) return fail(400, "Quantité négative uniquement pour un ajustement");
        if (!isDate(mv.date)) return fail(400, "Date invalide");
        await store.setJSON(`mv/${mv.id}`, mv);
        return json(mv);
      }
      if (method === "DELETE" && r1) {
        requireRole(user, "admin");
        await store.delete(`mv/${r1}`);
        return json({ ok: true });
      }
    }

    return fail(404, "Route inconnue");
  } catch (e) {
    console.error(e);
    return fail(e.status || 500, e.message || "Erreur serveur");
  }
};

export const config = { path: "/api/*" };
