// Cloud sync for Skyline Daily Boost (Firebase Auth + Firestore).
// Loaded only when firebase-config.js provides window.SDB_FIREBASE.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, setPersistence, browserLocalPersistence, sendEmailVerification,
  updateProfile, deleteUser
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, doc, getDoc, setDoc, onSnapshot, serverTimestamp,
  collection, query, orderBy, limit, getDocs, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(window.SDB_FIREBASE);
const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {}); // stay signed in on this device
let db;
try { db = initializeFirestore(app, { localCache: persistentLocalCache() }); } // works offline too
catch (e) { db = initializeFirestore(app, {}); }

const btn = document.getElementById("syncBtn");
const ui = () => UI[lang];
let lastErrToast = 0;
function syncFail(e) {
  console.warn(e);
  if (Date.now() - lastErrToast < 30000) return; // don't repeat the same warning every retry
  lastErrToast = Date.now();
  const c = (e && e.code) || "";
  toast(/permission/.test(c) ? ui().syncErrPerm : (/unavailable|network/.test(c) || !navigator.onLine) ? ui().syncErrNet : ui().syncErr, "error");
}

// one id per browser, so each device keeps its own focus log
let deviceId = store.get("sdb.device", null);
if (!deviceId) { deviceId = Math.random().toString(36).slice(2, 10); localStorage.setItem("sdb.device", JSON.stringify(deviceId)); }

let user = null, unsub = null, pushTimer = null, applying = false, state = "idle", lastSync = store.get("sdb.lastSync", null);

