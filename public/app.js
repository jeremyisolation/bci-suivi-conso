// Suivi Conso BCI — application front (vanilla JS, sans build)
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $("#app");

// Stockage navigateur avec repli : localStorage → sessionStorage → mémoire (navigation privée, iPhone restreint…)
const memStore = {};
const backends = [() => localStorage, () => sessionStorage];
function usable(f) { try { const s = f(); s.setItem("__t", "1"); s.removeItem("__t"); return s; } catch { return null; } }
const persist = usable(backends[0]) || usable(backends[1]);
const store = {
  persistent: !!persist,
  get(k) { try { const v = persist ? persist.getItem(k) : memStore[k]; return v == null ? null : JSON.parse(v); } catch { return null; } },
  set(k, v) { const j = JSON.stringify(v); try { if (persist) persist.setItem(k, j); else memStore[k] = j; } catch { memStore[k] = j; } },
  del(k) { try { if (persist) persist.removeItem(k); } catch {} delete memStore[k]; },
};

const S = { token: store.get("ss_token"), user: store.get("ss_user"), config: null };

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + "T12:00:00"); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const fmtDate = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit" }) : "";
const fmtDateTime = (d) => d ? new Date(d).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
const n0 = (v) => (v === null || v === undefined || v === "" || Number.isNaN(v)) ? "–" : Number(v).toLocaleString("fr-FR", { maximumFractionDigits: 1 });
const n2 = (v) => (v === null || v === undefined || !Number.isFinite(v)) ? "–" : Number(v).toLocaleString("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const pct = (v) => (v === null || v === undefined || !Number.isFinite(v)) ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(0)} %`;
const num = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(String(v).replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
const norm = (s) => String(s ?? "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const isManager = () => ["admin", "resp"].includes(S.user?.role);
const isAdmin = () => S.user?.role === "admin";

function toast(msg, err = false) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = "toast"), 3200);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (S.token) headers.authorization = `Bearer ${S.token}`;
  let body = opts.body;
  if (body && !(body instanceof Blob) && typeof body !== "string") { headers["content-type"] = "application/json"; body = JSON.stringify(body); }
  const r = await fetch(`/api/${path}`, { method: opts.method || "GET", headers, body });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && data.code === "AUTH" && path !== "login" && path !== "setup") { logout(data.error); throw new Error(data.error || "Session expirée"); }
  if (!r.ok) throw new Error(data.error || `Erreur ${r.status}`);
  return data;
}

function logout(reason) {
  S.token = null; S.user = null; S.config = null; store.del("ss_token"); store.del("ss_user");
  if (typeof reason === "string" && reason) setTimeout(() => toast(reason, true), 50);
  location.hash = "#/"; render();
}

// ---------- calculs métier ----------
// Statut, indicateurs et alertes d'un chantier
function calc(c, cfg = S.config) {
  const th = cfg?.thresholds || { warn: 10, alert: 20 };
  const sfGap = (cfg?.sfMaxGap ?? 20) / 100;
  const s = c.saisie, v = c.validation;
  const status = v ? "valide" : s ? "saisi" : "planifie";
  const m = { status, alerts: [], level: "grey" };
  const p = c.sacsPrevus, sp = c.surfacePrevue;
  m.ratioPrevu = p && sp ? p / sp : null;
  m.sfMin = p ? Math.ceil(p * (1 - sfGap)) : null;
  m.sfMax = p ? Math.floor(p * (1 + sfGap)) : null;
  if (!s) {
    if (c.date < today()) { m.level = "orange"; m.alerts.push(["orange", "Chantier passé non saisi par l'équipe"]); }
    return m;
  }
  m.ecartSacs = p ? ((s.sacsSouffles - p) / p) * 100 : null;
  m.ecartSurface = sp ? ((s.surfaceMesuree - sp) / sp) * 100 : null;
  m.ratio = s.surfaceMesuree ? s.sacsSouffles / s.surfaceMesuree : null;
  m.ecartRatio = m.ratio !== null && m.ratioPrevu ? ((m.ratio - m.ratioPrevu) / m.ratioPrevu) * 100 : null;
  m.retourDepot = (s.sacsCharges ?? 0) - (s.sacsSouffles ?? 0);
  m.surplusCharge = p ? (s.sacsCharges ?? 0) - p : null;
  const add = (lvl, txt) => m.alerts.push([lvl, txt]);
  if (m.ecartSurface !== null) {
    if (Math.abs(m.ecartSurface) > th.alert) add("red", `Surface mesurée ${pct(m.ecartSurface)} vs prévue`);
    else if (Math.abs(m.ecartSurface) > th.warn) add("orange", `Surface mesurée ${pct(m.ecartSurface)} vs prévue`);
  }
  if (m.ecartRatio !== null && m.ecartRatio > th.alert) add("red", `Surconsommation : ${n2(m.ratio)} sac/m² vs ${n2(m.ratioPrevu)} prévu (R7 complet)`);
  else if (m.ecartRatio !== null && m.ecartRatio > th.warn) add("orange", `Consommation au-dessus du prévu (${pct(m.ecartRatio)} au m²)`);
  if (m.ecartSacs !== null && m.ecartSacs < -th.alert) add("blue", `Sous-consommation ${pct(m.ecartSacs)} : existant important ou soufflage insuffisant`);
  if (s.epFinale !== null && s.epFinale !== undefined && cfg && s.epFinale < cfg.targetCm) add("red", `Épaisseur finale ${s.epFinale} cm < ${cfg.targetCm} cm exigés`);
  if (m.surplusCharge !== null && m.surplusCharge > Math.max(3, p * 0.3)) add("blue", `${m.surplusCharge} sacs chargés au-delà du prévu`);
  if (v) {
    m.declares = v.sacsDeclares;
    m.retourOfficiel = (p ?? 0) - v.sacsDeclares;
    m.stock2 = v.sacsDeclares - s.sacsSouffles;
    if (m.sfMin !== null && (v.sacsDeclares < m.sfMin || v.sacsDeclares > m.sfMax)) add("red", `Déclaré ${v.sacsDeclares} hors tolérance Salesforce (${m.sfMin}–${m.sfMax})`);
  }
  m.level = m.alerts.some((a) => a[0] === "red") ? "red" : m.alerts.some((a) => a[0] === "orange") ? "orange" : "green";
  return m;
}
const statusBadge = (st) => ({ planifie: '<span class="badge b-info">Planifié</span>', saisi: '<span class="badge b-warn">Saisi</span>', valide: '<span class="badge b-ok">Validé</span>' }[st]);
const levelRank = { red: 3, orange: 2, green: 1, grey: 0 };

// Statistiques par équipe sur un ensemble de chantiers saisis
function teamStats(items) {
  const t = {}, g = { souffles: 0, surface: 0, prevus: 0, n: 0 };
  for (const c of items) {
    if (!c.saisie) continue;
    const k = c.equipe || "(sans équipe)";
    const r = (t[k] ||= { equipe: k, n: 0, souffles: 0, surface: 0, prevus: 0, surfPrev: 0, charges: 0, declares: 0, nValid: 0, alertes: 0 });
    r.n++; r.souffles += c.saisie.sacsSouffles || 0; r.surface += c.saisie.surfaceMesuree || 0; r.prevus += c.sacsPrevus || 0;
    r.surfPrev += c.surfacePrevue || 0; r.charges += c.saisie.sacsCharges || 0;
    if (c.validation) { r.nValid++; r.declares += c.validation.sacsDeclares || 0; }
    if (calc(c).level === "red") r.alertes++;
    g.souffles += c.saisie.sacsSouffles || 0; g.surface += c.saisie.surfaceMesuree || 0; g.prevus += c.sacsPrevus || 0; g.n++;
  }
  const gRatio = g.surface ? g.souffles / g.surface : null;
  const rows = Object.values(t).map((r) => ({
    ...r, ratio: r.surface ? r.souffles / r.surface : null,
    ecartVsMoy: gRatio && r.surface ? ((r.souffles / r.surface - gRatio) / gRatio) * 100 : null,
    ecartVsPrevu: r.prevus ? ((r.souffles - r.prevus) / r.prevus) * 100 : null,
    ecartSurf: r.surfPrev ? ((r.surface - r.surfPrev) / r.surfPrev) * 100 : null,
  }));
  return { rows: rows.sort((a, b) => a.equipe.localeCompare(b.equipe)), global: { ...g, ratio: gRatio } };
}

