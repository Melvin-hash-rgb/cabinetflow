"use strict";
/* ============================================================
   CabinetFlow — application (version publique, Supabase)
   Le logiciel des cabinets comptables du Cameroun.

   Règles du produit (non négociables) :
   - Personne n'entre sans compte : porte d'entrée d'abord.
   - Chaque cabinet est un espace fermé : on ne voit QUE les
     données des cabinets dont on est membre (RLS côté serveur).
   - Le catalogue des formules est fixé par le propriétaire ;
     le cabinet choisit, paie, déclare — le propriétaire valide.
   - Cycle de vie : essai 14 jours → actif → grâce 7 jours →
     lecture seule (données conservées).
   - Les données du cabinet lui appartiennent : export CSV
     à tout moment.
   ============================================================ */

/* ---------------- Constantes métier ---------------- */
const PLANS = {
  essentiel: { name: "Essentiel", price: 10000, features: ["Jusqu'à 3 utilisateurs", "Clients et dossiers illimités", "Suivi des documents et de leurs statuts", "Calendrier fiscal camerounais automatique"] },
  pro:       { name: "Pro",       price: 25000, features: ["Jusqu'à 10 utilisateurs", "Tout l'Essentiel", "Fichiers joints aux dossiers", "Priorités et responsables par dossier"] },
  premium:   { name: "Premium",   price: 45000, features: ["Utilisateurs illimités", "Tout le Pro", "Plusieurs services ou bureaux", "Accompagnement prioritaire"] }
};
const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const DSF_BY_CENTER = { "DGE": [2, 15], "CIME": [3, 15], "CDI": [4, 15] }; // [mois (0-11), jour]

/* ---------------- Utilitaires ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtNum(n) {
  if (n === null || n === undefined || n === "") return "";
  const v = Number(n);
  if (Number.isNaN(v)) return esc(n);
  return v.toLocaleString("fr-FR");
}
function fmtMoney(n) { return fmtNum(n) + " FCFA"; }

/* Dates au format ISO local (aaaa-mm-jj), sans décalage de fuseau */
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const j = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + j;
}
function todayStr() { return toISODate(new Date()); }
function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return toISODate(d);
}
function addMonths(iso, n) {
  const d = new Date(iso + "T12:00:00");
  d.setMonth(d.getMonth() + n);
  return toISODate(d);
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T12:00:00");
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add("hidden"), 3200);
}

function formMsg(id, text, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  el.className = "form-msg" + (text ? (ok ? " ok" : " error") : "");
}

function authErrorFr(error) {
  const m = (error && error.message) || "";
  if (/invalid login credentials/i.test(m)) return "Courriel ou mot de passe incorrect.";
  if (/email not confirmed/i.test(m)) return "Ton courriel n'est pas encore confirmé : ouvre le courriel de confirmation reçu, puis reconnecte-toi.";
  if (/already registered/i.test(m)) return "Ce courriel a déjà un compte : connecte-toi plutôt.";
  if (/password should be at least/i.test(m)) return "Le mot de passe doit avoir au moins 6 caractères.";
  if (/network|fetch/i.test(m)) return "Problème de connexion internet : vérifie ta connexion, puis réessaie.";
  return m || "Une erreur est arrivée. Réessaie.";
}

/* ---------------- État global ---------------- */
let sb = null;                 // client Supabase
let currentUser = null;        // utilisateur connecté
let myMemberships = [];        // mes appartenances (avec cabinet joint)
let pendingInvites = [];       // invitations pas encore réclamées
let currentCabinet = null;     // cabinet ouvert
let currentRole = null;        // responsable / employe
let access = null;             // état d'accès calculé du cabinet ouvert
let data = { clients: [], dossiers: [], documents: [], deadlines: [], payments: [], members: [] };
let docFileData = null;        // fichier joint choisi pour le document en cours d'édition
let docFileName = "";

/* ---------------- Cycle de vie de l'abonnement ---------------- */
function computeAccess(cab) {
  const today = todayStr();
  if (cab.period_end) {
    if (today <= cab.period_end) return { state: "actif", end: cab.period_end };
    if (today <= addDays(cab.period_end, 7)) return { state: "grace", end: addDays(cab.period_end, 7), baseEnd: cab.period_end };
    return { state: "suspendu" };
  }
  if (cab.trial_end) {
    if (today <= cab.trial_end) return { state: "essai", end: cab.trial_end };
    if (today <= addDays(cab.trial_end, 7)) return { state: "grace", end: addDays(cab.trial_end, 7), baseEnd: cab.trial_end };
    return { state: "suspendu" };
  }
  return { state: "suspendu" };
}
function isReadOnly() { return !access || access.state === "suspendu"; }

function guardWrite() {
  if (isReadOnly()) {
    toast("🔒 Cabinet en lecture seule : déclare un paiement pour réactiver l'écriture.");
    return false;
  }
  return true;
}

function renderAccessBanner() {
  const b = $("#access-banner");
  if (!currentCabinet || !access) { b.classList.add("hidden"); return; }
  b.classList.remove("hidden", "warn", "blocked", "ok");
  if (access.state === "essai") {
    b.classList.add("ok");
    b.textContent = "🎁 Essai gratuit en cours — jusqu'au " + fmtDate(access.end) + ". Profites-en pour tout essayer.";
  } else if (access.state === "actif") {
    b.classList.add("ok");
    b.textContent = "✅ Abonnement actif — formule " + PLANS[currentCabinet.plan].name + ", jusqu'au " + fmtDate(access.end) + ".";
  } else if (access.state === "grace") {
    b.classList.add("warn");
    b.textContent = "⚠️ Période terminée le " + fmtDate(access.baseEnd) + " — période de grâce jusqu'au " + fmtDate(access.end) + ". Déclare ton paiement (page Abonnement) pour continuer sans interruption.";
  } else {
    b.classList.add("blocked");
    b.textContent = "🔒 Cabinet en lecture seule : tes données sont conservées, mais tu ne peux plus rien ajouter ni modifier. Déclare un paiement (page Abonnement) pour réactiver ton cabinet.";
  }
  /* En lecture seule, on désactive les formulaires d'écriture — sauf la déclaration de paiement. */
  $$("#view-app form").forEach((f) => {
    if (f.id === "form-pay" || f.id === "form-dossier-filter") return;
    f.querySelectorAll("button[type=submit]").forEach((btn) => { btn.disabled = isReadOnly(); });
  });
}

/* ---------------- Vues principales ---------------- */
function showView(id) {
  ["view-loading", "view-config", "view-auth", "view-setup", "view-app"].forEach((v) => {
    const el = document.getElementById(v);
    if (el) el.classList.toggle("hidden", v !== id);
  });
  /* Démarrage réussi : on le signale au watchdog de index.html (qui affiche
     une aide après 8 s si aucun écran n'est apparu) et on cache cette aide. */
  window.__cfStarted = true;
  const slow = $("#slow-note");
  if (slow) slow.classList.add("hidden");
}

function showPage(name) {
  $$(".page").forEach((p) => p.classList.add("hidden"));
  const page = document.getElementById("page-" + name);
  if (page) page.classList.remove("hidden");
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  if (name === "proprietaire") renderOwner();
  window.scrollTo({ top: 0 });
}

/* ============================================================
   AUTHENTIFICATION
   ============================================================ */
function switchAuthTab(which) {
  $("#tab-login").classList.toggle("active", which === "login");
  $("#tab-signup").classList.toggle("active", which === "signup");
  $("#form-login").classList.toggle("hidden", which !== "login");
  $("#form-signup").classList.toggle("hidden", which !== "signup");
}

