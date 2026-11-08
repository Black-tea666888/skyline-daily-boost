// Cloud sync for Skyline Daily Boost (Firebase Auth + Firestore).
// Loaded only when firebase-config.js provides window.SDB_FIREBASE.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, doc, getDoc, setDoc, onSnapshot, serverTimestamp,
  collection, query, orderBy, limit, getDocs, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(window.SDB_FIREBASE);
const auth = getAuth(app);
let db;
try { db = initializeFirestore(app, { localCache: persistentLocalCache() }); } // works offline too
catch (e) { db = initializeFirestore(app, {}); }

const btn = document.getElementById("syncBtn");
const ui = () => UI[lang];

// one id per browser, so each device keeps its own focus log
let deviceId = store.get("sdb.device", null);
if (!deviceId) { deviceId = Math.random().toString(36).slice(2, 10); localStorage.setItem("sdb.device", JSON.stringify(deviceId)); }

let user = null, unsub = null, pushTimer = null, applying = false, state = "idle", armedSignOut = false;

function label() {
  btn.hidden = false;
  btn.textContent = !user ? ui().signIn : state === "syncing" ? ui().syncing : ui().synced;
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
    words: wordLv, wrong: wrongs, reminders, custom
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
    state = "idle";
    const bn = store.get("sdb.boardName", null);
    if (bn) await setDoc(doc(db, "boards", weekKey(), "entries", user.uid), { name: bn, minutes: weekMinutes(), updatedAt: serverTimestamp() });
  } catch (e) {
    state = "error"; toast(ui().syncErr); console.warn(e);
    clearTimeout(pushTimer); pushTimer = setTimeout(push, 15000);
  }
  label();
}
const SYNCED = /^sdb\.(favs|myQuotes|lang|streak|last|log|quiz$|words$|wrong$|reminders$|custom$|goals\.)/;
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
      if (!store.get(mergedKey, false)) mergeFirst(snap.data()); else applyShared(snap.data().shared);
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
  } catch (e) { state = "error"; toast(ui().syncErr); console.warn(e); }
  label();
}

btn.onclick = async () => {
  if (user) {
    if (!armedSignOut) { armedSignOut = true; toast(ui().signOutQ); setTimeout(() => armedSignOut = false, 3000); return; }
    armedSignOut = false;
    await signOut(auth); toast(ui().signedOut); return;
  }
  const provider = new GoogleAuthProvider();
  try { await signInWithPopup(auth, provider); toast(ui().signedIn); }
  catch (e) {
    // popups are often blocked on phones and in home-screen apps
    if (/popup|cancelled|operation-not-supported/i.test(e.code || "")) signInWithRedirect(auth, provider);
    else { toast(ui().syncErr); console.warn(e); }
  }
};

getRedirectResult(auth).then(r => { if (r) toast(ui().signedIn); }).catch(() => {});
onAuthStateChanged(auth, start);
label();