// ---------- rendu / routage ----------
const ROUTES_MANAGER = [["#/", "Tableau de bord"], ["#/equipes", "Équipes"], ["#/import", "Import planif"], ["#/stock", "Stock"]];
function renderNav() {
  const tb = $("#topbar");
  if (!S.user) { tb.hidden = true; return; }
  tb.hidden = false;
  $("#whoName").textContent = `${S.user.name}${S.user.role === "equipe" ? "" : S.user.role === "admin" ? " · admin" : " · responsable"}`;
  const links = S.user.role === "equipe" ? [] : [...ROUTES_MANAGER, ...(isAdmin() ? [["#/params", "Paramètres"]] : [])];
  const cur = "#/" + (location.hash.replace(/^#\/?/, "").split("/")[0] || "");
  $("#nav").innerHTML = links.map(([h, l]) => `<a href="${h}" class="${h === cur ? "active" : ""}">${l}</a>`).join("");
}
$("#logoutBtn").onclick = () => logout();

async function render() {
  const rid = (S.rid = (S.rid || 0) + 1);
  renderNav();
  try {
    if (!S.user) return await viewLogin();
    if (!S.checked) { S.checked = true; S.user = await api("me"); store.set("ss_user", S.user); renderNav(); }
    if (!S.config) S.config = await api("config");
    const [r, a, b] = location.hash.replace(/^#\/?/, "").split("/");
    if (r === "saisie") return await viewSaisie(a, b);
    if (S.user.role === "equipe") return await viewEquipeHome();
    if (r === "chantier") return await viewChantier(a, b);
    if (r === "import") return viewImport();
    if (r === "stock") return await viewStock();
    if (r === "equipes") return await viewEquipes();
    if (r === "params" && isAdmin()) return await viewParams();
    return await viewDashboard();
  } catch (e) {
    if (rid !== S.rid) return; // une autre page a été ouverte entre-temps : on ignore l'ancienne
    app.innerHTML = `<div class="card"><h3>Erreur</h3><p>${esc(e.message)}</p><button class="btn-secondary" onclick="location.reload()">Recharger</button></div>`;
  }
}
window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });

// ---------- connexion / installation ----------
async function viewLogin() {
  const st = await api("status").catch(() => ({ needsSetup: false }));
  if (st.needsSetup) {
    app.innerHTML = `<div class="login-box"><img class="logo" src="/logo-bci.png" alt="l'appli BCI"><p class="kicker">Suivi Conso · installation</p><h1>Créer l'administrateur</h1>
      <p class="muted small">Première connexion : créez le compte administrateur. Le code d'installation est la valeur de APP_SECRET définie dans Netlify.</p>
      <form id="f" class="card">
        <div class="field"><label>Code d'installation</label><input name="secret" type="password" required></div>
        <div class="field"><label>Nom affiché</label><input name="name" required value="Jérémy"></div>
        <div class="field"><label>Identifiant</label><input name="login" required autocapitalize="off"></div>
        <div class="field"><label>Mot de passe (8 caractères min.)</label><input name="password" type="password" minlength="8" required></div>
        <button class="block">Créer l'administrateur</button>
      </form></div></div>`;
    $("#f").onsubmit = async (e) => {
      e.preventDefault(); const d = Object.fromEntries(new FormData(e.target));
      try { await api("setup", { method: "POST", body: d }); await doLogin(d.login, d.password); } catch (err) { toast(err.message, true); }
    };
    return;
  }
  app.innerHTML = `<div class="login-box"><img class="logo" src="/logo-bci.png" alt="l'appli BCI">
    <p class="kicker">Complément d'isolation combles</p><h1>Suivi Conso</h1><p class="muted">Consommation de sacs par chantier et par équipe.</p>
    <form id="f" class="card">
      <div class="field"><label>Identifiant</label><input name="login" required autocapitalize="off" autocomplete="username"></div>
      <div class="field"><label>Mot de passe</label><input name="password" type="password" required autocomplete="current-password"></div>
      <button class="block">Se connecter</button>
      ${store.persistent ? "" : `<p class="hint">Ce navigateur bloque l'enregistrement de session (navigation privée ?) : il faudra se reconnecter à chaque ouverture.</p>`}
    </form></div>`;
  $("#f").onsubmit = async (e) => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); try { await doLogin(d.login, d.password); } catch (err) { toast(err.message, true); } };
}
async function doLogin(login, password) {
  const r = await api("login", { method: "POST", body: { login, password } });
  S.token = r.token; S.user = r.user; S.checked = true; store.set("ss_token", r.token); store.set("ss_user", r.user);
  location.hash = "#/"; render();
}

// ---------- vue équipe ----------
async function viewEquipeHome() {
  const day = store.get("ss_day") && store.get("ss_day_set") === today() ? store.get("ss_day") : today();
  app.innerHTML = `<p class="kicker">${esc(S.user.team || S.user.name)}</p><h1>Mes chantiers</h1>
    <div class="datenav"><button class="btn-secondary" id="prev" aria-label="Jour précédent">◀</button><input type="date" id="day" value="${day}"><button class="btn-secondary" id="next" aria-label="Jour suivant">▶</button></div>
    <div id="list"><p class="muted">Chargement…</p></div><div id="late"></div>`;
  const load = async (d) => {
    store.set("ss_day", d); store.set("ss_day_set", today());
    $("#day").value = d;
    const items = await api(`chantiers?from=${d}&to=${d}`);
    $("#list").innerHTML = items.length ? items.map(jobCard).join("") : `<div class="card muted center">Aucun chantier planifié ce jour.</div>`;
  };
  $("#prev").onclick = () => load(addDays($("#day").value, -1));
  $("#next").onclick = () => load(addDays($("#day").value, 1));
  $("#day").onchange = (e) => load(e.target.value);
  await load(day);
  const late = await api("chantiers/a-saisir").catch(() => []);
  if (late.length) $("#late").innerHTML = `<h2>À rattraper — chantiers passés non saisis (${late.length})</h2>` + late.map(jobCard).join("");
}
function jobCard(c) {
  const m = calc(c);
  const info = c.saisie ? `${n0(c.saisie.sacsSouffles)} sacs soufflés · ${n0(c.saisie.surfaceMesuree)} m²` : `Prévu : ${n0(c.sacsPrevus)} sacs · ${n0(c.surfacePrevue)} m²${c.produit ? ` · ${esc(c.produit)}` : ""}`;
  return `<a class="job st-${m.status}" href="#/saisie/${c.month}/${encodeURIComponent(c.id)}">
    <div class="row"><span class="t">${esc(c.client || c.ref)}</span><span class="spacer"></span>${statusBadge(m.status)}</div>
    <div class="s">${esc([c.adresse, c.ville, c.cp].filter(Boolean).join(" "))}${c.ref ? ` · ${esc(c.ref)}` : ""}</div>
    <div class="s">${fmtDate(c.date)} · ${info}</div></a>`;
}

// ---------- saisie chantier (équipe ou responsable) ----------
async function viewSaisie(month, id) {
  const c = await api(`chantiers/${month}/${encodeURIComponent(id)}`);
  const cfg = S.config, s = c.saisie || {}, locked = !!c.validation;
  const back = isManager() ? `#/chantier/${month}/${encodeURIComponent(id)}` : "#/";
  const f = {
    depot: s.depot || store.get("ss_depot") || "", sacsCharges: s.sacsCharges ?? c.sacsPrevus ?? 0, sacsSouffles: s.sacsSouffles ?? "",
    surfaceMesuree: s.surfaceMesuree ?? "", epFinale: s.epFinale ?? "", commentaire: s.commentaire || "", photos: [...(s.photos || [])],
  };
  app.innerHTML = `<a href="${back}" class="small">← Retour</a>
    <p class="kicker" style="margin-top:14px">Saisie chantier</p><h1>${esc(c.client || c.ref)}</h1>
    <p class="muted">${esc([c.adresse, c.ville].filter(Boolean).join(", "))}<br>${fmtDate(c.date)} · ${esc(c.equipe)}${c.ref ? ` · ${esc(c.ref)}` : ""}</p>
    <div class="summary-strip card" style="padding:12px">
      <div><b>${n0(c.surfacePrevue)}</b><span>m² prévus</span></div>
      <div><b>${n0(c.sacsPrevus)}</b><span>sacs prévus (R7)</span></div>
      <div><b>${esc(c.materiau || "–")}</b><span>matière</span></div>
    </div>
    ${locked ? `<div class="card" style="margin-top:12px"><span class="badge b-ok">Validé</span> par ${esc(c.validation.byName)} le ${fmtDateTime(c.validation.at)} — saisie verrouillée.</div>` : ""}
    <form id="f" class="card" style="margin-top:12px">
      <div class="field"><label>Dépôt de départ</label><div class="seg" id="depots">${cfg.depots.map((d) => `<button type="button" data-v="${esc(d)}" class="${f.depot === d ? "on" : ""}">${esc(d)}</button>`).join("")}</div></div>
      ${bigNum("sacsCharges", "Sacs chargés dans le camion", f.sacsCharges)}
      ${bigNum("sacsSouffles", "Sacs soufflés (réellement installés)", f.sacsSouffles)}
      <div class="field"><label>Surface mesurée sur place (m²)</label><input name="surfaceMesuree" inputmode="decimal" value="${esc(f.surfaceMesuree)}" placeholder="Prévu : ${n0(c.surfacePrevue)} m²" required></div>
      <div class="field"><label>Épaisseur finale relevée aux piges (cm) — optionnel</label><input name="epFinale" inputmode="decimal" value="${esc(f.epFinale)}" placeholder="Objectif : ${cfg.targetCm} cm"></div>
      <div class="field"><label>Photos (combles après soufflage, piges)</label><div class="photos" id="photos"></div><input type="file" id="photoInput" accept="image/*" capture="environment" hidden multiple></div>
      <div class="field"><label>Commentaire</label><textarea name="commentaire" rows="2" placeholder="Accès difficile, existant très tassé, surface différente…">${esc(f.commentaire)}</textarea></div>
      <div class="summary-strip" id="live"></div>
      <div class="sticky-submit"><button class="block" id="submit" ${locked ? "disabled" : ""}>${c.saisie ? "Mettre à jour la saisie" : "Enregistrer la saisie"}</button></div>
    </form>
    ${c.saisie ? `<p class="muted small">Dernière saisie : ${esc(c.saisie.byName)} le ${fmtDateTime(c.saisie.at)}</p>` : ""}`;
  const form = $("#f");
  if (locked) $$("input,textarea,button", form).forEach((el) => (el.disabled = true));
  $$("#depots button").forEach((b) => (b.onclick = () => { f.depot = b.dataset.v; $$("#depots button").forEach((x) => x.classList.toggle("on", x === b)); }));
  wireBigNums(form, live);
  form.addEventListener("input", live);
  function live() {
    const ch = num(form.sacsCharges.value), so = num(form.sacsSouffles.value), su = num(form.surfaceMesuree.value);
    const ret = ch !== null && so !== null ? ch - so : null;
    const ecart = so !== null && c.sacsPrevus ? ((so - c.sacsPrevus) / c.sacsPrevus) * 100 : null;
    $("#live").innerHTML = `<div><b class="${ret < 0 ? "pos" : ""}">${n0(ret)}</b><span>sacs à ramener au dépôt</span></div>
      <div><b>${pct(ecart)}</b><span>écart vs prévu</span></div><div><b>${su && so !== null ? n2(so / su) : "–"}</b><span>sac / m²</span></div>`;
  }
  live();
  const renderPhotos = () => {
    $("#photos").innerHTML = f.photos.map((p, i) => `<div class="photo-wrap"><img src="" data-photo="${esc(p)}" alt="Photo ${i + 1}">${locked ? "" : `<button type="button" data-del="${i}" aria-label="Supprimer">✕</button>`}</div>`).join("")
      + (locked || f.photos.length >= 6 ? "" : `<label class="photo-add" for="photoInput">+ Photo</label>`);
    loadPhotos($("#photos"));
    $$("[data-del]").forEach((b) => (b.onclick = () => { f.photos.splice(+b.dataset.del, 1); renderPhotos(); }));
  };
  renderPhotos();
  $("#photoInput").onchange = async (e) => {
    for (const file of [...e.target.files].slice(0, 6 - f.photos.length)) {
      try { toast("Envoi de la photo…"); const blob = await compressImage(file); const r = await api("photos", { method: "POST", body: blob, headers: { "content-type": "image/jpeg" } }); f.photos.push(r.id); renderPhotos(); toast("Photo ajoutée"); }
      catch (err) { toast(err.message, true); }
    }
    e.target.value = "";
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!f.depot) return toast("Choisissez le dépôt de départ", true);
    const body = { depot: f.depot, sacsCharges: form.sacsCharges.value, sacsSouffles: form.sacsSouffles.value, surfaceMesuree: form.surfaceMesuree.value, epFinale: form.epFinale.value, commentaire: form.commentaire.value, photos: f.photos };
    const so = num(body.sacsSouffles);
    if (so !== null && c.sacsPrevus && Math.abs(so - c.sacsPrevus) / c.sacsPrevus > 0.5 && !confirm(`${so} sacs soufflés pour ${c.sacsPrevus} prévus, soit un écart de plus de 50 %. Confirmez-vous ?`)) return;
    $("#submit").disabled = true;
    try { await api(`chantiers/${month}/${encodeURIComponent(id)}/saisie`, { method: "PUT", body }); store.set("ss_depot", f.depot); toast("Saisie enregistrée"); location.hash = back; }
    catch (err) { toast(err.message, true); $("#submit").disabled = false; }
  };
}
function bigNum(name, label, value) {
  return `<div class="field"><label>${label}</label><div class="big-num"><button type="button" data-step="-1" data-for="${name}" aria-label="Moins">−</button><input name="${name}" inputmode="numeric" pattern="[0-9]*" value="${esc(value)}" required><button type="button" data-step="1" data-for="${name}" aria-label="Plus">+</button></div></div>`;
}
function wireBigNums(form, cb) {
  $$("[data-step]", form).forEach((b) => (b.onclick = () => { const i = form[b.dataset.for]; i.value = Math.max(0, (num(i.value) || 0) + Number(b.dataset.step)); cb && cb(); }));
}
async function compressImage(file, max = 1400) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const cv = document.createElement("canvas"); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
  cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
  URL.revokeObjectURL(img.src);
  return await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.75));
}
async function loadPhotos(root) {
  for (const img of $$("img[data-photo]", root)) {
    try {
      const r = await fetch(`/api/photos/${img.dataset.photo}`, { headers: { authorization: `Bearer ${S.token}` } });
      if (r.ok) { img.src = URL.createObjectURL(await r.blob()); img.onclick = () => { const lb = document.createElement("div"); lb.className = "lightbox"; lb.innerHTML = `<img src="${img.src}" alt="">`; lb.onclick = () => lb.remove(); document.body.append(lb); }; }
    } catch {}
  }
}