async function handleLogin(e) {
  e.preventDefault();
  formMsg("login-msg", "");
  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { formMsg("login-msg", authErrorFr(error)); return; }
  /* En cas de succès, onAuthStateChange prend le relais. */
}

async function handleSignup(e) {
  e.preventDefault();
  formMsg("signup-msg", "");
  const email = $("#signup-email").value.trim();
  const p1 = $("#signup-password").value;
  const p2 = $("#signup-password2").value;
  if (p1 !== p2) { formMsg("signup-msg", "Les deux mots de passe ne sont pas identiques."); return; }
  const { data: res, error } = await sb.auth.signUp({ email, password: p1 });
  if (error) { formMsg("signup-msg", authErrorFr(error)); return; }
  if (!res.session) {
    formMsg("signup-msg", "✅ Compte créé ! Vérifie ton courriel pour confirmer ton compte, puis connecte-toi.", true);
    switchAuthTab("login");
    formMsg("login-msg", "Compte créé : confirme ton courriel, puis connecte-toi ici.", true);
    return;
  }
  /* Session ouverte : onAuthStateChange prend le relais. */
}

async function handleLogout() {
  await sb.auth.signOut();
  currentUser = null; myMemberships = []; pendingInvites = [];
  currentCabinet = null; currentRole = null; access = null;
  showView("view-auth");
}

/* ============================================================
   MES CABINETS — choix, invitations, création
   ============================================================ */
async function loadMyCabinets() {
  /* Réclamer les invitations en attente (lignes créées par un
     responsable avec mon courriel, sans user_id). */
  try {
    await sb.from("cf_memberships")
      .update({ user_id: currentUser.id })
      .is("user_id", null)
      .ilike("user_email", currentUser.email);
  } catch (e) { /* si la réclamation échoue, l'invitation restera visible ci-dessous */ }

  const mine = await sb.from("cf_memberships")
    .select("*, cabinet:cf_cabinets(*)")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: true });
  myMemberships = (mine.data || []).filter((m) => m.cabinet);

  const pending = await sb.from("cf_memberships")
    .select("*, cabinet:cf_cabinets(*)")
    .is("user_id", null)
    .ilike("user_email", currentUser.email);
  pendingInvites = (pending.data || []).filter((m) => m.cabinet);
}

function showSetup() {
  showView("view-setup");
  $("#setup-hello").textContent = "Connecté avec " + currentUser.email + " — choisis ton cabinet, ou crée l'espace du tien.";

  const invBlock = $("#invites-block");
  if (pendingInvites.length) {
    invBlock.classList.remove("hidden");
    $("#invites-list").innerHTML = pendingInvites.map((m) =>
      '<div class="item-card"><h4>' + esc(m.cabinet.name) + "</h4>" +
      "<p>" + esc(m.cabinet.city || "") + " · Rôle proposé : <strong>" + (m.role === "responsable" ? "Responsable" : "Employé") + "</strong></p>" +
      '<div class="item-actions"><button type="button" class="btn-small gold" data-join="' + m.id + '">Rejoindre ce cabinet</button></div></div>'
    ).join("");
    $$("#invites-list [data-join]").forEach((btn) =>
      btn.addEventListener("click", () => joinInvite(btn.dataset.join)));
  } else {
    invBlock.classList.add("hidden");
  }

  const myBlock = $("#my-cabinets-block");
  if (myMemberships.length) {
    myBlock.classList.remove("hidden");
    $("#my-cabinets-list").innerHTML = myMemberships.map((m) => {
      const a = computeAccess(m.cabinet);
      const badge = a.state === "actif" ? '<span class="badge green">Actif</span>'
        : a.state === "essai" ? '<span class="badge blue">Essai gratuit</span>'
        : a.state === "grace" ? '<span class="badge gold">Période de grâce</span>'
        : '<span class="badge red">Lecture seule</span>';
      return '<div class="item-card"><h4>' + esc(m.cabinet.name) + " " + badge + "</h4>" +
        "<p>" + esc(m.cabinet.city || "") + " · Ton rôle : <strong>" + (m.role === "responsable" ? "Responsable" : "Employé") + "</strong></p>" +
        '<div class="item-actions"><button type="button" class="btn-small gold" data-enter="' + m.cabinet.id + '">Ouvrir ce cabinet</button></div></div>';
    }).join("");
    $$("#my-cabinets-list [data-enter]").forEach((btn) =>
      btn.addEventListener("click", () => enterCabinet(btn.dataset.enter)));
  } else {
    myBlock.classList.add("hidden");
  }
}

async function joinInvite(membershipId) {
  const { error } = await sb.from("cf_memberships")
    .update({ user_id: currentUser.id })
    .eq("id", membershipId)
    .is("user_id", null);
  if (error) { toast("Impossible de rejoindre ce cabinet : " + authErrorFr(error)); return; }
  toast("✅ Invitation acceptée !");
  await loadMyCabinets();
  const m = myMemberships.find((x) => x.id === membershipId);
  if (m) enterCabinet(m.cabinet.id); else showSetup();
}

async function handleCreateCabinet(e) {
  e.preventDefault();
  formMsg("cab-msg", "");
  const name = $("#cab-name").value.trim();
  const city = $("#cab-city").value.trim();
  const email = $("#cab-email").value.trim();
  const phone = $("#cab-phone").value.trim();
  const trialEnd = addDays(todayStr(), 14);
  const { data: cab, error } = await sb.from("cf_cabinets")
    .insert({
      owner_user_id: currentUser.id,
      name, city, email: email || null, phone: phone || null,
      plan: "essentiel", access_status: "essai", trial_end: trialEnd
    })
    .select()
    .single();
  if (error) { formMsg("cab-msg", authErrorFr(error)); return; }
  const { error: err2 } = await sb.from("cf_memberships")
    .insert({ cabinet_id: cab.id, user_id: currentUser.id, user_email: currentUser.email, role: "responsable" });
  if (err2) { formMsg("cab-msg", "Le cabinet est créé, mais l'ajout de ton accès a échoué : " + authErrorFr(err2)); return; }
  toast("🎉 Cabinet créé ! Ton essai gratuit de 14 jours a démarré.");
  await loadMyCabinets();
  enterCabinet(cab.id);
}

/* ============================================================
   ENTRÉE DANS UN CABINET + CHARGEMENT DES DONNÉES
   ============================================================ */
async function enterCabinet(cabinetId) {
  const m = myMemberships.find((x) => x.cabinet && x.cabinet.id === cabinetId);
  if (!m) { toast("Accès introuvable à ce cabinet."); return; }
  currentCabinet = m.cabinet;
  currentRole = m.role;
  access = computeAccess(currentCabinet);
  showView("view-app");
  $("#app-cabinet-name").textContent = currentCabinet.name + (currentCabinet.city ? " · " + currentCabinet.city : "");
  $("#app-user-email").textContent = currentUser.email;
  const cfg = window.CABINETFLOW_CONFIG || {};
  $("#btn-owner").classList.toggle("hidden", !(cfg.OWNER_USER_ID && cfg.OWNER_USER_ID === currentUser.id));
  renderAccessBanner();
  await loadCabinetData();
  renderAll();
  showPage("dashboard");
}