const fullName = () => user ? (user.displayName || (user.email || "").split("@")[0]) : "";
const shortName = () => fullName().split(" ")[0].slice(0, 12);
const photo = () => user && user.photoURL && /^https:\/\/[^'"()\s]+$/.test(user.photoURL) ? user.photoURL : "";
function label() {
  btn.hidden = false;
  if (!user) btn.textContent = ui().signIn;
  else if (state === "syncing") btn.textContent = ui().syncing;
  else {
    const nm = shortName();
    btn.innerHTML = `<span class="acav-mini"${photo() ? ` style="background-image:url('${photo()}')"` : ""}>${photo() ? "" : esc((nm[0] || "?").toUpperCase())}</span>${esc(nm || ui().account)}`;
  }
  btn.setAttribute("aria-pressed", !!user);
  btn.title = user ? (user.email || "") : "";
}
window.sdbSyncLabel = label;

/* ---------- local <-> cloud shape ---------- */
function goalsLocal() { return { date: todayKey(), list: store.get("sdb.goals." + todayKey(), null) }; }
function sharedLocal() {
  return {
    favs, myQuotes, lang,
    streak: store.get("sdb.streak", 1), last: store.get("sdb.last", todayKey()),
    goals: goalsLocal(),
    quiz: store.get("sdb.quiz", { total: 0, correct: 0 }),
    words: wordLv, wrong: wrongs, reminders, custom, music: store.get("sdb.music", null)
  };
}
function applyShared(sh) {
  if (!sh) return;
  applying = true;
  try {
    if (Array.isArray(sh.favs)) { favs = sh.favs; store.set("sdb.favs", favs); }
    if (Array.isArray(sh.myQuotes)) { myQuotes = sh.myQuotes; store.set("sdb.myQuotes", myQuotes); }
    if (sh.lang === "zh" || sh.lang === "en") { lang = sh.lang; store.set("sdb.lang", lang); }
    if (sh.last && sh.streak) {
      // keep whichever streak is more recent / longer
      const localLast = store.get("sdb.last", ""), localStreak = store.get("sdb.streak", 1);
      if (sh.last > localLast || (sh.last === localLast && sh.streak > localStreak)) {
        store.set("sdb.last", sh.last); store.set("sdb.streak", sh.streak); streak = sh.streak;
      }
    }
    if (sh.quiz && typeof sh.quiz.total === "number" && sh.quiz.total >= store.get("sdb.quiz", { total: 0 }).total) store.set("sdb.quiz", sh.quiz);
    if (sh.words && typeof sh.words === "object") { wordLv = sh.words; store.set("sdb.words", wordLv); }
    if (sh.custom && typeof sh.custom === "object") {
      custom = { cities: [], companies: [], quiz: [], words: [], ...sh.custom }; store.set("sdb.custom", custom); applyCustom();
    }
    if (Array.isArray(sh.reminders)) { reminders = sh.reminders; store.set("sdb.reminders", reminders); }
    if (Array.isArray(sh.wrong)) { wrongs = sh.wrong; store.set("sdb.wrong", wrongs); }
    if (sh.music === null || (typeof sh.music === "string" && parseMusic(sh.music))) store.set("sdb.music", sh.music);
    if (sh.goals && sh.goals.date === todayKey() && Array.isArray(sh.goals.list)) {
      store.set("sdb.goals." + todayKey(), sh.goals.list);
      document.getElementById("goals").innerHTML = ""; // rebuild rows with new values
    }
    // a quote index may now point past the end of the list
    clampAll(); paintScene(current());
  } finally { applying = false; }
  render(false);
}
function applyLogs(logs) {
  const others = {};
  Object.entries(logs || {}).forEach(([dev, l]) => { if (dev !== deviceId) others[dev] = l; });
  window.sdbRemoteLogs = others;
  drawStats();
}

/* ---------- first sign-in on this device: merge both sides ---------- */
function mergeFirst(remote) {
  const sh = remote.shared || {};
  const mergedFavs = [...new Set([...(sh.favs || []), ...favs])];
  const byId = new Map();
  [...(sh.myQuotes || []), ...myQuotes].forEach(q => byId.set(q.id, q));
  const localGoals = store.get("sdb.goals." + todayKey(), null);
  const remoteGoals = sh.goals && sh.goals.date === todayKey() ? sh.goals.list : null;
  const goalsFilled = l => (l || []).filter(g => g.t && g.t.trim()).length;
  applyShared({
    ...sh,
    favs: mergedFavs,
    myQuotes: [...byId.values()],
    lang: sh.lang || lang,
    words: Object.fromEntries([...new Set([...Object.keys(sh.words || {}), ...Object.keys(wordLv)])]
      .map(k => [k, Math.max((sh.words || {})[k] || 0, wordLv[k] || 0)])),
    wrong: [...new Set([...(sh.wrong || []), ...wrongs])],
    custom: Object.fromEntries(["cities", "companies", "quiz", "words"].map(k =>
      [k, [...new Map([...((sh.custom || {})[k] || []), ...custom[k]].map(x => [x.id, x])).values()]])),
    reminders: [...new Map([...(sh.reminders || []), ...reminders].map(r => [r.id, r])).values()],
    goals: { date: todayKey(), list: goalsFilled(localGoals) >= goalsFilled(remoteGoals) ? localGoals : remoteGoals }
  });
}

/* ---------- push ---------- */
async function push() {
  if (!user) return;
  state = "syncing"; label();
  try {
    await setDoc(doc(db, "users", user.uid), {
      shared: sharedLocal(),
      logs: { [deviceId]: store.get("sdb.log", {}) },
      updatedBy: deviceId,
      updatedAt: serverTimestamp()
    }, { merge: true });
    state = "idle"; lastSync = Date.now(); localStorage.setItem("sdb.lastSync", JSON.stringify(lastSync));
    const bn = store.get("sdb.boardName", null);
    if (bn) await setDoc(doc(db, "boards", weekKey(), "entries", user.uid), { name: bn, minutes: weekMinutes(), updatedAt: serverTimestamp() });
  } catch (e) {
    state = "error"; syncFail(e);
    clearTimeout(pushTimer); pushTimer = setTimeout(push, 15000);
  }
  label();
}
const SYNCED = /^sdb\.(favs|myQuotes|lang|streak|last|log|quiz$|words$|wrong$|reminders$|custom$|music$|goals\.)/;
window.sdbOnLocalChange = k => {
  if (!user || applying || !SYNCED.test(k)) return;
  clearTimeout(pushTimer); pushTimer = setTimeout(push, 800);
};

/* ---------- weekly leaderboard: boards/{week}/entries/{uid} ---------- */
window.sdbBoard = {
  signedIn: () => !!user,
  me: () => store.get("sdb.boardName", null),
  suggestName: () => ((user && user.displayName) || "").split(" ")[0].slice(0, 20),
  async join(name, wk, minutes) {
    store.set("sdb.boardName", name.slice(0, 20));
    await setDoc(doc(db, "boards", wk, "entries", user.uid), { name: name.slice(0, 20), minutes: Math.min(10080, minutes), updatedAt: serverTimestamp() });
  },
  async leave(wk) {
    store.set("sdb.boardName", null);
    await deleteDoc(doc(db, "boards", wk, "entries", user.uid));
  },
  async top(wk) {
    const snap = await getDocs(query(collection(db, "boards", wk, "entries"), orderBy("minutes", "desc"), limit(20)));
    return snap.docs.map(d => ({ name: d.data().name, minutes: d.data().minutes, mine: user && d.id === user.uid }));
  }
};

/* ---------- auth ---------- */
async function start(u) {
  user = u;
  if (unsub) { unsub(); unsub = null; }
  if (window.sdbBoardChanged) window.sdbBoardChanged();
  if (!u) { window.sdbRemoteLogs = {}; drawStats(); label(); return; }
  state = "syncing"; label();
  const ref = doc(db, "users", u.uid);
  try {
    const snap = await getDoc(ref);
    const mergedKey = "sdb.merged." + u.uid;
    if (snap.exists()) {
      if (!store.get(mergedKey, false)) { mergeFirst(snap.data()); setTimeout(() => toast(ui().acMerged, "ok"), 1800); }
      else applyShared(snap.data().shared);
      applyLogs(snap.data().logs);
    }
    localStorage.setItem(mergedKey, "true");
    await push();
    unsub = onSnapshot(ref, s => {
      if (!s.exists() || s.metadata.hasPendingWrites) return;
      const d = s.data();
      if (d.updatedBy !== deviceId) applyShared(d.shared); // change came from another device
      applyLogs(d.logs);
    });
  } catch (e) { state = "error"; syncFail(e); }
  label(); drawAccount();
}

/* ---------- account dialog ---------- */
const $a = id => document.getElementById(id);
const box = $a("acBox");
const err = e => { const t = ui().acErr; $a("acErr").textContent = e ? (t[e.code] || t.other) : ""; if (e) console.warn(e); };
let deleteArmed = false;
const busy = (on, which) => {
  ["acGoogle", "acLogin", "acCreate"].forEach(id => { $a(id).disabled = on; });
  if (on && which) $a(which).textContent = ui().acBusy; else if (!on) drawAccount();
};
function drawAccount() {
  if (!box) return;
  const t = ui();
  $a("acClose").textContent = t.acClose;
  $a("acOut").hidden = !!user; $a("acIn").hidden = !user;
  if (!user) {
    $a("acTitle").textContent = t.acTitle; $a("acSub").textContent = t.acSub;
    $a("acGoogle").textContent = t.acGoogle; $a("acOr").textContent = t.acOr;
    $a("acEmail").placeholder = t.acEmail; $a("acPass").placeholder = t.acPass;
    $a("acLogin").textContent = t.acLogin; $a("acCreate").textContent = t.acCreate; $a("acForgot").textContent = t.acForgot;
    $a("acShow").textContent = $a("acPass").type === "password" ? t.acShow : t.acHide;
    if (!$a("acEmail").value) $a("acEmail").value = store.get("sdb.lastEmail", "") || "";
    return;
  }
  const name = fullName();
  $a("acTitle").textContent = t.acHello;
  const unverified = user.email && !user.emailVerified && (user.providerData || []).some(p => p.providerId === "password");
  $a("acVerify").hidden = !unverified;
  $a("acVerifyT").textContent = t.acVerifyT; $a("acVerifySend").textContent = t.acVerifySend;
  if (document.activeElement !== $a("acNameIn")) $a("acNameIn").value = user.displayName || "";
  $a("acNameIn").placeholder = t.acNamePh; $a("acNameSave").textContent = t.acNameSave;
  $a("acMoreT").textContent = t.acMoreT; $a("acPwReset").textContent = t.acPwReset; $a("acPwReset").hidden = !(user.providerData || []).some(p => p.providerId === "password");
  $a("acExport").textContent = t.acExport; $a("acDelete").textContent = deleteArmed ? t.acDeleteQ : t.acDelete; $a("acDeleteNote").textContent = t.acDeleteNote;
  $a("acName").textContent = name; $a("acMail").textContent = user.email || "";
  const av = $a("acAv");
  av.textContent = user.photoURL ? "" : (name[0] || "?").toUpperCase();
  av.style.backgroundImage = photo() ? `url('${photo()}')` : "";
  $a("acRemember").textContent = t.acRemember;
  $a("acSavedT").textContent = t.acSaved;
  const nCustom = ["cities", "companies", "quiz", "words"].reduce((n, k) => n + (custom[k] || []).length, 0) + myQuotes.length;
  const cells = [[favs.length, t.acFavs], [store.get("sdb.streak", 1), t.acStreak], [store.get("sdb.quiz", { total: 0 }).total, t.acQuiz], [nCustom, t.acCustom], [reminders.length, t.acRem]];
  $a("acGrid").innerHTML = cells.map(([n, l]) => `<div><b>${Number(n) || 0}</b><span>${esc(l)}</span></div>`).join("");
  $a("acLast").textContent = `${t.acLast}: ${lastSync ? new Date(lastSync).toLocaleString(lang === "zh" ? "zh-TW" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : t.acNever}`;
  $a("acSyncNow").textContent = t.acSyncNow; $a("acSignOut").textContent = t.acSignOut;
}
window.sdbDrawAccount = drawAccount;
const openBox = () => { err(null); drawAccount(); box.hidden = false; };
const closeBox = () => { box.hidden = true; };
btn.onclick = openBox;
$a("acClose").onclick = closeBox;
box.onclick = e => { if (e.target === box) closeBox(); };
document.addEventListener("keydown", e => { if (e.key === "Escape") closeBox(); });
const done = (msg) => { closeBox(); toast(msg || ui().acWelcome(shortName() || ""), "ok"); };
const rememberEmail = () => { const em = $a("acEmail").value.trim(); if (em) localStorage.setItem("sdb.lastEmail", JSON.stringify(em)); };
$a("acGoogle").onclick = async () => {
  err(null); busy(true, "acGoogle");
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try { await signInWithPopup(auth, provider); done(); }
  catch (e) {
    // popups are often blocked on phones and in home-screen apps
    if (/popup-blocked|operation-not-supported/i.test(e.code || "")) signInWithRedirect(auth, provider);
    else if (!/popup-closed|cancelled-popup/i.test(e.code || "")) err(e);
  } finally { busy(false); }
};
$a("acForm").onsubmit = async ev => {
  ev.preventDefault(); err(null); busy(true, "acLogin");
  try { await signInWithEmailAndPassword(auth, $a("acEmail").value.trim(), $a("acPass").value); rememberEmail(); $a("acPass").value = ""; done(); }
  catch (e) { err(e); } finally { busy(false); }
};
$a("acCreate").onclick = async () => {
  err(null);
  if (!$a("acForm").reportValidity()) return;
  busy(true, "acCreate");
  try {
    const cred = await createUserWithEmailAndPassword(auth, $a("acEmail").value.trim(), $a("acPass").value);
    rememberEmail(); $a("acPass").value = "";
    sendEmailVerification(cred.user).catch(() => {});
    done(ui().acCreated);
  }
  catch (e) { err(e); } finally { busy(false); }
};
$a("acForgot").onclick = async () => {
  const em = $a("acEmail").value.trim();
  if (!em) { $a("acErr").textContent = ui().acNeedEmail; return; }
  try { await sendPasswordResetEmail(auth, em); $a("acErr").textContent = ui().acResetSent; } catch (e) { err(e); }
};
$a("acShow").onclick = () => { const p = $a("acPass"); p.type = p.type === "password" ? "text" : "password"; drawAccount(); };
$a("acVerifySend").onclick = async () => { try { await sendEmailVerification(user); $a("acErr").textContent = ui().acVerifySent; } catch (e) { err(e); } };
$a("acNameSave").onclick = async () => {
  const n = $a("acNameIn").value.trim().slice(0, 30);
  try { await updateProfile(user, { displayName: n || null }); label(); drawAccount(); toast(ui().acNameSaved); } catch (e) { err(e); }
};
$a("acPwReset").onclick = async () => { try { await sendPasswordResetEmail(auth, user.email); $a("acErr").textContent = ui().acResetSent; } catch (e) { err(e); } };
$a("acExport").onclick = () => {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("sdb.")) { try { data[k] = JSON.parse(localStorage.getItem(k)); } catch (e) { data[k] = localStorage.getItem(k); } } }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: "skyline-daily-boost", exported: new Date().toISOString(), data }, null, 2)], { type: "application/json" }));
  a.download = `daily-boost-data-${todayKey()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$a("acDelete").onclick = async () => {
  if (!deleteArmed) { deleteArmed = true; drawAccount(); setTimeout(() => { deleteArmed = false; drawAccount(); }, 6000); return; }
  deleteArmed = false;
  const u = user;
  try {
    await deleteDoc(doc(db, "boards", weekKey(), "entries", u.uid)).catch(() => {});
    await deleteDoc(doc(db, "users", u.uid));
    await deleteUser(u);
    localStorage.removeItem("sdb.merged." + u.uid); localStorage.removeItem("sdb.boardName");
    closeBox(); toast(ui().acDeleted, "ok");
  } catch (e) { if (e.code === "auth/requires-recent-login") $a("acErr").textContent = ui().acRelogin; else err(e); drawAccount(); }
};
$a("acSyncNow").onclick = async () => { $a("acSyncNow").textContent = ui().acBusy; await push(); drawAccount(); };
$a("acSignOut").onclick = async () => { await signOut(auth); closeBox(); toast(ui().signedOut); };

getRedirectResult(auth).then(r => { if (r) toast(ui().signedIn); }).catch(e => { if (e && e.code) { openBox(); err(e); } });
onAuthStateChanged(auth, start);
label();