// ---------- tableau de bord responsable ----------
const DASH = { from: addDays(today(), -7), to: addDays(today(), 14), equipe: "", statut: "", niveau: "", q: "", sort: "date", dir: 1, ...(store.get("ss_dash2") || {}) };
async function viewDashboard() {
  app.innerHTML = `<div class="row"><h1>Tableau de bord</h1><span class="spacer"></span><button class="btn-secondary sm" id="csv">Exporter CSV</button></div>
    <div class="filters">
      <div class="field"><label>Du</label><input type="date" id="from" value="${DASH.from}"></div>
      <div class="field"><label>Au</label><input type="date" id="to" value="${DASH.to}"></div>
      <div class="field"><label>Équipe</label><select id="equipe"><option value="">Toutes</option></select></div>
      <div class="field"><label>Statut</label><select id="statut"><option value="">Tous</option><option value="planifie">Planifié</option><option value="saisi">Saisi (à valider)</option><option value="valide">Validé</option></select></div>
      <div class="field"><label>Alerte</label><select id="niveau"><option value="">Toutes</option><option value="red">Rouge</option><option value="orange">Orange et +</option><option value="green">Vert</option></select></div>
      <div class="field"><label>Recherche</label><input id="q" placeholder="Client, réf., ville" value="${esc(DASH.q)}"></div>
    </div>
    <div class="tabs" id="quick"><button data-r="0">Aujourd'hui</button><button data-r="1">Hier</button><button data-r="7">7 derniers jours</button><button data-r="next">À venir (14 j)</button><button data-r="both">−7 j / +14 j</button><button data-r="month">Ce mois</button></div>
    <div id="kpis" class="kpis"></div><div id="table"><p class="muted">Chargement…</p></div>`;
  ["statut", "niveau"].forEach((k) => ($("#" + k).value = DASH[k]));
  let items = [];
  const load = async () => {
    DASH.from = $("#from").value; DASH.to = $("#to").value; store.set("ss_dash2", DASH);
    $("#table").innerHTML = `<p class="muted">Chargement…</p>`;
    items = (await api(`chantiers?from=${DASH.from}&to=${DASH.to}`)).map((c) => ({ ...c, m: calc(c) }));
    const teams = [...new Set(items.map((c) => c.equipe).filter(Boolean))].sort();
    $("#equipe").innerHTML = `<option value="">Toutes</option>` + teams.map((t) => `<option ${t === DASH.equipe ? "selected" : ""}>${esc(t)}</option>`).join("");
    draw();
  };
  const filtered = () => items.filter((c) =>
    (!DASH.equipe || c.equipe === DASH.equipe) && (!DASH.statut || c.m.status === DASH.statut) &&
    (!DASH.niveau || (DASH.niveau === "orange" ? levelRank[c.m.level] >= 2 : c.m.level === DASH.niveau)) &&
    (!DASH.q || norm([c.client, c.ref, c.ville, c.adresse].join(" ")).includes(norm(DASH.q))));
  const cols = [
    ["niveau", "", (c) => levelRank[c.m.level]], ["date", "Date", (c) => c.date], ["equipe", "Équipe", (c) => c.equipe], ["client", "Chantier", (c) => c.client],
    ["surfP", "m² prév.", (c) => c.surfacePrevue], ["surfM", "m² mes.", (c) => c.saisie?.surfaceMesuree], ["prev", "Prévus", (c) => c.sacsPrevus],
    ["charg", "Chargés", (c) => c.saisie?.sacsCharges], ["souf", "Soufflés", (c) => c.saisie?.sacsSouffles], ["ecart", "Écart", (c) => c.m.ecartSacs],
    ["ratio", "Sac/m²", (c) => c.m.ratio], ["decl", "Déclarés SF", (c) => c.validation?.sacsDeclares], ["ret", "Retour off.", (c) => c.m.retourOfficiel],
    ["s2", "Stock 2", (c) => c.m.stock2], ["statut", "Statut", (c) => c.m.status],
  ];
  function draw() {
    const rows = filtered();
    const col = cols.find((x) => x[0] === DASH.sort) || cols[0];
    rows.sort((a, b) => { const va = col[2](a), vb = col[2](b); if (va === vb) return a.date.localeCompare(b.date); if (va === null || va === undefined) return 1; if (vb === null || vb === undefined) return -1; return (va > vb ? 1 : -1) * DASH.dir; });
    const sum = (f) => rows.reduce((s, c) => s + (f(c) || 0), 0);
    const saisis = rows.filter((c) => c.saisie), valides = rows.filter((c) => c.validation);
    const prevSaisis = saisis.reduce((s, c) => s + (c.sacsPrevus || 0), 0), soufSaisis = sum((c) => c.saisie?.sacsSouffles);
    const surfM = sum((c) => c.saisie?.surfaceMesuree);
    const red = rows.filter((c) => c.m.level === "red").length;
    const late = rows.filter((c) => !c.saisie && c.date < today()).length;
    $("#kpis").innerHTML = [
      [rows.length, "chantiers planifiés"], [`${saisis.length} / ${valides.length}`, "saisis / validés"],
      [n0(prevSaisis), "sacs prévus (chantiers saisis)"], [n0(soufSaisis), "sacs soufflés"],
      [pct(prevSaisis ? ((soufSaisis - prevSaisis) / prevSaisis) * 100 : null), "écart soufflé vs prévu"],
      [surfM ? n2(soufSaisis / surfM) : "–", "sacs / m² mesuré"],
      [n0(sum((c) => c.m.stock2)), "stock 2 (déclaré − soufflé)"],
      [red, "alertes rouges", red ? "bad" : "ok"], [late, "chantiers passés non saisis", late ? "warn" : "ok"],
    ].map(([v, l, cls]) => `<div class="kpi ${cls || ""}"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
    if (!rows.length) { $("#table").innerHTML = `<div class="card muted center">Aucun chantier sur cette sélection. Importez la planif depuis l'onglet « Import planif ».</div>`; return; }
    $("#table").innerHTML = `<div class="table-wrap"><table><thead><tr>${cols.map(([k, l]) => `<th class="sortable ${["surfP", "surfM", "prev", "charg", "souf", "ecart", "ratio", "decl", "ret", "s2"].includes(k) ? "num" : ""}" data-k="${k}">${l}${DASH.sort === k ? (DASH.dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>
      ${rows.map((c) => `<tr class="clickable" data-href="#/chantier/${c.month}/${encodeURIComponent(c.id)}" title="${esc(c.m.alerts.map((a) => a[1]).join(" · "))}">
        <td><span class="dot ${c.m.level}"></span></td><td class="nw">${fmtDate(c.date)}</td><td class="nw">${esc(c.equipe)}</td>
        <td><b>${esc(c.client || "–")}</b><div class="muted small">${esc(c.ref)} ${esc(c.ville)}</div></td>
        <td class="num">${n0(c.surfacePrevue)}</td><td class="num">${n0(c.saisie?.surfaceMesuree)}</td><td class="num">${n0(c.sacsPrevus)}</td>
        <td class="num">${n0(c.saisie?.sacsCharges)}</td><td class="num"><b>${n0(c.saisie?.sacsSouffles)}</b></td>
        <td class="num ${c.m.ecartSacs > 0 ? "pos" : c.m.ecartSacs < 0 ? "neg" : ""}">${pct(c.m.ecartSacs)}</td><td class="num">${n2(c.m.ratio)}</td>
        <td class="num">${n0(c.validation?.sacsDeclares)}</td><td class="num">${n0(c.m.retourOfficiel)}</td><td class="num">${n0(c.m.stock2)}</td><td>${statusBadge(c.m.status)}</td></tr>`).join("")}
      </tbody><tfoot><tr><td></td><td colspan="3">Total (${rows.length})</td><td class="num">${n0(sum((c) => c.surfacePrevue))}</td><td class="num">${n0(surfM)}</td>
        <td class="num">${n0(sum((c) => c.sacsPrevus))}</td><td class="num">${n0(sum((c) => c.saisie?.sacsCharges))}</td><td class="num">${n0(soufSaisis)}</td><td></td><td></td>
        <td class="num">${n0(sum((c) => c.validation?.sacsDeclares))}</td><td class="num">${n0(sum((c) => c.m.retourOfficiel))}</td><td class="num">${n0(sum((c) => c.m.stock2))}</td><td></td></tr></tfoot></table></div>
      <p class="muted small">Survolez une ligne pour voir ses alertes. Retour officiel = prévu − déclaré SF ; Stock 2 = déclaré SF − soufflé.</p>`;
    $$("th.sortable").forEach((th) => (th.onclick = () => { if (DASH.sort === th.dataset.k) DASH.dir *= -1; else { DASH.sort = th.dataset.k; DASH.dir = th.dataset.k === "niveau" ? -1 : 1; } store.set("ss_dash2", DASH); draw(); }));
    $$("tr[data-href]").forEach((tr) => (tr.onclick = () => (location.hash = tr.dataset.href)));
  }
  $("#from").onchange = load; $("#to").onchange = load;
  ["equipe", "statut", "niveau"].forEach((k) => ($("#" + k).onchange = (e) => { DASH[k] = e.target.value; store.set("ss_dash2", DASH); draw(); }));
  $("#q").oninput = (e) => { DASH.q = e.target.value; draw(); };
  $$("#quick button").forEach((b) => (b.onclick = () => {
    const r = b.dataset.r, t = today();
    if (r === "month") { $("#from").value = t.slice(0, 8) + "01"; $("#to").value = addDays(addDays(t.slice(0, 8) + "28", 4).slice(0, 8) + "01", -1); }
    else if (r === "next") { $("#from").value = t; $("#to").value = addDays(t, 14); }
    else if (r === "both") { $("#from").value = addDays(t, -7); $("#to").value = addDays(t, 14); }
    else if (r === "1") { $("#from").value = $("#to").value = addDays(t, -1); }
    else { $("#from").value = addDays(t, -(+r === 0 ? 0 : +r - 1)); $("#to").value = t; }
    load();
  }));
  $("#csv").onclick = () => exportCsv(filtered());
  await load();
}
function exportCsv(rows) {
  const head = ["Date", "Réf", "Client", "Adresse", "Ville", "Équipe", "Matière", "Surface prévue", "Surface mesurée", "Sacs prévus", "Dépôt", "Sacs chargés", "Sacs soufflés", "Écart % soufflé/prévu", "Sacs/m²", "Épaisseur finale", "Déclarés SF", "Retour stock officiel", "Stock 2", "Statut", "Alerte", "Détail alertes", "Commentaire"];
  const lines = rows.map((c) => { const m = c.m || calc(c); return [c.date, c.ref, c.client, c.adresse, c.ville, c.equipe, c.materiau, c.surfacePrevue, c.saisie?.surfaceMesuree, c.sacsPrevus, c.saisie?.depot, c.saisie?.sacsCharges, c.saisie?.sacsSouffles, m.ecartSacs?.toFixed(1), m.ratio?.toFixed(3), c.saisie?.epFinale, c.validation?.sacsDeclares, m.retourOfficiel, m.stock2, m.status, m.level, m.alerts.map((a) => a[1]).join(" | "), c.saisie?.commentaire]; });
  const csv = "﻿" + [head, ...lines].map((r) => r.map((v) => { const s = v === null || v === undefined ? "" : String(v).replace(".", typeof v === "number" || /^-?\d+\.\d+$/.test(String(v)) ? "," : "."); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(";")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); a.download = `suivi-conso_${DASH.from}_${DASH.to}.csv`; a.click();
}

// ---------- fiche chantier + validation ----------
async function viewChantier(month, id) {
  const c = await api(`chantiers/${month}/${encodeURIComponent(id)}`);
  const m = calc(c), s = c.saisie, v = c.validation;
  app.innerHTML = `<a href="#/" class="small">← Tableau de bord</a>
    <div class="row"><h1>${esc(c.client || c.ref)}</h1>${statusBadge(m.status)}<span class="dot ${m.level}"></span></div>
    <p class="muted">${esc([c.adresse, c.ville].filter(Boolean).join(", "))} · ${fmtDate(c.date)} · ${esc(c.equipe)}${c.ref ? ` · ${esc(c.ref)}` : ""}</p>
    ${m.alerts.length ? `<ul class="alerts-list">${m.alerts.map(([l, t]) => `<li class="${l}">${esc(t)}</li>`).join("")}</ul>` : s ? `<ul class="alerts-list"><li class="blue">Aucune alerte sur ce chantier.</li></ul>` : ""}
    <div class="grid grid-2" style="margin-top:12px">
      <div class="card"><h3>Prévu (planif)</h3><dl class="kv">
        <dt>Surface</dt><dd>${n0(c.surfacePrevue)} m²</dd><dt>Sacs prévus</dt><dd>${n0(c.sacsPrevus)}</dd><dt>Matière</dt><dd>${esc(c.materiau)}</dd>
        <dt>Sac/m² prévu</dt><dd>${n2(m.ratioPrevu)}</dd><dt>Tolérance SF</dt><dd>${m.sfMin ?? "–"} à ${m.sfMax ?? "–"} sacs</dd></dl></div>
      <div class="card"><h3>Saisie équipe</h3>${s ? `<dl class="kv">
        <dt>Dépôt</dt><dd>${esc(s.depot)}</dd><dt>Chargés</dt><dd>${n0(s.sacsCharges)}</dd><dt>Soufflés</dt><dd>${n0(s.sacsSouffles)} <span class="muted">(${pct(m.ecartSacs)})</span></dd>
        <dt>Retour dépôt</dt><dd>${n0(m.retourDepot)} sacs</dd><dt>Surface mesurée</dt><dd>${n0(s.surfaceMesuree)} m² <span class="muted">(${pct(m.ecartSurface)})</span></dd>
        <dt>Sac/m²</dt><dd>${n2(m.ratio)}</dd><dt>Épaisseur finale</dt><dd>${s.epFinale ? `${s.epFinale} cm` : "–"}</dd>
        <dt>Par</dt><dd>${esc(s.byName)} · ${fmtDateTime(s.at)}</dd></dl>
        ${s.commentaire ? `<p><i>« ${esc(s.commentaire)} »</i></p>` : ""}<div class="photos" style="margin-top:8px">${(s.photos || []).map((p) => `<img data-photo="${esc(p)}" alt="Photo chantier">`).join("")}</div>
        ${c.saisieHistory?.length ? `<p class="muted small">${c.saisieHistory.length} saisie(s) précédente(s) : ${c.saisieHistory.map((h) => `${h.sacsSouffles} sacs (${fmtDateTime(h.at)})`).join(", ")}</p>` : ""}` : `<p class="muted">Pas encore saisi par l'équipe.</p>`}
        ${!v ? `<a class="btn btn-secondary sm" href="#/saisie/${month}/${encodeURIComponent(id)}">${s ? "Corriger la saisie" : "Saisir à la place de l'équipe"}</a>` : ""}</div>
    </div>
    <div class="card" style="margin-top:12px" id="valid"></div>
    ${isAdmin() ? `<p style="margin-top:16px"><button class="btn-ghost sm" id="del">Supprimer ce chantier</button></p>` : ""}`;
  loadPhotos(app);
  const box = $("#valid");
  if (v) {
    box.innerHTML = `<h3>Saisie finale Salesforce</h3><dl class="kv"><dt>Déclarés SF</dt><dd>${n0(v.sacsDeclares)} sacs</dd>
      <dt>Retour stock officiel</dt><dd>${n0(m.retourOfficiel)} sacs (prévu − déclaré)</dd><dt>Stock 2</dt><dd>${n0(m.stock2)} sacs (déclaré − soufflé)</dd>
      <dt>Validé par</dt><dd>${esc(v.byName)} · ${fmtDateTime(v.at)}</dd>${v.note ? `<dt>Note</dt><dd>${esc(v.note)}</dd>` : ""}</dl>
      ${isAdmin() ? `<p><button class="btn-secondary sm" id="unlock">Déverrouiller</button></p>` : ""}`;
    if ($("#unlock")) $("#unlock").onclick = async () => { if (!confirm("Déverrouiller ce chantier ? La saisie finale sera effacée.")) return; await api(`chantiers/${month}/${encodeURIComponent(id)}/validation`, { method: "DELETE" }); toast("Chantier déverrouillé"); render(); };
  } else if (s) {
    box.innerHTML = `<h3>Saisie finale Salesforce</h3><p class="muted small">Le nombre de sacs enregistré dans Salesforce devient la consommation officielle. Tolérance Salesforce : ${m.sfMin}–${m.sfMax} sacs.</p>
      <form id="vf"><div class="inline-fields"><div class="field"><label>Sacs déclarés dans Salesforce</label><input name="sacsDeclares" inputmode="numeric" required></div>
      <div class="field" style="flex:2 1 200px"><label>Note (facultatif)</label><input name="note"></div><button>Valider et verrouiller</button></div>
      <div class="summary-strip" id="vlive" style="margin-top:12px"></div></form>`;
    const vf = $("#vf");
    const vlive = () => {
      const d = num(vf.sacsDeclares.value);
      const out = d !== null && (d < m.sfMin || d > m.sfMax);
      $("#vlive").innerHTML = `<div><b>${d === null ? "–" : n0((c.sacsPrevus ?? 0) - d)}</b><span>retour stock officiel</span></div><div><b>${d === null ? "–" : n0(d - s.sacsSouffles)}</b><span>stock 2</span></div>
        <div><b class="${out ? "pos" : ""}">${d === null ? "–" : out ? "Hors tolérance" : "OK"}</b><span>contrôle Salesforce</span></div>`;
    };
    vf.oninput = vlive; vlive();
    vf.onsubmit = async (e) => {
      e.preventDefault(); const d = num(vf.sacsDeclares.value);
      if (d !== null && (d < m.sfMin || d > m.sfMax) && !confirm(`${d} sacs est hors de la tolérance Salesforce (${m.sfMin}–${m.sfMax}). Valider quand même ?`)) return;
      try { await api(`chantiers/${month}/${encodeURIComponent(id)}/validation`, { method: "PUT", body: { sacsDeclares: vf.sacsDeclares.value, note: vf.note.value } }); toast("Chantier validé"); render(); }
      catch (err) { toast(err.message, true); }
    };
  } else box.innerHTML = `<h3>Saisie finale Salesforce</h3><p class="muted">Disponible une fois la saisie équipe faite.</p>`;
  if ($("#del")) $("#del").onclick = async () => { if (!confirm("Supprimer définitivement ce chantier et sa saisie ?")) return; await api(`chantiers/${month}/${encodeURIComponent(id)}`, { method: "DELETE" }); toast("Chantier supprimé"); location.hash = "#/"; };
}

// ---------- performance équipes ----------
async function viewEquipes() {
  const p = store.get("ss_eq") || { from: today().slice(0, 8) + "01", to: today() };
  app.innerHTML = `<h1>Performance des équipes</h1>
    <p class="muted small">Sans épaisseur existante connue, un chantier isolé ne prouve rien. Le signal, c'est une équipe dont la moyenne sacs/m² s'écarte durablement de celle des autres sur un grand nombre de maisons.</p>
    <div class="filters"><div class="field"><label>Du</label><input type="date" id="from" value="${p.from}"></div><div class="field"><label>Au</label><input type="date" id="to" value="${p.to}"></div></div>
    <div id="out"><p class="muted">Chargement…</p></div>`;
  const load = async () => {
    p.from = $("#from").value; p.to = $("#to").value; store.set("ss_eq", p);
    const items = await api(`chantiers?from=${p.from}&to=${p.to}`);
    const { rows, global } = teamStats(items);
    const th = S.config.thresholds;
    if (!rows.length) { $("#out").innerHTML = `<div class="card muted center">Aucun chantier saisi sur la période.</div>`; return; }
    const maxR = Math.max(...rows.map((r) => r.ratio || 0), global.ratio || 0);
    $("#out").innerHTML = `<div class="kpis"><div class="kpi"><div class="v">${global.n}</div><div class="l">chantiers saisis</div></div>
      <div class="kpi"><div class="v">${n2(global.ratio)}</div><div class="l">sacs / m² moyen (toutes équipes)</div></div>
      <div class="kpi"><div class="v">${pct(global.prevus ? ((global.souffles - global.prevus) / global.prevus) * 100 : null)}</div><div class="l">soufflé vs prévu R7</div></div></div>
      <div class="table-wrap"><table><thead><tr><th>Équipe</th><th class="num">Chantiers</th><th class="num">m² mesurés</th><th class="num">Écart surface</th><th class="num">Sacs prévus</th><th class="num">Sacs soufflés</th><th class="num">Soufflé vs prévu</th><th>Sacs / m²</th><th class="num">vs moyenne</th><th class="num">Chargés − soufflés</th><th class="num">Alertes rouges</th></tr></thead><tbody>
      ${rows.map((r) => { const flag = r.ecartVsMoy !== null && Math.abs(r.ecartVsMoy) > th.warn && r.n >= 5;
        return `<tr><td class="nw"><b>${esc(r.equipe)}</b></td><td class="num">${r.n}</td><td class="num">${n0(r.surface)}</td><td class="num">${pct(r.ecartSurf)}</td><td class="num">${n0(r.prevus)}</td><td class="num">${n0(r.souffles)}</td>
        <td class="num">${pct(r.ecartVsPrevu)}</td><td><div class="row" style="gap:8px;flex-wrap:nowrap"><div class="bar"><i style="width:${maxR ? (r.ratio / maxR) * 100 : 0}%"></i></div><span class="num">${n2(r.ratio)}</span></div></td>
        <td class="num">${flag ? `<span class="badge ${r.ecartVsMoy > 0 ? "b-bad" : "b-warn"}">${pct(r.ecartVsMoy)}</span>` : pct(r.ecartVsMoy)}</td><td class="num">${n0(r.charges - r.souffles)}</td><td class="num">${r.alertes || ""}</td></tr>`; }).join("")}
      </tbody></table></div>
      <p class="muted small">Une équipe est signalée quand son ratio sacs/m² s'écarte de plus de ${th.warn} % de la moyenne, avec au moins 5 chantiers. Au-dessus : surconsommation probable. En dessous : sous-soufflage possible, ou secteur avec un meilleur existant. Vérifiez par photos et contrôles de piges.</p>`;
  };
  $("#from").onchange = load; $("#to").onchange = load;
  await load();
}

// ---------- import planif ----------
const FIELDS = [
  ["date", "Date du chantier", ["date", "jour", "date intervention", "date chantier", "date planif", "date pose", "debut"]],
  ["ref", "Référence / n° dossier", ["ref", "reference", "dossier", "n dossier", "numero", "affaire", "opportunite", "id"]],
  ["client", "Client / nom", ["client", "nom", "beneficiaire", "occupant", "locataire", "compte"]],
  ["adresse", "Adresse", ["adresse", "rue", "voie"]],
  ["ville", "Ville", ["ville", "commune", "localite", "cp ville"]],
  ["equipe", "Équipe", ["equipe", "poseur", "technicien", "ressource", "team", "chef"]],
  ["surfacePrevue", "Surface prévue (m²)", ["surface", "m2", "m²", "superficie", "surface prevue"]],
  ["materiau", "Matière", ["matiere", "materiau", "produit", "isolant", "article"]],
  ["sacsPrevus", "Sacs prévus (facultatif)", ["sacs", "nb sacs", "nombre de sacs", "quantite", "qte"]],
];
function viewImport() {
  const cfg = S.config;
  app.innerHTML = `<p class="kicker">Planification</p><h1>Import de la planif</h1>
    <p class="muted small">Déposez l'export Salesforce tel quel (.xls, .xlsx ou .csv) : l'appli le reconnaît et trie seule les types d'opportunité, l'historique, les annulés, la planif datée et les dossiers à planifier. Vous pouvez réimporter chaque jour : un chantier déjà importé est mis à jour (y compris s'il est replanifié) sans toucher à la saisie de l'équipe, et un chantier validé n'est jamais modifié.</p>
    <div class="card"><div class="inline-fields">
      <div class="field" style="flex:2 1 260px"><label>Fichier</label><input type="file" id="file" accept=".xlsx,.xls,.csv"></div>
      <div class="field"><label>Date par défaut (si pas de colonne date)</label><input type="date" id="defDate" value="${addDays(today(), 1)}"></div>
      <div class="field"><label>Matière par défaut</label><select id="defMat">${cfg.materials.map((m) => `<option>${esc(m.name)}</option>`).join("")}</select></div>
    </div></div><div id="map"></div><div id="preview"></div>`;
  let rows = [], headers = [];
  $("#file").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (!window.XLSX) return toast("Lecteur Excel non chargé, vérifiez la connexion", true);
    const buf = await file.arrayBuffer();
    let wb;
    if (/\.csv$/i.test(file.name)) {
      // CSV : décodage UTF-8 ou Windows-1252 (export Excel FR), sans interprétation des dates au format US
      let text = new TextDecoder("utf-8").decode(buf);
      if (text.includes("�")) text = new TextDecoder("windows-1252").decode(buf);
      wb = XLSX.read(text.replace(/^﻿/, ""), { type: "string", raw: true });
    } else wb = XLSX.read(buf, { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
    const hi = raw.findIndex((r) => r.filter((x) => String(x).trim()).length >= 3);
    if (hi < 0) return toast("Aucune ligne d'en-tête trouvée", true);
    headers = raw[hi].map((h, i) => String(h).trim() || `Colonne ${i + 1}`);
    rows = raw.slice(hi + 1).filter((r) => r.some((x) => String(x).trim()));
    if (isSalesforce(headers)) {
      // relecture sans conversion de dates : Salesforce exporte en heure UTC, on convertit nous-mêmes en heure de Paris
      const raw2 = /\.csv$/i.test(file.name) ? raw : XLSX.utils.sheet_to_json(XLSX.read(buf, { type: "array" }).Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: true });
      $("#map").innerHTML = "";
      ["#defDate", "#defMat"].forEach((q) => ($(q).closest(".field").hidden = true));
      return viewSalesforceImport(headers, raw2.slice(hi + 1).filter((r) => r.some((x) => String(x).trim())), file.name);
    }
    const sig = norm(headers.join("|"));
    const saved = (store.get("ss_maps") || {})[sig];
    const mapping = {};
    for (const [k, , syn] of FIELDS) {
      if (saved && saved[k] !== undefined) { mapping[k] = saved[k]; continue; }
      const nh = headers.map(norm);
      let idx = nh.findIndex((h) => syn.includes(h));
      if (idx < 0) idx = nh.findIndex((h) => syn.some((s) => s.length > 2 && h.includes(s)));
      mapping[k] = idx;
    }
    $("#map").innerHTML = `<h2>Association des colonnes <span class="muted small">(${rows.length} lignes lues, feuille « ${esc(wb.SheetNames[0])} »)</span></h2>
      <div class="card"><div class="grid grid-2">${FIELDS.map(([k, l]) => `<div class="field"><label>${l}</label><select data-k="${k}"><option value="-1">— ignorer —</option>${headers.map((h, i) => `<option value="${i}" ${mapping[k] === i ? "selected" : ""}>${esc(h)}</option>`).join("")}</select></div>`).join("")}</div></div>`;
    $$("#map select").forEach((sel) => (sel.onchange = () => { mapping[sel.dataset.k] = +sel.value; preview(); }));
    $("#defDate").onchange = preview; $("#defMat").onchange = preview;
    function build() {
      const g = (r, k) => (mapping[k] >= 0 ? r[mapping[k]] : "");
      return rows.map((r) => {
        const mat = g(r, "materiau") || $("#defMat").value;
        const m = cfg.materials.find((x) => norm(x.name) === norm(mat)) || cfg.materials.find((x) => x.name === $("#defMat").value);
        const surface = num(g(r, "surfacePrevue"));
        const sacs = num(g(r, "sacsPrevus"));
        return { date: parseDate(g(r, "date")) || (mapping.date >= 0 ? null : $("#defDate").value), ref: String(g(r, "ref")).trim(), client: String(g(r, "client")).trim(), adresse: String(g(r, "adresse")).trim(), ville: String(g(r, "ville")).trim(), equipe: String(g(r, "equipe")).trim(), surfacePrevue: surface, materiau: m?.name || mat, sacsPrevus: sacs ?? (surface !== null && m ? Math.ceil(surface * m.bagsPerM2) : null) };
      });
    }
    function preview() {
      const data = build();
      const bad = data.filter((d) => !d.date || (!d.ref && !d.client && !d.adresse)).length;
      const teams = [...new Set(data.map((d) => d.equipe).filter(Boolean))];
      $("#preview").innerHTML = `<h2>Aperçu</h2>
        <p class="small">${data.length} chantiers · ${teams.length} équipe(s) : ${esc(teams.join(", ") || "aucune")} · ${n0(data.reduce((s, d) => s + (d.sacsPrevus || 0), 0))} sacs prévus ${bad ? `· <span class="pos">${bad} ligne(s) sans date ou sans identification, ignorées</span>` : ""}</p>
        ${data.some((d) => d.surfacePrevue === null) ? `<p class="small pos">Attention : certaines lignes n'ont pas de surface prévue.</p>` : ""}
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Réf</th><th>Client</th><th>Adresse</th><th>Ville</th><th>Équipe</th><th class="num">m²</th><th>Matière</th><th class="num">Sacs prévus</th></tr></thead><tbody>
        ${data.slice(0, 12).map((d) => `<tr><td>${d.date ? fmtDate(d.date) : '<span class="pos">?</span>'}</td><td>${esc(d.ref)}</td><td>${esc(d.client)}</td><td>${esc(d.adresse)}</td><td>${esc(d.ville)}</td><td>${esc(d.equipe)}</td><td class="num">${n0(d.surfacePrevue)}</td><td>${esc(d.materiau)}</td><td class="num">${n0(d.sacsPrevus)}</td></tr>`).join("")}
        </tbody></table></div>${data.length > 12 ? `<p class="muted small">… et ${data.length - 12} autres lignes.</p>` : ""}
        <p style="margin-top:12px"><button id="go">Importer ${data.length - bad} chantiers</button></p>`;
      $("#go").onclick = async () => {
        const maps = store.get("ss_maps") || {}; maps[sig] = mapping; store.set("ss_maps", maps);
        $("#go").disabled = true; $("#go").textContent = "Import en cours…";
        try {
          const todo = data.filter((d) => d.date), r = { created: 0, updated: 0, moved: 0, locked: 0, skipped: [] };
          for (let i = 0; i < todo.length; i += 120) {
            const x = await api("import", { method: "POST", body: { rows: todo.slice(i, i + 120) } });
            for (const k of ["created", "updated", "moved", "locked"]) r[k] += x[k] || 0;
            r.skipped.push(...(x.skipped || []));
          }
          $("#preview").innerHTML = `<div class="card"><h3>Import terminé</h3><p>${r.created} créé(s), ${r.updated} mis à jour${r.locked ? `, ${r.locked} déjà validé(s) non modifié(s)` : ""}${r.skipped.length ? `, ${r.skipped.length} ignoré(s)` : ""}.</p>
            ${r.skipped.length ? `<p class="small muted">${r.skipped.slice(0, 10).map((s) => `ligne ${s.ligne} : ${esc(s.raison)}`).join(" · ")}</p>` : ""}<a class="btn" href="#/">Voir le tableau de bord</a></div>`;
          $("#map").innerHTML = ""; $("#file").value = "";
        } catch (err) { toast(err.message, true); $("#go").disabled = false; $("#go").textContent = "Réessayer l'import"; }
      };
    }
    preview();
  };
}
// ---------- import Salesforce (export « Export Global … ») ----------
const isSalesforce = (h) => { const n = h.map(norm); return n.includes(norm("Type d'opportunité-travail")) && n.includes(norm("Produit à Poser")) && n.some((x) => x.startsWith("numero de rendez-vous")); };
const parisFmt = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
function sfDate(v) {
  if (v === "" || v === null || v === undefined) return null;
  if (typeof v === "number") return v > 20000 && v < 90000 ? parisFmt.format(new Date(Math.round((v - 25569) * 864e5))) : null;
  if (v instanceof Date) return parisFmt.format(v);
  return parseDate(v);
}
function parseProduit(p, materials) {
  const raw = String(p || "").toUpperCase().replace(/^FORFAIT\s+/, "").split("/")[0].replace(/\s+/g, "");
  const m = raw.match(/^(.*?)R(\d+(?:[.,]\d+)?)$/);
  const code = m ? m[1] : raw;
  const R = m ? Number(m[2].replace(",", ".")) : null;
  const mat = code ? materials.find((x) => (x.codes || []).some((c) => code.startsWith(c))) : null;
  return { raw, code, R, mat };
}
const teamLabel = (s) => { const v = String(s || "").trim(); if (!v) return ""; const m = v.match(/equipe\s*(\d+)/i); return m ? `Equipe ${m[1]}` : v.split("@")[0]; };

function classifySalesforce(headers, rows, cfg) {
  const ix = {}; headers.forEach((h, i) => (ix[norm(h)] ||= []).push(i));
  const col = (name, n = 0) => (ix[norm(name)] || [])[n];
  const C = {
    compte: col("Nom du compte: Nom du compte"), activite: col("Activité du compte"), clientFinal: col("Nom du Client final"), devis: col("Devis: Nom du devis"),
    cp: col("Code postal d'expédition"), commande: col("Numéro de commande"), etat: col("Etat de suivi"), surface: col("Somme quantité quantifiable"),
    statutOE: col("Statut des ordres d'exécutions"), dateReal: col("Date de réalisation chantier"), dateReal2: col("Date de réalisation"), rdv: col("Numéro de rendez-vous"),
    debut: col("Début planifié"), statutRdv: col("Statut", 1), produit: col("Produit à Poser"), ressource: col("Ressource de service: Nom"), type: col("Type d'opportunité-travail"),
    dateCmd: col("Date de début de la commande"),
  };
  const g = (r, k) => (C[k] === undefined ? "" : r[C[k]]);
  const types = (cfg.typesSuivis || []).map(norm);
  const out = { autreType: {}, historique: [], annule: [], planif: [], aPlanifier: [], produitsInconnus: {}, total: rows.length };
  const seen = new Set();
  rows.forEach((r, i) => {
    const typeOpp = String(g(r, "type")).trim();
    if (!types.includes(norm(typeOpp))) { out.autreType[typeOpp || "(vide)"] = (out.autreType[typeOpp || "(vide)"] || 0) + 1; return; }
    const statutRdv = String(g(r, "statutRdv")).trim(), etat = String(g(r, "etat")).trim(), statutOE = String(g(r, "statutOE")).trim();
    const datePl = sfDate(g(r, "debut")), dateReal = sfDate(g(r, "dateReal")) || sfDate(g(r, "dateReal2"));
    const devis = String(g(r, "devis"));
    const villeM = devis.match(/-(\d{2,3})-([^-]+?)(?:-|$)/);
    const prod = parseProduit(g(r, "produit"), cfg.materials);
    const surface = num(g(r, "surface"));
    const R = prod.R || 7;
    const sacs = surface && prod.mat ? Math.ceil(surface * prod.mat.bagsPerM2 * R / 7) : surface ? Math.ceil(surface * (cfg.materials[0]?.bagsPerM2 || 0.21) * R / 7) : null;
    const commande = String(g(r, "commande")).trim(), rdv = String(g(r, "rdv")).trim();
    let id = rdv || commande;
    if (seen.has(id)) id = `${commande}-${prod.raw || i}`;
    seen.add(id);
    const item = {
      ligne: i + 2, id, ref: commande, rdv, client: String(/^(maison|)$/i.test(String(g(r, "clientFinal")).trim()) ? g(r, "compte") : g(r, "clientFinal")).trim(), compte: String(g(r, "compte")).trim(),
      ville: villeM ? villeM[2].trim() : "", cp: String(g(r, "cp")).trim(), adresse: "", equipe: teamLabel(g(r, "ressource")),
      materiau: prod.mat ? prod.mat.name : (cfg.materials[0]?.name || ""), produit: String(g(r, "produit")).trim(), rValue: R, matConnue: !!prod.mat,
      surfacePrevue: surface, sacsPrevus: sacs, typeOpp, statutSF: statutRdv || statutOE, etatSuivi: etat, dateRealSF: dateReal, dateCommande: sfDate(g(r, "dateCmd")),
      date: datePl || dateReal,
    };
    if (/annul/i.test(statutRdv) || /annulation/i.test(etat)) return out.annule.push(item);
    if (item.date && item.date < cfg.dateDebut) return out.historique.push(item);
    if (!prod.mat) { const k = item.produit ? prod.code || item.produit : "(produit vide)"; out.produitsInconnus[k] = (out.produitsInconnus[k] || 0) + 1; }
    if (item.date) out.planif.push(item); else out.aPlanifier.push(item);
  });
  out.planif.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function viewSalesforceImport(headers, rows, fileName) {
  const cfg = S.config;
  const c = classifySalesforce(headers, rows, cfg);
  const t = today();
  const passes = c.planif.filter((x) => x.date < t), avenir = c.planif.filter((x) => x.date >= t);
  const sansEquipe = c.planif.filter((x) => !x.equipe).length;
  const sansSurface = [...c.planif, ...c.aPlanifier].filter((x) => !x.surfacePrevue).length;
  const sum = (a, k) => a.reduce((s, x) => s + (x[k] || 0), 0);
  const autres = Object.entries(c.autreType).sort((a, b) => b[1] - a[1]);
  const inconnus = Object.entries(c.produitsInconnus);
  const teams = [...new Set(c.planif.map((x) => x.equipe).filter(Boolean))].sort();
  const aConfirmer = [...new Set([...c.planif, ...c.aPlanifier].map((x) => cfg.materials.find((m) => m.name === x.materiau)).filter((m) => m && m.aConfirmer).map((m) => m.name))];
  $("#preview").innerHTML = `<h2>Export Salesforce reconnu <span class="muted small">(${esc(fileName)} · ${c.total} lignes)</span></h2>
    <div class="kpis">
      <div class="kpi dark"><div class="v">${c.planif.length}</div><div class="l">chantiers datés à suivre (${passes.length} depuis le ${fmtDate(cfg.dateDebut)}, ${avenir.length} à venir)</div></div>
      <div class="kpi"><div class="v">${c.aPlanifier.length}</div><div class="l">à planifier (sans date) → besoins à venir</div></div>
      <div class="kpi"><div class="v">${c.historique.length}</div><div class="l">historique (avant le ${fmtDate(cfg.dateDebut)}) ignoré</div></div>
      <div class="kpi"><div class="v">${c.annule.length}</div><div class="l">annulés ignorés</div></div>
      <div class="kpi"><div class="v">${autres.reduce((s, x) => s + x[1], 0)}</div><div class="l">autres types d'opportunité ignorés</div></div>
      <div class="kpi"><div class="v">${n0(sum(c.planif, "sacsPrevus"))}</div><div class="l">sacs prévus sur les chantiers datés</div></div>
    </div>
    ${inconnus.length ? `<ul class="alerts-list"><li class="red">Produits non reconnus (matière par défaut appliquée) : ${inconnus.map(([k, v]) => `${esc(k)} (${v})`).join(", ")}. Ajoutez leur code dans Paramètres → Matières.</li></ul>` : ""}
    ${aConfirmer.length ? `<ul class="alerts-list"><li class="orange">Rendement sacs/m² à confirmer pour : ${aConfirmer.map(esc).join(", ")} (0,21 appliqué par défaut). À régler dans Paramètres → Matières.</li></ul>` : ""}
    ${sansEquipe ? `<ul class="alerts-list"><li class="orange">${sansEquipe} chantier(s) daté(s) sans équipe affectée dans Salesforce : visibles par les responsables, pas par les équipes.</li></ul>` : ""}
    ${sansSurface ? `<ul class="alerts-list"><li class="orange">${sansSurface} dossier(s) sans surface : sacs prévus non calculés.</li></ul>` : ""}
    <p class="small">Équipes détectées : <b>${esc(teams.join(", ") || "aucune")}</b>. Les comptes équipe se rattachent automatiquement (« Equipe 1 » = Equipe1.iso@…).</p>
    <details class="small" style="margin-bottom:12px"><summary>Types d'opportunité ignorés</summary>${autres.map(([k, v]) => `${esc(k)} : ${v}`).join("<br>")}</details>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Équipe</th><th>Chantier</th><th>Statut SF</th><th>Produit</th><th class="num">m²</th><th class="num">Sacs prévus</th></tr></thead><tbody>
      ${avenir.slice(0, 15).map((d) => `<tr><td class="nw">${fmtDate(d.date)}</td><td class="nw">${esc(d.equipe || "–")}</td><td><b>${esc(d.client)}</b><div class="muted small">${esc(d.ref)} · ${esc(d.ville)} ${esc(d.cp)}</div></td><td>${esc(d.statutSF)}</td><td>${esc(d.produit)}</td><td class="num">${n0(d.surfacePrevue)}</td><td class="num">${n0(d.sacsPrevus)}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">Aucun chantier à venir dans ce fichier.</td></tr>`}
    </tbody></table></div><p class="muted small">Aperçu des 15 prochains chantiers.</p>
    <div class="card" style="margin-top:12px"><div class="row"><button id="go">Importer ${c.planif.length} chantiers + ${c.aPlanifier.length} à planifier</button><span id="prog" class="muted small"></span></div>
    <div class="bar" style="margin-top:10px"><i id="progbar" style="width:0"></i></div></div>`;
  $("#go").onclick = async () => {
    const btn = $("#go"); btn.disabled = true;
    const batch = `${new Date().toISOString()}_${S.user.login}`;
    const tot = { created: 0, updated: 0, moved: 0, unchanged: 0, locked: 0, skipped: [] };
    const chunks = []; for (let i = 0; i < c.planif.length; i += 120) chunks.push(c.planif.slice(i, i + 120));
    try {
      for (let k = 0; k < chunks.length; k++) {
        $("#prog").textContent = `Paquet ${k + 1}/${chunks.length}…`;
        let r;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { r = await api("import", { method: "POST", body: { rows: chunks[k], batch } }); break; }
          catch (err) { if (attempt === 2) throw err; await new Promise((res) => setTimeout(res, 1500)); }
        }
        for (const key of ["created", "updated", "moved", "unchanged", "locked"]) tot[key] += r[key] || 0;
        tot.skipped.push(...(r.skipped || []));
        $("#progbar").style.width = `${Math.round(((k + 1) / (chunks.length + 1)) * 100)}%`;
      }
      $("#prog").textContent = "Mise à jour des dossiers à planifier…";
      await api("backlog", { method: "PUT", body: { items: c.aPlanifier.map(({ ligne, ...x }) => x) } });
      $("#progbar").style.width = "100%";
      $("#preview").innerHTML = `<div class="card"><h3>Import terminé</h3>
        <p><b>${tot.created}</b> nouveaux chantiers, <b>${tot.updated}</b> mis à jour, <b>${tot.moved}</b> replanifiés, ${tot.unchanged} inchangés${tot.locked ? `, ${tot.locked} validés non modifiés` : ""}${tot.skipped.length ? `, ${tot.skipped.length} ignorés` : ""}.</p>
        <p>${c.aPlanifier.length} dossiers à planifier enregistrés pour le calcul des besoins.</p>
        <div class="row"><a class="btn" href="#/">Voir le tableau de bord</a><a class="btn btn-secondary" href="#/stock">Voir les besoins en sacs</a></div></div>`;
      $("#map").innerHTML = ""; $("#file").value = "";
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = "Réessayer l'import (les paquets déjà passés ne seront pas dupliqués)"; }
  };
}

function parseDate(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date && !isNaN(v)) return new Date(v.getTime() - v.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  if (typeof v === "number" && v > 30000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/); if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return null;
}

// ---------- stock ----------
async function viewStock() {
  const cfg = S.config;
  app.innerHTML = `<h1>Stock</h1><p class="muted small">Stock officiel = entrées − déclaré Salesforce (chantiers validés) − soufflé (chantiers saisis non encore validés). Stock 2 = déclaré − soufflé. Stock physique théorique = officiel + stock 2 = entrées − soufflé. Les sorties sont imputées au dépôt de départ indiqué par l'équipe.</p>
    <div id="stk"><p class="muted">Chargement…</p></div>
    <h2>Besoins à venir</h2><p class="muted small">Sacs prévus sur les chantiers planifiés non encore saisis (60 prochains jours) et sur les dossiers Salesforce encore à planifier — pour passer la commande mensuelle avant le 10.</p>
    <div id="besoins"><p class="muted">Chargement…</p></div>
    <h2>Saisir un mouvement</h2>
    <form class="card" id="mf"><div class="inline-fields">
      <div class="field"><label>Type</label><select name="type"><option value="livraison">Livraison</option><option value="initial">Stock initial</option><option value="inventaire">Inventaire (comptage)</option><option value="ajustement">Ajustement (+/−)</option></select></div>
      <div class="field"><label>Dépôt</label><select name="depot">${cfg.depots.map((d) => `<option>${esc(d)}</option>`).join("")}</select></div>
      <div class="field"><label>Matière</label><select name="materiau">${cfg.materials.map((m) => `<option>${esc(m.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Quantité (sacs)</label><input name="qty" inputmode="numeric" required></div>
      <div class="field"><label>Date</label><input type="date" name="date" value="${today()}" required></div>
      <div class="field" style="flex:2 1 200px"><label>Note</label><input name="note" placeholder="N° BL, semi…"></div>
      <button>Enregistrer</button></div></form>
    <h2>Historique des mouvements</h2><div id="mvs"></div>`;
  const load = async () => {
    const [stock, mvs, futurs, backlog] = await Promise.all([api("stock"), api("mouvements"), api(`chantiers?from=${today()}&to=${addDays(today(), 60)}`), api("backlog")]);
    const bes = {};
    const b = (m) => (bes[m] ||= { m, nPl: 0, sPl: 0, nAp: 0, sAp: 0 });
    futurs.filter((c) => !c.saisie).forEach((c) => { const r = b(c.materiau); r.nPl++; r.sPl += c.sacsPrevus || 0; });
    (backlog.items || []).forEach((c) => { const r = b(c.materiau); r.nAp++; r.sAp += c.sacsPrevus || 0; });
    const phys = (m) => stock.filter((r) => r.materiau === m).reduce((s, r) => s + r.physique, 0);
    const rowsB = Object.values(bes).sort((x, y) => (y.sPl + y.sAp) - (x.sPl + x.sAp));
    $("#besoins").innerHTML = rowsB.length ? `<div class="table-wrap"><table><thead><tr><th>Matière</th><th class="num">Chantiers planifiés</th><th class="num">Sacs planifiés</th><th class="num">Dossiers à planifier</th><th class="num">Sacs à planifier</th><th class="num">Besoin total</th><th class="num">Stock physique</th><th class="num">Manque</th></tr></thead><tbody>
      ${rowsB.map((r) => { const tot = r.sPl + r.sAp, ph = phys(r.m), manque = Math.max(0, tot - ph); return `<tr><td><b>${esc(r.m)}</b></td><td class="num">${r.nPl}</td><td class="num">${n0(r.sPl)}</td><td class="num">${r.nAp}</td><td class="num">${n0(r.sAp)}</td><td class="num"><b>${n0(tot)}</b></td><td class="num">${n0(ph)}</td><td class="num ${manque ? "pos" : ""}">${manque ? n0(manque) : "–"}</td></tr>`; }).join("")}
      </tbody></table></div><p class="muted small">Dossiers à planifier mis à jour le ${backlog.at ? fmtDateTime(backlog.at) : "–"} (dernier import Salesforce).</p>` : `<p class="muted">Aucun besoin : importez la planif Salesforce.</p>`;
    const tot = (k) => stock.reduce((s, r) => s + (r[k] || 0), 0);
    $("#stk").innerHTML = `<div class="kpis"><div class="kpi"><div class="v">${n0(tot("officiel"))}</div><div class="l">stock officiel total</div></div>
      <div class="kpi ${tot("stock2") ? "warn" : ""}"><div class="v">${n0(tot("stock2"))}</div><div class="l">stock 2 total</div></div>
      <div class="kpi"><div class="v">${n0(tot("physique"))}</div><div class="l">physique théorique</div></div></div>
      <div class="table-wrap"><table><thead><tr><th>Dépôt</th><th>Matière</th><th class="num">Entrées</th><th class="num">Soufflé</th><th class="num">Déclaré SF</th><th class="num">Stock officiel</th><th class="num">Stock 2</th><th class="num">Physique théorique</th><th>Dernier inventaire</th></tr></thead><tbody>
      ${stock.map((r) => `<tr><td><b>${esc(r.depot)}</b></td><td>${esc(r.materiau)}</td><td class="num">${n0(r.entrees)}</td><td class="num">${n0(r.souffleTotal)}</td><td class="num">${n0(r.declareValide)}</td>
        <td class="num"><b>${n0(r.officiel)}</b></td><td class="num">${n0(r.stock2)}</td><td class="num">${n0(r.physique)}</td>
        <td>${r.inventaire ? `${fmtDate(r.inventaire.date)} : ${n0(r.inventaire.compte)} comptés / ${n0(r.inventaire.theorique)} théoriques <span class="badge ${Math.abs(r.inventaire.ecart) > 5 ? "b-bad" : "b-ok"}">${r.inventaire.ecart > 0 ? "+" : ""}${n0(r.inventaire.ecart)}</span>` : '<span class="muted">—</span>'}</td></tr>`).join("")}
      </tbody></table></div>`;
    const label = { livraison: "Livraison", initial: "Stock initial", inventaire: "Inventaire", ajustement: "Ajustement" };
    $("#mvs").innerHTML = mvs.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Dépôt</th><th>Matière</th><th class="num">Qté</th><th>Note</th><th>Par</th><th></th></tr></thead><tbody>
      ${mvs.map((x) => `<tr><td>${fmtDate(x.date)}</td><td>${label[x.type]}</td><td>${esc(x.depot)}</td><td>${esc(x.materiau)}</td><td class="num">${n0(x.qty)}</td><td>${esc(x.note)}</td><td class="small muted">${esc(x.byName)}</td><td>${isAdmin() ? `<button class="btn-ghost sm" data-del="${esc(x.id)}">Suppr.</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Aucun mouvement. Commencez par le stock initial de chaque dépôt.</p>`;
    $$("[data-del]").forEach((b) => (b.onclick = async () => { if (!confirm("Supprimer ce mouvement ?")) return; await api(`mouvements/${b.dataset.del}`, { method: "DELETE" }); load(); }));
  };
  $("#mf").onsubmit = async (e) => {
    e.preventDefault();
    try { await api("mouvements", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); toast("Mouvement enregistré"); e.target.qty.value = ""; e.target.note.value = ""; load(); }
    catch (err) { toast(err.message, true); }
  };
  await load();
}

// ---------- paramètres (admin) ----------
async function viewParams() {
  const cfg = S.config;
  const users = await api("users");
  const roleL = { admin: "Administrateur", resp: "Responsable habilité", equipe: "Équipe" };
  app.innerHTML = `<h1>Paramètres</h1>
    <h2>Comptes</h2>
    <div class="table-wrap"><table><thead><tr><th>Identifiant</th><th>Nom</th><th>Rôle</th><th>Équipe (planif)</th><th>Actif</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td><b>${esc(u.login)}</b></td><td>${esc(u.name)}</td><td>${roleL[u.role]}</td><td>${esc(u.team)}</td><td>${u.active !== false ? "Oui" : '<span class="pos">Non</span>'}</td>
      <td class="row" style="gap:6px"><button class="btn-ghost sm" data-edit="${esc(u.login)}">Modifier</button>${u.login !== S.user.login ? `<button class="btn-ghost sm" data-deluser="${esc(u.login)}">Suppr.</button>` : ""}</td></tr>`).join("")}
    </tbody></table></div>
    <form class="card" id="uf" style="margin-top:12px"><h3 id="ufTitle">Nouveau compte</h3><div class="inline-fields">
      <div class="field"><label>Identifiant</label><input name="login" required autocapitalize="off"></div>
      <div class="field"><label>Nom affiché</label><input name="name" required></div>
      <div class="field"><label>Rôle</label><select name="role"><option value="equipe">Équipe</option><option value="resp">Responsable habilité</option><option value="admin">Administrateur</option></select></div>
      <div class="field"><label>Nom d'équipe (exactement comme dans la planif)</label><input name="team" list="teamList"></div>
      <div class="field"><label>Mot de passe <span id="pwHint">(6 caract. min.)</span></label><input name="password" type="text" autocomplete="new-password"></div>
      <div class="field" style="flex:0 0 auto"><label><input type="checkbox" name="active" checked style="width:auto"> Actif</label></div>
      <button>Enregistrer</button><button type="button" class="btn-ghost" id="ufReset">Annuler</button></div><datalist id="teamList"></datalist></form>
    <h2>Règles de calcul</h2>
    <form class="card" id="cf">
      <div class="inline-fields">
        <div class="field"><label>Épaisseur totale exigée (cm)</label><input name="targetCm" inputmode="decimal" value="${cfg.targetCm}"></div>
        <div class="field"><label>Seuil alerte orange (%)</label><input name="warn" inputmode="numeric" value="${cfg.thresholds.warn}"></div>
        <div class="field"><label>Seuil alerte rouge (%)</label><input name="alert" inputmode="numeric" value="${cfg.thresholds.alert}"></div>
        <div class="field"><label>Tolérance Salesforce (± %)</label><input name="sfMaxGap" inputmode="numeric" value="${cfg.sfMaxGap}"></div>
      </div>
      <div class="field" style="margin-top:12px"><label>Dépôts (séparés par des virgules)</label><input name="depots" value="${esc(cfg.depots.join(", "))}"></div>
      <h3 style="margin-top:16px">Import Salesforce</h3>
      <div class="inline-fields">
        <div class="field"><label>Date de démarrage du suivi (avant = historique)</label><input type="date" name="dateDebut" value="${esc(cfg.dateDebut || "")}"></div>
        <div class="field" style="flex:2 1 300px"><label>Types d'opportunité suivis (un par ligne)</label><textarea name="typesSuivis" rows="2">${esc((cfg.typesSuivis || []).join("\n"))}</textarea></div>
      </div>
      <h3 style="margin-top:16px">Matières — rendement pour R7 (sacs par m²) et codes produit Salesforce</h3>
      <p class="muted small">Le code produit Salesforce donne la matière et le R : SUPAR7 → code SUPA, R7. Sacs prévus = surface × rendement R7 × R ÷ 7, arrondi au sac supérieur.</p>
      <div id="mats">${cfg.materials.map((m) => matRow(m)).join("")}</div>
      <p><button type="button" class="btn-secondary sm" id="addMat">+ Matière</button></p>
      <p class="muted small">Exemple : 21 sacs pour 100 m² en R7 = 0,21. Une matière marquée « à confirmer » s'affiche en alerte à l'import tant que son rendement n'est pas validé.</p>
      <button>Enregistrer les règles</button>
    </form>
    <h2>Maintenance</h2>
    <div class="card"><p class="small">Repartir propre : supprime tous les chantiers importés <b>qui n'ont pas encore de saisie équipe</b>. Les chantiers saisis ou validés, le stock et les comptes ne sont pas touchés. Réimportez ensuite l'export Salesforce.</p>
    <button type="button" class="btn-danger" id="purge">Vider les chantiers non saisis</button></div>`;
  api(`chantiers?from=${addDays(today(), -60)}&to=${addDays(today(), 30)}`).then((items) => { $("#teamList").innerHTML = [...new Set(items.map((c) => c.equipe).filter(Boolean))].map((t) => `<option value="${esc(t)}">`).join(""); }).catch(() => {});
  const uf = $("#uf");
  const reset = () => { uf.reset(); uf.login.readOnly = false; $("#ufTitle").textContent = "Nouveau compte"; $("#pwHint").textContent = "(6 caract. min.)"; };
  $("#ufReset").onclick = reset;
  $$("[data-edit]").forEach((b) => (b.onclick = () => {
    const u = users.find((x) => x.login === b.dataset.edit);
    uf.login.value = u.login; uf.login.readOnly = true; uf.name.value = u.name; uf.role.value = u.role; uf.team.value = u.team || ""; uf.active.checked = u.active !== false; uf.password.value = "";
    $("#ufTitle").textContent = `Modifier ${u.login}`; $("#pwHint").textContent = "(laisser vide pour ne pas changer)"; uf.scrollIntoView({ behavior: "smooth" });
  }));
  $$("[data-deluser]").forEach((b) => (b.onclick = async () => { if (!confirm(`Supprimer le compte ${b.dataset.deluser} ?`)) return; try { await api(`users/${b.dataset.deluser}`, { method: "DELETE" }); render(); } catch (err) { toast(err.message, true); } }));
  uf.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(uf)); d.active = uf.active.checked;
    try { await api("users", { method: "POST", body: d }); toast("Compte enregistré"); render(); } catch (err) { toast(err.message, true); }
  };
  $("#purge").onclick = async () => {
    if (!confirm("Supprimer tous les chantiers importés non saisis ? Les saisies, validations et le stock sont conservés.")) return;
    try { const r = await api("chantiers/non-saisis", { method: "DELETE" }); toast(`${r.deleted} chantiers supprimés`); } catch (err) { toast(err.message, true); }
  };
  $("#addMat").onclick = () => $("#mats").insertAdjacentHTML("beforeend", matRow({ name: "", bagsPerM2: "" }));
  $("#mats").onclick = (e) => { if (e.target.matches("[data-rm]")) e.target.closest(".inline-fields").remove(); };
  $("#cf").onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    const body = {
      targetCm: num(f.targetCm.value), thresholds: { warn: num(f.warn.value), alert: num(f.alert.value) }, sfMaxGap: num(f.sfMaxGap.value),
      depots: f.depots.value.split(",").map((s) => s.trim()).filter(Boolean),
      materials: $$("#mats .inline-fields").map((r) => ({ id: r.dataset.id || undefined, name: $("[name=mname]", r).value.trim(), bagsPerM2: num($("[name=mbags]", r).value), codes: $("[name=mcodes]", r).value, aConfirmer: $("[name=mconf]", r).checked })).filter((m) => m.name),
      dateDebut: f.dateDebut.value, typesSuivis: f.typesSuivis.value.split("\n").map((x) => x.trim()).filter(Boolean),
    };
    if (!body.materials.length || !body.depots.length) return toast("Au moins un dépôt et une matière", true);
    try { S.config = await api("config", { method: "PUT", body }); toast("Règles enregistrées"); } catch (err) { toast(err.message, true); }
  };
}
const matRow = (m) => `<div class="inline-fields" data-id="${esc(m.id || "")}" style="margin-bottom:10px"><div class="field" style="flex:2 1 180px"><label>Nom</label><input name="mname" value="${esc(m.name)}"></div><div class="field" style="flex:2 1 180px"><label>Codes produit SF</label><input name="mcodes" value="${esc((m.codes || []).join(", "))}" placeholder="SUPA, SUPACOVER+"></div><div class="field" style="flex:1 1 110px"><label>Sacs / m² (R7)</label><input name="mbags" inputmode="decimal" value="${esc(String(m.bagsPerM2 ?? "").replace(".", ","))}"></div><div class="field" style="flex:0 0 auto"><label><input type="checkbox" name="mconf" style="width:auto" ${m.aConfirmer ? "checked" : ""}> À confirmer</label></div><button type="button" class="btn-ghost sm" data-rm>Retirer</button></div>`;

render();