async function loadCabinetData() {
  const cid = currentCabinet.id;
  const [clients, dossiers, documents, deadlines, payments, members] = await Promise.all([
    sb.from("cf_clients").select("*").eq("cabinet_id", cid).order("name"),
    sb.from("cf_dossiers").select("*").eq("cabinet_id", cid).order("created_at", { ascending: false }),
    sb.from("cf_documents").select("*").eq("cabinet_id", cid).order("created_at", { ascending: false }),
    sb.from("cf_deadlines").select("*").eq("cabinet_id", cid).order("due_date"),
    sb.from("cf_payments").select("*").eq("cabinet_id", cid).order("created_at", { ascending: false }),
    sb.from("cf_memberships").select("*").eq("cabinet_id", cid).order("created_at")
  ]);
  data.clients = clients.data || [];
  data.dossiers = dossiers.data || [];
  data.documents = documents.data || [];
  data.deadlines = deadlines.data || [];
  data.payments = payments.data || [];
  data.members = members.data || [];
}

function clientName(id) {
  const c = data.clients.find((x) => x.id === id);
  return c ? c.name : "—";
}
function dossierTitle(id) {
  const d = data.dossiers.find((x) => x.id === id);
  return d ? d.title : "—";
}

function fillSelect(el, items, valueKey, labelKey, emptyLabel) {
  if (!el) return;
  const current = el.value;
  let html = "";
  if (emptyLabel !== null) html += '<option value="">' + esc(emptyLabel || "— Choisir —") + "</option>";
  html += items.map((it) => '<option value="' + it[valueKey] + '">' + esc(it[labelKey]) + "</option>").join("");
  el.innerHTML = html;
  if (current && items.some((it) => it[valueKey] === current)) el.value = current;
}

function fillAllSelects() {
  fillSelect($("#filter-dossiers-client"), data.clients, "id", "name", "Tous les clients");
  fillSelect($("#do-client"), data.clients, "id", "name", null);
  fillSelect($("#doc-client"), data.clients, "id", "name", "— Aucun / à préciser —");
  fillSelect($("#gen-client"), data.clients, "id", "name", null);
  fillSelect($("#dl-client"), data.clients, "id", "name", "— Aucun —");
  const dossierItems = data.dossiers.map((d) => ({ id: d.id, label: d.title + " — " + clientName(d.client_id) }));
  fillSelect($("#doc-dossier"), dossierItems, "id", "label", "— Aucun dossier —");
}

function renderAll() {
  fillAllSelects();
  renderDashboard();
  renderClients();
  renderDossiers();
  renderDocuments();
  renderDeadlines();
  renderTeam();
  renderSubscription();
}

/* ============================================================
   TABLEAU DE BORD
   ============================================================ */
function renderDashboard() {
  const today = todayStr();
  const in7 = addDays(today, 7);
  const missingDocs = data.documents.filter((d) => d.status === "Manquant");
  const overdue = data.deadlines.filter((d) => d.due_date < today);
  const soon = data.deadlines.filter((d) => d.due_date >= today && d.due_date <= in7);
  const openDossiers = data.dossiers.filter((d) => d.status !== "Terminé");

  $("#dash-sub").textContent = currentCabinet.name + " — " + fmtDate(today) +
    " · Ton rôle : " + (currentRole === "responsable" ? "Responsable" : "Employé") + ".";

  $("#dash-counters").innerHTML =
    '<div class="counter-card"><span class="counter-num">' + data.clients.length + '</span><span class="counter-label">Clients</span></div>' +
    '<div class="counter-card"><span class="counter-num">' + openDossiers.length + '</span><span class="counter-label">Dossiers en cours</span></div>' +
    '<div class="counter-card' + (missingDocs.length ? " alert" : "") + '"><span class="counter-num">' + missingDocs.length + '</span><span class="counter-label">Documents manquants</span></div>' +
    '<div class="counter-card' + (overdue.length ? " alert" : "") + '"><span class="counter-num">' + overdue.length + '</span><span class="counter-label">Échéances en retard</span></div>' +
    '<div class="counter-card"><span class="counter-num">' + soon.length + '</span><span class="counter-label">Échéances sous 7 jours</span></div>';

  const alerts = [];
  overdue.forEach((d) => alerts.push({ cls: "red", html: "🔴 <strong>En retard depuis le " + fmtDate(d.due_date) + "</strong> — " + esc(d.title) + " (" + esc(clientName(d.client_id)) + ")" }));
  missingDocs.forEach((d) => alerts.push({ cls: "", html: "📄 <strong>Document manquant</strong> — " + esc(d.title) + " (" + esc(clientName(d.client_id)) + (d.dossier_id ? " · dossier " + esc(dossierTitle(d.dossier_id)) : "") + ")" }));
  soon.forEach((d) => alerts.push({ cls: "", html: "⏰ <strong>" + fmtDate(d.due_date) + "</strong> — " + esc(d.title) + " (" + esc(clientName(d.client_id)) + ")" }));
  $("#dash-alerts").innerHTML = alerts.length
    ? alerts.map((a) => '<div class="alert-card ' + a.cls + '">' + a.html + "</div>").join("")
    : '<div class="alert-card green">✅ Aucune alerte : aucun document manquant, aucune échéance en retard ni dans les 7 prochains jours.</div>';

  const upcoming = data.deadlines.filter((d) => d.due_date >= today).slice(0, 8);
  $("#dash-upcoming").innerHTML = upcoming.length
    ? upcoming.map((d) =>
        '<div class="item-card soon"><h4>' + esc(d.title) + '</h4><p>📅 ' + fmtDate(d.due_date) + " · " + esc(clientName(d.client_id)) + ' · <span class="badge gold">' + esc(d.kind) + "</span></p></div>"
      ).join("")
    : '<div class="empty-note">Aucune échéance à venir. Génère le calendrier fiscal d\'un client dans la page Échéances.</div>';
}

/* ============================================================
   CLIENTS
   ============================================================ */
function renderClients() {
  const box = $("#clients-list");
  if (!data.clients.length) {
    box.innerHTML = '<div class="empty-note">Aucun client pour le moment. Ajoute ton premier client avec le formulaire ci-dessous.</div>';
    return;
  }
  box.innerHTML = data.clients.map((c) => {
    const nbDossiers = data.dossiers.filter((d) => d.client_id === c.id).length;
    const nbMissing = data.documents.filter((d) => d.client_id === c.id && d.status === "Manquant").length;
    return '<div class="item-card"><h4>' + esc(c.name) +
      (nbMissing ? ' <span class="badge red">' + nbMissing + " document(s) manquant(s)</span>" : "") + "</h4>" +
      "<p>" + [c.contact, c.city, c.phone, c.email].filter(Boolean).map(esc).join(" · ") + "</p>" +
      "<p class='muted'>" + [c.niu ? "NIU : " + esc(c.niu) : "", c.tax_regime ? "Régime : " + esc(c.tax_regime) : "", c.tax_center ? "Centre : " + esc(c.tax_center) : "", c.cnps_number ? "CNPS : " + esc(c.cnps_number) : "", c.syscohada ? esc(c.syscohada) : ""].filter(Boolean).join(" · ") + "</p>" +
      "<p class='muted'>" + nbDossiers + " dossier(s)</p>" +
      '<div class="item-actions"><button type="button" class="btn-small" data-edit-client="' + c.id + '">✏️ Modifier</button>' +
      '<button type="button" class="btn-small danger" data-del-client="' + c.id + '">🗑️ Supprimer</button></div></div>';
  }).join("");
  $$("#clients-list [data-edit-client]").forEach((b) => b.addEventListener("click", () => editClient(b.dataset.editClient)));
  $$("#clients-list [data-del-client]").forEach((b) => b.addEventListener("click", () => deleteClient(b.dataset.delClient)));
}

function editClient(id) {
  const c = data.clients.find((x) => x.id === id);
  if (!c) return;
  $("#cl-id").value = c.id;
  $("#cl-name").value = c.name || "";
  $("#cl-contact").value = c.contact || "";
  $("#cl-city").value = c.city || "";
  $("#cl-phone").value = c.phone || "";
  $("#cl-email").value = c.email || "";
  $("#cl-niu").value = c.niu || "";
  $("#cl-regime").value = c.tax_regime || "";
  $("#cl-centre").value = c.tax_center || "";
  $("#cl-cnps").value = c.cnps_number || "";
  $("#cl-syscohada").value = c.syscohada || "";
  $("#cl-cancel").classList.remove("hidden");
  $("#client-form-box").open = true;
  $("#client-form-box").scrollIntoView({ behavior: "smooth" });
}

function resetClientForm() {
  $("#form-client").reset();
  $("#cl-id").value = "";
  $("#cl-cancel").classList.add("hidden");
  formMsg("cl-msg", "");
}

async function handleClientSubmit(e) {
  e.preventDefault();
  if (!guardWrite()) return;
  const id = $("#cl-id").value;
  const payload = {
    cabinet_id: currentCabinet.id,
    name: $("#cl-name").value.trim(),
    contact: $("#cl-contact").value.trim() || null,
    city: $("#cl-city").value.trim() || null,
    phone: $("#cl-phone").value.trim() || null,
    email: $("#cl-email").value.trim() || null,
    niu: $("#cl-niu").value.trim() || null,
    tax_regime: $("#cl-regime").value || null,
    tax_center: $("#cl-centre").value || null,
    cnps_number: $("#cl-cnps").value.trim() || null,
    syscohada: $("#cl-syscohada").value || null
  };
  if (!payload.name) { formMsg("cl-msg", "Le nom du client est obligatoire."); return; }
  const res = id
    ? await sb.from("cf_clients").update(payload).eq("id", id)
    : await sb.from("cf_clients").insert(payload);
  if (res.error) { formMsg("cl-msg", authErrorFr(res.error)); return; }
  toast(id ? "✅ Client modifié." : "✅ Client ajouté.");
  resetClientForm();
  await loadCabinetData(); renderAll();
}

async function deleteClient(id) {
  if (!guardWrite()) return;
  const c = data.clients.find((x) => x.id === id);
  if (!confirm("Supprimer le client « " + (c ? c.name : "") + " » ? Ses dossiers, documents et échéances seront aussi supprimés.")) return;
  const { error } = await sb.from("cf_clients").delete().eq("id", id);
  if (error) { toast(authErrorFr(error)); return; }
  toast("Client supprimé.");
  await loadCabinetData(); renderAll();
}

/* ============================================================
   DOSSIERS
   ============================================================ */
function renderDossiers() {
  const filter = $("#filter-dossiers-client").value;
  const list = filter ? data.dossiers.filter((d) => d.client_id === filter) : data.dossiers;
  const box = $("#dossiers-list");
  if (!data.clients.length) {
    box.innerHTML = '<div class="empty-note">Ajoute d\'abord un client (page Clients) : un dossier appartient toujours à un client.</div>';
    return;
  }
  if (!list.length) {
    box.innerHTML = '<div class="empty-note">Aucun dossier ici pour le moment. Crée-en un avec le formulaire ci-dessous.</div>';
    return;
  }
  const today = todayStr();
  box.innerHTML = list.map((d) => {
    const nbDocs = data.documents.filter((x) => x.dossier_id === d.id).length;
    const nbMissing = data.documents.filter((x) => x.dossier_id === d.id && x.status === "Manquant").length;
    const late = d.due_date && d.due_date < today && d.status !== "Terminé";
    return '<div class="item-card' + (late ? " overdue" : "") + '"><h4>' + esc(d.title) +
      ' <span class="badge ' + (d.status === "Terminé" ? "green" : "blue") + '">' + esc(d.status) + "</span>" +
      (nbMissing ? ' <span class="badge red">' + nbMissing + " manquant(s)</span>" : "") + "</h4>" +
      "<p>👤 " + esc(clientName(d.client_id)) + (d.due_date ? " · 📅 Échéance : " + fmtDate(d.due_date) : "") + "</p>" +
      "<p class='muted'>" + nbDocs + " document(s) suivi(s)</p>" +
      '<div class="item-actions"><button type="button" class="btn-small" data-edit-dossier="' + d.id + '">✏️ Modifier</button>' +
      '<button type="button" class="btn-small danger" data-del-dossier="' + d.id + '">🗑️ Supprimer</button></div></div>';
  }).join("");
  $$("#dossiers-list [data-edit-dossier]").forEach((b) => b.addEventListener("click", () => editDossier(b.dataset.editDossier)));
  $$("#dossiers-list [data-del-dossier]").forEach((b) => b.addEventListener("click", () => deleteDossier(b.dataset.delDossier)));
}

function editDossier(id) {
  const d = data.dossiers.find((x) => x.id === id);
  if (!d) return;
  $("#do-id").value = d.id;
  $("#do-client").value = d.client_id;
  $("#do-template").value = "";
  $("#do-title").value = d.title || "";
  $("#do-status").value = d.status || "En cours";
  $("#do-due").value = d.due_date || "";
  $("#do-cancel").classList.remove("hidden");
  $("#dossier-form-box").open = true;
  $("#dossier-form-box").scrollIntoView({ behavior: "smooth" });
}

function resetDossierForm() {
  $("#form-dossier").reset();
  $("#do-id").value = "";
  $("#do-cancel").classList.add("hidden");
  formMsg("do-msg", "");
}

async function handleDossierSubmit(e) {
  e.preventDefault();
  if (!guardWrite()) return;
  const id = $("#do-id").value;
  const payload = {
    cabinet_id: currentCabinet.id,
    client_id: $("#do-client").value,
    title: $("#do-title").value.trim(),
    status: $("#do-status").value,
    due_date: $("#do-due").value || null
  };
  if (!payload.client_id) { formMsg("do-msg", "Choisis le client du dossier."); return; }
  if (!payload.title) { formMsg("do-msg", "Le titre du dossier est obligatoire."); return; }
  const res = id
    ? await sb.from("cf_dossiers").update(payload).eq("id", id)
    : await sb.from("cf_dossiers").insert(payload);
  if (res.error) { formMsg("do-msg", authErrorFr(res.error)); return; }
  toast(id ? "✅ Dossier modifié." : "✅ Dossier créé.");
  resetDossierForm();
  await loadCabinetData(); renderAll();
}

async function deleteDossier(id) {
  if (!guardWrite()) return;
  const d = data.dossiers.find((x) => x.id === id);
  if (!confirm("Supprimer le dossier « " + (d ? d.title : "") + " » ?")) return;
  const { error } = await sb.from("cf_dossiers").delete().eq("id", id);
  if (error) { toast(authErrorFr(error)); return; }
  toast("Dossier supprimé.");
  await loadCabinetData(); renderAll();
}

/* ============================================================
   DOCUMENTS
   ============================================================ */
function statusBadge(status) {
  if (status === "Reçu") return '<span class="badge blue">Reçu</span>';
  if (status === "Validé") return '<span class="badge green">Validé</span>';
  if (status === "Demandé") return '<span class="badge gold">Demandé</span>';
  return '<span class="badge red">Manquant</span>';
}

function renderDocuments() {
  const box = $("#documents-list");
  if (!data.documents.length) {
    box.innerHTML = '<div class="empty-note">Aucun document suivi pour le moment. Ajoute la première pièce à suivre ci-dessous (par exemple : « Relevé bancaire » en statut Manquant).</div>';
    return;
  }
  box.innerHTML = data.documents.map((d) => {
    const isImage = d.file_url && /^data:image\//i.test(d.file_url);
    return '<div class="item-card"><h4>' + esc(d.title) + " " + statusBadge(d.status) + "</h4>" +
      "<p>" + [d.client_id ? "👤 " + esc(clientName(d.client_id)) : "", d.dossier_id ? "🗂️ " + esc(dossierTitle(d.dossier_id)) : ""].filter(Boolean).join(" · ") + "</p>" +
      (d.file_url
        ? (isImage
            ? '<p><img class="photo-preview" src="' + d.file_url + '" alt="Fichier joint"></p>'
            : '<p><a href="' + d.file_url + '" download="' + esc(d.file_name || "document") + '">📎 Ouvrir le fichier joint' + (d.file_name ? " (" + esc(d.file_name) + ")" : "") + "</a></p>")
        : "") +
      '<div class="item-actions"><button type="button" class="btn-small" data-edit-doc="' + d.id + '">✏️ Modifier</button>' +
      '<button type="button" class="btn-small danger" data-del-doc="' + d.id + '">🗑️ Supprimer</button></div></div>';
  }).join("");
  $$("#documents-list [data-edit-doc]").forEach((b) => b.addEventListener("click", () => editDocument(b.dataset.editDoc)));
  $$("#documents-list [data-del-doc]").forEach((b) => b.addEventListener("click", () => deleteDocument(b.dataset.delDoc)));
}

/* Fichier choisi dans le téléphone : les images sont redimensionnées
   (comme WorldLink) ; les autres fichiers sont gardés tels quels
   s'ils restent raisonnables (environ 1 Mo). */
function handleDocFile(input) {
  const file = input.files && input.files[0];
  if (!file) { docFileData = null; docFileName = ""; $("#doc-file-name").textContent = ""; return; }
  docFileName = file.name;
  if (/^image\//i.test(file.type)) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 900;
        let w = img.width, h = img.height;
        if (w > max || h > max) { const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        docFileData = canvas.toDataURL("image/jpeg", 0.82);
        const prev = $("#doc-file-preview");
        prev.src = docFileData; prev.classList.remove("hidden");
        $("#doc-file-name").textContent = "📎 " + docFileName + " (image réduite, prête)";
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  } else {
    if (file.size > 1100000) {
      toast("⚠️ Fichier trop lourd (plus d'1 Mo) : choisis un fichier plus léger.");
      input.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      docFileData = reader.result;
      $("#doc-file-name").textContent = "📎 " + docFileName + " (prêt)";
    };
    reader.readAsDataURL(file);
  }
}

function editDocument(id) {
  const d = data.documents.find((x) => x.id === id);
  if (!d) return;
  $("#doc-id").value = d.id;
  fillAllSelects();
  $("#doc-dossier").value = d.dossier_id || "";
  $("#doc-client").value = d.client_id || "";
  $("#doc-title").value = d.title || "";
  $("#doc-status").value = d.status || "Manquant";
  docFileData = d.file_url || null;
  docFileName = d.file_name || "";
  $("#doc-file-name").textContent = d.file_url ? "📎 Fichier déjà joint" + (d.file_name ? " : " + d.file_name : "") + " — choisis un autre fichier pour le remplacer." : "";
  const prev = $("#doc-file-preview");
  if (d.file_url && /^data:image\//i.test(d.file_url)) { prev.src = d.file_url; prev.classList.remove("hidden"); }
  else { prev.classList.add("hidden"); prev.removeAttribute("src"); }
  $("#doc-cancel").classList.remove("hidden");
  $("#doc-form-box").open = true;
  $("#doc-form-box").scrollIntoView({ behavior: "smooth" });
}

function resetDocForm() {
  $("#form-doc").reset();
  $("#doc-id").value = "";
  docFileData = null; docFileName = "";
  $("#doc-file-name").textContent = "";
  const prev = $("#doc-file-preview");
  prev.classList.add("hidden"); prev.removeAttribute("src");
  $("#doc-cancel").classList.add("hidden");
  formMsg("doc-msg", "");
}

async function handleDocSubmit(e) {
  e.preventDefault();
  if (!guardWrite()) return;
  const id = $("#doc-id").value;
  const dossierId = $("#doc-dossier").value || null;
  let clientId = $("#doc-client").value || null;
  if (!clientId && dossierId) {
    const d = data.dossiers.find((x) => x.id === dossierId);
    if (d) clientId = d.client_id;
  }
  const payload = {
    cabinet_id: currentCabinet.id,
    dossier_id: dossierId,
    client_id: clientId,
    title: $("#doc-title").value.trim(),
    status: $("#doc-status").value,
    file_url: docFileData || null,
    file_name: docFileName || null
  };
  if (!payload.title) { formMsg("doc-msg", "Le titre du document est obligatoire."); return; }
  const res = id
    ? await sb.from("cf_documents").update(payload).eq("id", id)
    : await sb.from("cf_documents").insert(payload);
  if (res.error) { formMsg("doc-msg", authErrorFr(res.error)); return; }
  toast(id ? "✅ Document modifié." : "✅ Document ajouté.");
  resetDocForm();
  await loadCabinetData(); renderAll();
}

async function deleteDocument(id) {
  if (!guardWrite()) return;
  if (!confirm("Supprimer ce document suivi ?")) return;
  const { error } = await sb.from("cf_documents").delete().eq("id", id);
  if (error) { toast(authErrorFr(error)); return; }
  toast("Document supprimé.");
  await loadCabinetData(); renderAll();
}

/* ============================================================
   ÉCHÉANCES + CALENDRIER FISCAL CAMEROUNAIS
   ============================================================ */
function renderDeadlines() {
  const box = $("#deadlines-list");
  if (!data.deadlines.length) {
    box.innerHTML = '<div class="empty-note">Aucune échéance pour le moment. Génère le calendrier fiscal d\'un client ci-dessus, ou ajoute une échéance manuelle.</div>';
    return;
  }
  const today = todayStr();
  const in7 = addDays(today, 7);
  box.innerHTML = data.deadlines.map((d) => {
    const cls = d.due_date < today ? " overdue" : (d.due_date <= in7 ? " soon" : "");
    const badge = d.due_date < today ? '<span class="badge red">En retard</span>' : (d.due_date <= in7 ? '<span class="badge gold">Sous 7 jours</span>' : "");
    return '<div class="item-card' + cls + '"><h4>' + esc(d.title) + " " + badge + "</h4>" +
      "<p>📅 " + fmtDate(d.due_date) + " · " + esc(clientName(d.client_id)) + ' · <span class="badge blue">' + esc(d.kind) + "</span></p>" +
      '<div class="item-actions"><button type="button" class="btn-small" data-edit-deadline="' + d.id + '">✏️ Modifier</button>' +
      '<button type="button" class="btn-small danger" data-del-deadline="' + d.id + '">🗑️ Supprimer</button></div></div>';
  }).join("");
  $$("#deadlines-list [data-edit-deadline]").forEach((b) => b.addEventListener("click", () => editDeadline(b.dataset.editDeadline)));
  $$("#deadlines-list [data-del-deadline]").forEach((b) => b.addEventListener("click", () => deleteDeadline(b.dataset.delDeadline)));
}

/* Construit les échéances du calendrier fiscal camerounais
   d'un client pour une année : TVA et DIPE/CNPS le 15 du mois
   suivant chaque mois, patente le 28 février, DSF selon le
   centre des impôts du client (DGE 15 mars, CIME 15 avril,
   CDI 15 mai ; CIME par défaut). */
function fiscalCalendarRows(client, year) {
  const rows = [];
  for (let m = 0; m < 12; m++) {
    const due = toISODate(new Date(year, m + 1, 15));
    rows.push({ title: "TVA — " + MONTHS_FR[m] + " " + year, due_date: due, kind: "TVA" });
    rows.push({ title: "DIPE / CNPS — " + MONTHS_FR[m] + " " + year, due_date: due, kind: "DIPE-CNPS" });
  }
  rows.push({ title: "Patente " + year, due_date: toISODate(new Date(year, 1, 28)), kind: "Patente" });
  const centre = (client.tax_center || "CIME").toUpperCase();
  const dsf = DSF_BY_CENTER[centre] || DSF_BY_CENTER["CIME"];
  rows.push({ title: "DSF annuelle " + year, due_date: toISODate(new Date(year, dsf[0], dsf[1])), kind: "DSF" });
  return rows;
}

async function handleGenCalendar(e) {
  e.preventDefault();
  if (!guardWrite()) return;
  const clientId = $("#gen-client").value;
  const year = parseInt($("#gen-year").value, 10);
  const client = data.clients.find((c) => c.id === clientId);
  if (!client) { formMsg("gen-msg", "Choisis un client."); return; }
  if (!year || year < 2000 || year > 2100) { formMsg("gen-msg", "Entre une année valide."); return; }
  const wanted = fiscalCalendarRows(client, year);
  const existing = new Set(
    data.deadlines.filter((d) => d.client_id === clientId)
      .map((d) => d.title + "|" + d.due_date)
  );
  const rows = wanted
    .filter((r) => !existing.has(r.title + "|" + r.due_date))
    .map((r) => ({ cabinet_id: currentCabinet.id, client_id: clientId, title: r.title, due_date: r.due_date, kind: r.kind }));
  if (!rows.length) {
    formMsg("gen-msg", "Le calendrier " + year + " de " + client.name + " est déjà complet : rien à ajouter.", true);
    return;
  }
  const { error } = await sb.from("cf_deadlines").insert(rows);
  if (error) { formMsg("gen-msg", authErrorFr(error)); return; }
  formMsg("gen-msg", "✅ " + rows.length + " échéances créées pour " + client.name + " (" + year + ").", true);
  toast("🗓️ Calendrier fiscal " + year + " généré : " + rows.length + " échéances.");
  await loadCabinetData(); renderAll();
}

function editDeadline(id) {
  const d = data.deadlines.find((x) => x.id === id);
  if (!d) return;
  $("#dl-id").value = d.id;
  $("#dl-client").value = d.client_id || "";
  $("#dl-title").value = d.title || "";
  $("#dl-date").value = d.due_date || "";
  $("#dl-type").value = d.kind || "Manuel";
  $("#dl-cancel").classList.remove("hidden");
  $("#deadline-form-box").open = true;
  $("#deadline-form-box").scrollIntoView({ behavior: "smooth" });
}

function resetDeadlineForm() {
  $("#form-deadline").reset();
  $("#dl-id").value = "";
  $("#dl-cancel").classList.add("hidden");
  formMsg("dl-msg", "");
}

async function handleDeadlineSubmit(e) {
  e.preventDefault();
  if (!guardWrite()) return;
  const id = $("#dl-id").value;
  const payload = {
    cabinet_id: currentCabinet.id,
    client_id: $("#dl-client").value || null,
    title: $("#dl-title").value.trim(),
    due_date: $("#dl-date").value,
    kind: $("#dl-type").value
  };
  if (!payload.title || !payload.due_date) { formMsg("dl-msg", "Le titre et la date sont obligatoires."); return; }
  const res = id
    ? await sb.from("cf_deadlines").update(payload).eq("id", id)
    : await sb.from("cf_deadlines").insert(payload);
  if (res.error) { formMsg("dl-msg", authErrorFr(res.error)); return; }
  toast(id ? "✅ Échéance modifiée." : "✅ Échéance ajoutée.");
  resetDeadlineForm();
  await loadCabinetData(); renderAll();
}

async function deleteDeadline(id) {
  if (!guardWrite()) return;
  if (!confirm("Supprimer cette échéance ?")) return;
  const { error } = await sb.from("cf_deadlines").delete().eq("id", id);
  if (error) { toast(authErrorFr(error)); return; }
  toast("Échéance supprimée.");
  await loadCabinetData(); renderAll();
}

/* ============================================================
   ÉQUIPE
   ============================================================ */
function renderTeam() {
  const box = $("#team-list");
  box.innerHTML = data.members.map((m) => {
    const isMe = m.user_id === currentUser.id;
    const pending = !m.user_id;
    return '<div class="item-card"><h4>' + esc(m.user_email) +
      ' <span class="badge ' + (m.role === "responsable" ? "gold" : "blue") + '">' + (m.role === "responsable" ? "Responsable" : "Employé") + "</span>" +
      (pending ? ' <span class="badge grey">En attente de sa première connexion</span>' : "") +
      (isMe ? ' <span class="badge green">Toi</span>' : "") + "</h4>" +
      '<div class="item-actions">' +
      (!isMe && currentRole === "responsable"
        ? '<button type="button" class="btn-small danger" data-del-member="' + m.id + '">🗑️ Retirer de l\'équipe</button>'
        : "") +
      "</div></div>";
  }).join("");
  $$("#team-list [data-del-member]").forEach((b) => b.addEventListener("click", () => deleteMember(b.dataset.delMember)));
  $("#member-form-box").style.display = currentRole === "responsable" ? "" : "none";
}

async function handleMemberSubmit(e) {
  e.preventDefault();
  if (!guardWrite()) return;
  if (currentRole !== "responsable") { formMsg("mb-msg", "Seul un responsable peut ajouter un membre."); return; }
  const email = $("#mb-email").value.trim().toLowerCase();
  const role = $("#mb-role").value;
  if (!email) { formMsg("mb-msg", "Entre le courriel du membre."); return; }
  if (data.members.some((m) => (m.user_email || "").toLowerCase() === email)) {
    formMsg("mb-msg", "Cette personne est déjà dans l'équipe.");
    return;
  }
  const { error } = await sb.from("cf_memberships")
    .insert({ cabinet_id: currentCabinet.id, user_id: null, user_email: email, role });
  if (error) { formMsg("mb-msg", authErrorFr(error)); return; }
  formMsg("mb-msg", "✅ Membre ajouté. Dès sa prochaine connexion avec ce courriel, il verra ton cabinet.", true);
  $("#form-member").reset();
  await loadCabinetData(); renderTeam();
}

async function deleteMember(id) {
  if (!guardWrite()) return;
  if (currentRole !== "responsable") return;
  if (!confirm("Retirer cette personne de l'équipe ? Elle perdra l'accès à ce cabinet.")) return;
  const { error } = await sb.from("cf_memberships").delete().eq("id", id);
  if (error) { toast(authErrorFr(error)); return; }
  toast("Membre retiré.");
  await loadCabinetData(); renderTeam();
}

/* ============================================================
   ABONNEMENT
   ============================================================ */
function renderSubscription() {
  const plan = PLANS[currentCabinet.plan] || PLANS.essentiel;
  let statusHtml = "";
  if (access.state === "essai") {
    statusHtml = "<h3>🎁 Essai gratuit — jusqu'au " + fmtDate(access.end) + "</h3>" +
      "<p>Tu essaies CabinetFlow gratuitement. Choisis une formule et déclare ton paiement avant la fin de l'essai pour continuer sans interruption.</p>";
  } else if (access.state === "actif") {
    statusHtml = "<h3>✅ Abonnement actif — formule " + plan.name + "</h3>" +
      "<p>Période en cours jusqu'au " + fmtDate(access.end) + ". Pour enchaîner, déclare le paiement du mois suivant avant cette date.</p>";
  } else if (access.state === "grace") {
    statusHtml = "<h3>⚠️ Période de grâce — jusqu'au " + fmtDate(access.end) + "</h3>" +
      "<p>Ta période s'est terminée le " + fmtDate(access.baseEnd) + ". Déclare un paiement maintenant pour réactiver ton cabinet avant la fin de la grâce.</p>";
  } else {
    statusHtml = "<h3>🔒 Cabinet en lecture seule</h3>" +
      "<p>Tes données sont conservées. Déclare un paiement ci-dessous : dès sa validation, ton cabinet redevient actif pour un mois.</p>";
  }
  $("#sub-status").innerHTML = statusHtml +
    "<p class='muted'>Formule actuelle : <strong>" + plan.name + "</strong> — " + fmtMoney(plan.price) + " / mois.</p>";

  $("#plans-grid").innerHTML = Object.keys(PLANS).map((key) => {
    const p = PLANS[key];
    return '<div class="plan-card' + (key === currentCabinet.plan ? " current" : "") + '"><h4>' + p.name + "</h4>" +
      '<div class="plan-price">' + fmtMoney(p.price) + '</div><div class="muted">par mois, par cabinet</div>' +
      (key === currentCabinet.plan ? '<span class="badge gold">Formule actuelle</span>' : "") +
      "<ul>" + p.features.map((f) => "<li>" + esc(f) + "</li>").join("") + "</ul></div>";
  }).join("");

  const statusLabel = { declare: '<span class="badge gold">En attente de validation</span>', valide: '<span class="badge green">Validé</span>', rejete: '<span class="badge red">Refusé</span>' };
  $("#my-payments-list").innerHTML = data.payments.length
    ? data.payments.map((p) =>
        '<div class="item-card"><h4>' + esc((PLANS[p.plan] || {}).name || p.plan) + " — " + fmtMoney(p.amount) + " " + (statusLabel[p.status] || "") + "</h4>" +
        "<p>" + esc(p.method) + (p.reference ? " · Réf. : " + esc(p.reference) : "") + " · Déclaré le " + fmtDate((p.created_at || "").slice(0, 10)) + "</p>" +
        (p.status === "valide" && p.period_end ? "<p class='muted'>Période couverte : jusqu'au " + fmtDate(p.period_end) + "</p>" : "") +
        "</div>"
      ).join("")
    : '<div class="empty-note">Aucun paiement déclaré pour le moment.</div>';

  updatePayAmount();
}

function updatePayAmount() {
  const key = $("#pay-plan").value;
  $("#pay-amount").textContent = fmtMoney(PLANS[key].price);
}

async function handlePaySubmit(e) {
  e.preventDefault();
  /* La déclaration de paiement reste possible même en lecture seule : c'est elle qui réactive le cabinet. */
  formMsg("pay-msg", "");
  const planKey = $("#pay-plan").value;
  const payload = {
    cabinet_id: currentCabinet.id,
    plan: planKey,
    amount: PLANS[planKey].price,
    method: $("#pay-method").value,
    reference: $("#pay-ref").value.trim(),
    status: "declare"
  };
  if (!payload.reference) { formMsg("pay-msg", "Entre la référence de ton paiement (code de transaction)."); return; }
  const { error } = await sb.from("cf_payments").insert(payload);
  if (error) { formMsg("pay-msg", authErrorFr(error)); return; }
  formMsg("pay-msg", "✅ Paiement déclaré ! Le propriétaire de CabinetFlow va le valider ; ta période démarrera à la validation.", true);
  $("#pay-ref").value = "";
  toast("💳 Paiement déclaré — en attente de validation.");
  await loadCabinetData(); renderSubscription();
}

/* ============================================================
   EXPORT CSV — les données du cabinet, à tout moment
   ============================================================ */
function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsv(filename, headers, rows) {
  const lines = [headers.map(csvCell).join(";")].concat(rows.map((r) => r.map(csvCell).join(";")));
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
}
function exportCabinetData() {
  const slug = (currentCabinet.name || "cabinet").replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase();
  downloadCsv("cabinetflow-" + slug + "-clients.csv",
    ["Nom", "Contact", "Ville", "Téléphone", "Courriel", "NIU", "Régime fiscal", "Centre des impôts", "N° CNPS", "SYSCOHADA"],
    data.clients.map((c) => [c.name, c.contact, c.city, c.phone, c.email, c.niu, c.tax_regime, c.tax_center, c.cnps_number, c.syscohada]));
  downloadCsv("cabinetflow-" + slug + "-dossiers.csv",
    ["Titre", "Client", "Statut", "Échéance"],
    data.dossiers.map((d) => [d.title, clientName(d.client_id), d.status, d.due_date]));
  downloadCsv("cabinetflow-" + slug + "-documents.csv",
    ["Titre", "Client", "Dossier", "Statut", "Fichier joint"],
    data.documents.map((d) => [d.title, d.client_id ? clientName(d.client_id) : "", d.dossier_id ? dossierTitle(d.dossier_id) : "", d.status, d.file_name || (d.file_url ? "oui" : "")]));
  downloadCsv("cabinetflow-" + slug + "-echeances.csv",
    ["Titre", "Client", "Date", "Type"],
    data.deadlines.map((d) => [d.title, d.client_id ? clientName(d.client_id) : "", d.due_date, d.kind]));
  toast("📦 Export lancé : 4 fichiers CSV (clients, dossiers, documents, échéances).");
}

/* ============================================================
   CONSOLE PROPRIÉTAIRE (Melvin seulement)
   ============================================================ */
async function renderOwner() {
  const cfg = window.CABINETFLOW_CONFIG || {};
  if (!cfg.OWNER_USER_ID || cfg.OWNER_USER_ID !== currentUser.id) return;

  const [payments, cabinets] = await Promise.all([
    sb.from("cf_payments").select("*").order("created_at", { ascending: false }),
    sb.from("cf_cabinets").select("*").order("created_at", { ascending: false })
  ]);
  const allPayments = payments.data || [];
  const allCabinets = cabinets.data || [];
  const cabName = (id) => {
    const c = allCabinets.find((x) => x.id === id);
    return c ? c.name : "(cabinet inconnu)";
  };

  const pending = allPayments.filter((p) => p.status === "declare");
  const mrr = allCabinets.reduce((sum, c) => {
    const a = computeAccess(c);
    return a.state === "actif" ? sum + (PLANS[c.plan] ? PLANS[c.plan].price : 0) : sum;
  }, 0);

  $("#owner-mrr").textContent = fmtMoney(mrr);
  $("#owner-cabinets-count").textContent = allCabinets.length;
  $("#owner-pending-count").textContent = pending.length;

  $("#owner-payments").innerHTML = pending.length
    ? pending.map((p) =>
        '<div class="item-card soon"><h4>' + esc(cabName(p.cabinet_id)) + " — " + esc((PLANS[p.plan] || {}).name || p.plan) + " · " + fmtMoney(p.amount) + "</h4>" +
        "<p>" + esc(p.method) + (p.reference ? " · Réf. : " + esc(p.reference) : "") + " · Déclaré le " + fmtDate((p.created_at || "").slice(0, 10)) + "</p>" +
        '<div class="item-actions"><button type="button" class="btn-small gold" data-validate="' + p.id + '">✅ Valider (1 mois)</button>' +
        '<button type="button" class="btn-small danger" data-reject="' + p.id + '">Refuser</button></div></div>'
      ).join("")
    : '<div class="empty-note">Aucun paiement en attente de validation.</div>';
  $$("#owner-payments [data-validate]").forEach((b) => b.addEventListener("click", () => validatePayment(b.dataset.validate, allPayments, allCabinets)));
  $$("#owner-payments [data-reject]").forEach((b) => b.addEventListener("click", () => rejectPayment(b.dataset.reject)));

  $("#owner-cabinets").innerHTML = allCabinets.length
    ? allCabinets.map((c) => {
        const a = computeAccess(c);
        const label = a.state === "actif" ? '<span class="badge green">Actif jusqu\'au ' + fmtDate(a.end) + "</span>"
          : a.state === "essai" ? '<span class="badge blue">Essai jusqu\'au ' + fmtDate(a.end) + "</span>"
          : a.state === "grace" ? '<span class="badge gold">Grâce jusqu\'au ' + fmtDate(a.end) + "</span>"
          : '<span class="badge red">Lecture seule</span>';
        return '<div class="item-card"><h4>' + esc(c.name) + " " + label + "</h4>" +
          "<p>" + [c.city, c.email, c.phone].filter(Boolean).map(esc).join(" · ") + "</p>" +
          "<p class='muted'>Formule : " + esc((PLANS[c.plan] || {}).name || c.plan) + " · Inscrit le " + fmtDate((c.created_at || "").slice(0, 10)) + "</p></div>";
      }).join("")
    : '<div class="empty-note">Aucun cabinet inscrit pour le moment.</div>';
}

async function validatePayment(paymentId, allPayments, allCabinets) {
  const p = (allPayments || []).find((x) => x.id === paymentId);
  if (!p) return;
  if (!confirm("Valider ce paiement de " + fmtMoney(p.amount) + " ? Le cabinet devient actif pour un mois à partir d'aujourd'hui.")) return;
  const start = todayStr();
  const end = addMonths(start, 1);
  const { error } = await sb.from("cf_payments")
    .update({ status: "valide", period_start: start, period_end: end, validated_at: new Date().toISOString() })
    .eq("id", paymentId);
  if (error) { toast(authErrorFr(error)); return; }
  const { error: err2 } = await sb.from("cf_cabinets")
    .update({ plan: p.plan, period_end: end, access_status: "actif" })
    .eq("id", p.cabinet_id);
  if (err2) { toast("Paiement validé, mais la mise à jour du cabinet a échoué : " + authErrorFr(err2)); return; }
  toast("✅ Paiement validé — cabinet actif jusqu'au " + fmtDate(end) + ".");
  if (currentCabinet && currentCabinet.id === p.cabinet_id) {
    currentCabinet.plan = p.plan;
    currentCabinet.period_end = end;
    currentCabinet.access_status = "actif";
    access = computeAccess(currentCabinet);
    renderAccessBanner();
    await loadCabinetData(); renderAll();
  }
  renderOwner();
}

async function rejectPayment(paymentId) {
  if (!confirm("Refuser ce paiement déclaré ? Le cabinet en sera informé dans sa liste de paiements.")) return;
  const { error } = await sb.from("cf_payments").update({ status: "rejete" }).eq("id", paymentId);
  if (error) { toast(authErrorFr(error)); return; }
  toast("Paiement refusé.");
  renderOwner();
}

/* ============================================================
   DÉMARRAGE + CÂBLAGE DES ÉVÉNEMENTS
   ============================================================ */
let routedUserId = null;

async function routeAfterAuth() {
  if (!currentUser) { showView("view-auth"); return; }
  if (routedUserId === currentUser.id && !$("#view-app").classList.contains("hidden")) return;
  routedUserId = currentUser.id;
  await loadMyCabinets();
  showSetup();
}

function wireEvents() {
  $("#tab-login").addEventListener("click", () => switchAuthTab("login"));
  $("#tab-signup").addEventListener("click", () => switchAuthTab("signup"));
  $("#form-login").addEventListener("submit", handleLogin);
  $("#form-signup").addEventListener("submit", handleSignup);
  $("#form-cabinet").addEventListener("submit", handleCreateCabinet);
  $("#btn-logout").addEventListener("click", handleLogout);
  $("#btn-logout-setup").addEventListener("click", handleLogout);
  $("#btn-switch-cabinet").addEventListener("click", async () => { await loadMyCabinets(); showSetup(); });
  $("#btn-owner").addEventListener("click", () => showPage("proprietaire"));
  $("#btn-owner-back").addEventListener("click", () => showPage("dashboard"));
  $$(".nav-btn").forEach((b) => b.addEventListener("click", () => showPage(b.dataset.page)));

  $("#form-client").addEventListener("submit", handleClientSubmit);
  $("#cl-cancel").addEventListener("click", resetClientForm);

  $("#form-dossier").addEventListener("submit", handleDossierSubmit);
  $("#do-cancel").addEventListener("click", resetDossierForm);
  $("#filter-dossiers-client").addEventListener("change", renderDossiers);
  $("#do-template").addEventListener("change", () => {
    const t = $("#do-template").value;
    if (t) {
      const clientSel = $("#do-client");
      const cname = clientSel && clientSel.selectedIndex >= 0 ? clientSel.options[clientSel.selectedIndex].text : "";
      $("#do-title").value = t + (cname ? " — " + cname : "");
    }
  });
  $("#do-client").addEventListener("change", () => {
    const t = $("#do-template").value;
    if (t) {
      const clientSel = $("#do-client");
      const cname = clientSel.selectedIndex >= 0 ? clientSel.options[clientSel.selectedIndex].text : "";
      $("#do-title").value = t + (cname ? " — " + cname : "");
    }
  });

  $("#form-doc").addEventListener("submit", handleDocSubmit);
  $("#doc-cancel").addEventListener("click", resetDocForm);
  $("#doc-file").addEventListener("change", (e) => handleDocFile(e.target));
  $("#doc-dossier").addEventListener("change", () => {
    const d = data.dossiers.find((x) => x.id === $("#doc-dossier").value);
    if (d) $("#doc-client").value = d.client_id;
  });

  $("#form-gen-calendar").addEventListener("submit", handleGenCalendar);
  $("#form-deadline").addEventListener("submit", handleDeadlineSubmit);
  $("#dl-cancel").addEventListener("click", resetDeadlineForm);

  $("#form-member").addEventListener("submit", handleMemberSubmit);

  $("#form-pay").addEventListener("submit", handlePaySubmit);
  $("#pay-plan").addEventListener("change", updatePayAmount);

  $$(".btn-export").forEach((b) => b.addEventListener("click", exportCabinetData));
}

(function init() {
  const cfg = window.CABINETFLOW_CONFIG;
  if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY ||
      !window.supabase || !window.supabase.createClient) {
    showView("view-config");
    return;
  }
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  wireEvents();
  $("#gen-year").value = new Date().getFullYear();

  sb.auth.getSession().then(({ data }) => {
    currentUser = data.session ? data.session.user : null;
    if (currentUser) routeAfterAuth();
    else showView("view-auth");
  });
  sb.auth.onAuthStateChange((_event, session) => {
    const newUser = session ? session.user : null;
    if (!newUser) {
      currentUser = null; routedUserId = null;
      if ($("#view-auth").classList.contains("hidden")) showView("view-auth");
      return;
    }
    const isNew = !currentUser || currentUser.id !== newUser.id;
    currentUser = newUser;
    if (isNew) routeAfterAuth();
  });
})();
