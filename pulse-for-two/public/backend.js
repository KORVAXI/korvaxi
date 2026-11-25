// Pulse for Two: standalone backend connector.
// Provides the `window.claude.use(...)` surface the app was written against
// (db, user, assets), backed by this site's own /api and a shared passcode.
// Also adds the login screen and the "Phone notifications" switch.
(() => {
  const PEOPLE = ["p1", "p2"];
  const KEY = "pulse-for-two.auth";
  const POLL_MS = 15000;

  let auth = null;
  try { auth = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) {}
  let docs = {};            // path -> data
  let loaded = false;
  const collListeners = new Map(); // collection path -> Set(fn)
  const docListeners = new Map();  // doc path -> Set(fn)
  let resolveReady; const ready = new Promise(r => { resolveReady = r; });
  let writes = 0, writeEpoch = 0;

  const clone = v => JSON.parse(JSON.stringify(v));
  const saveAuth = a => { auth = a; try { a ? localStorage.setItem(KEY, JSON.stringify(a)) : localStorage.removeItem(KEY); } catch (_) {} };
  async function api(path, opts = {}, code = auth && auth.code) {
    const headers = Object.assign({ "x-passcode": code || "", "x-person": (auth && auth.me) || "" }, opts.headers || {});
    return fetch(path, Object.assign({}, opts, { headers }));
  }

  // ---------- Live data ----------
  const meta = { fromCache: false, hasPendingWrites: false };
  const snap = (path, data) => ({ id: path.split("/").pop(), exists: data !== undefined, data: () => (data === undefined ? undefined : clone(data)), metadata: meta });
  const query = list => ({ docs: list, size: list.length, empty: !list.length, metadata: meta, docChanges: () => [] });
  function listColl(path) {
    const n = path.split("/").length + 1;
    return Object.keys(docs).filter(k => k.startsWith(path + "/") && k.split("/").length === n).sort().reverse().map(k => snap(k, docs[k]));
  }
  function emit() {
    if (!loaded) return;
    collListeners.forEach((set, path) => { const q = query(listColl(path)); set.forEach(fn => { try { fn(q); } catch (e) { console.error(e); } }); });
    docListeners.forEach((set, path) => { const s = snap(path, docs[path]); set.forEach(fn => { try { fn(s); } catch (e) { console.error(e); } }); });
  }
  async function refresh() {
    if (!auth) return;
    const epoch = writeEpoch;
    try {
      const r = await api("/api/state");
      if (r.status === 401) { logout("That passcode no longer works. Enter the new one."); return; }
      if (!r.ok) return;
      const next = await r.json();
      if (writes > 0 || epoch !== writeEpoch) return; // a save happened meanwhile; the next poll catches up
      docs = next.docs || {}; loaded = true; emit();
    } catch (_) { /* offline: keep what we have */ }
  }
  let timer = null;
  function startPolling() {
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  }
  const mine = path => { const s = path.split("/"); return s[0] !== "logs" || s[1] === (auth && auth.me) || (s.length === 4 && s[2] === "days"); };
  async function send(path, method, body, apply) {
    if (!mine(path)) throw { code: "invalid_argument", message: "not your data" };
    apply(); emit(); writes++; writeEpoch++;
    try {
      const r = await api("/api/doc?path=" + encodeURIComponent(path), { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 401) { logout("Your passcode changed. Log in again."); throw { code: "not_granted", message: "wrong passcode" }; }
      if (r.status === 400 || r.status === 403) throw { code: "invalid_argument", message: "rejected" };
      if (!r.ok) throw { code: "unavailable", message: "server error" };
    } catch (e) { if (e && e.code) throw e; throw { code: "unavailable", message: "offline" }; }
    finally { writes--; writeEpoch++; }
  }

  // ---------- db ----------
  function docRef(path) {
    return {
      id: path.split("/").pop(), path,
      async get() { return snap(path, docs[path]); },
      set(data) { const isPerson = /^logs\/p[12]$/.test(path); return send(path, "PUT", data, () => { docs[path] = isPerson ? Object.assign({}, docs[path] || {}, clone(data)) : clone(data); }); },
      async update(data) { return this.set(Object.assign({}, docs[path] || {}, data)); },
      delete() { return send(path, "DELETE", null, () => { delete docs[path]; }); },
      onSnapshot(next) {
        if (!docListeners.has(path)) docListeners.set(path, new Set()); const set = docListeners.get(path); set.add(next);
        if (loaded) setTimeout(() => next(snap(path, docs[path])), 0);
        return () => set.delete(next);
      },
      collection(sub) { return collRef(path + "/" + sub); },
    };
  }
  function collRef(path) {
    const q = {
      path, where() { return q; }, orderBy() { return q; }, limit() { return q; },
      async get() { return query(listColl(path)); },
      onSnapshot(next) {
        if (!collListeners.has(path)) collListeners.set(path, new Set()); const set = collListeners.get(path); set.add(next);
        if (loaded) setTimeout(() => next(query(listColl(path))), 0);
        return () => set.delete(next);
      },
      doc(id) { return docRef(path + "/" + (id || Math.random().toString(36).slice(2, 10))); },
      async add(data) { const d = q.doc(); await d.set(data); return d; },
    };
    return q;
  }
  const db = { doc: docRef, collection: collRef };

  // ---------- user ----------
  const user = {
    async id() { return auth ? auth.me : null; },
    async me() { const p = docs["logs/" + auth.me] || {}; return { id: auth.me, name: p.name || "", isOwner: true, canEdit: true }; },
    async profiles(ids) { const o = {}; (ids || []).forEach(id => { o[id] = { id, name: (docs["logs/" + id] && docs["logs/" + id].name) || "", isMe: !!auth && id === auth.me }; }); return o; },
    async isOwner() { return true; }, async canEdit() { return true; },
  };

  // ---------- assets (photos) ----------
  const assets = {
    async upload(blob, opts = {}) {
      let r;
      try { r = await api("/api/photo", { method: "POST", headers: { "content-type": opts.type || blob.type || "image/jpeg" }, body: blob }); }
      catch (_) { throw { code: "store_unavailable", message: "offline" }; }
      if (r.status === 413) throw { code: "too_large", message: "too large" };
      if (r.status === 415) throw { code: "unsupported_type", message: "unsupported" };
      if (r.status === 401) throw { code: "not_granted", message: "wrong passcode" };
      if (!r.ok) throw { code: "upstream_error", message: "server error" };
      const { id } = await r.json();
      return { id, url: "/api/photo/" + id, sizeBytes: blob.size, contentType: opts.type || blob.type };
    },
    async delete(id) { await api("/api/photo/" + encodeURIComponent(id), { method: "DELETE" }); return { ok: true }; },
  };

  // Weather for Mochi's yard (the app turns this feature on when it finds this function)
  window.pulseWeather = async ({ lat, lon, city }) => {
    const q = city ? "city=" + encodeURIComponent(city) : `lat=${lat}&lon=${lon}`;
    const r = await api("/api/weather?" + q); if (!r.ok) throw new Error("weather");
    return r.json();
  };

  window.claude = { use: async name => { if (name === "db" || name === "user" || name === "assets") { await ready; return { db, user, assets }[name]; } return null; } };

  // ---------- Phone notifications ----------
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  const installed = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  function b64ToBytes(s) { const pad = "=".repeat((4 - s.length % 4) % 4); const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
  async function currentSub() { if (!pushSupported()) return null; const reg = await navigator.serviceWorker.getRegistration("/"); return reg ? reg.pushManager.getSubscription() : null; }
  async function enablePush(statusEl) {
    const say = t => { statusEl.textContent = t; };
    if (!pushSupported()) { say(isIOS() && !installed() ? "On iPhone: tap Share, then Add to Home Screen. Open the app from your home screen and turn this on there." : "This browser can't show notifications. Try Chrome on Android, or add the app to your iPhone home screen."); return false; }
    const keyRes = await api("/api/push/key").then(r => r.json()).catch(() => ({}));
    if (!keyRes.key) { say("Notifications aren't set up on the server yet."); return false; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { say("Notifications are blocked. Allow them for this app in your phone's settings, then try again."); return false; }
    const reg = await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(keyRes.key) });
    const r = await api("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sub: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
    if (!r.ok) { say("Couldn't turn notifications on. Try again."); return false; }
    say("On for this phone."); return true;
  }
  async function disablePush(statusEl) {
    const sub = await currentSub();
    if (sub) { await api("/api/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
    statusEl.textContent = "Off for this phone.";
  }
  async function refreshPushSub() { // keeps the server's copy (and time zone) fresh
    try { const sub = await currentSub(); if (sub && Notification.permission === "granted") await api("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sub: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }) }); } catch (_) {}
  }
  async function addSettingsCards() {
    const host = document.getElementById("v-log"); if (!host || document.getElementById("acct")) return;
    const card = document.createElement("div"); card.className = "card"; card.id = "push-card";
    card.innerHTML = '<div class="row between"><div><h3>Phone notifications</h3><p class="muted" style="font-size:.85rem" id="push-status"></p></div><span class="seg" role="group" aria-label="Phone notifications"><button class="pill" type="button" id="push-on">On</button><button class="pill" type="button" id="push-off">Off</button></span></div><button class="link" type="button" id="push-test" hidden>Send a test</button>';
    const after = document.getElementById("buddy-settings") || host.querySelector("h2").parentElement;
    after.insertAdjacentElement("afterend", card);
    const st = card.querySelector("#push-status"), on = card.querySelector("#push-on"), off = card.querySelector("#push-off"), test = card.querySelector("#push-test");
    const mark = async () => { const has = !!(await currentSub()) && Notification.permission === "granted"; on.setAttribute("aria-pressed", String(has)); off.setAttribute("aria-pressed", String(!has)); test.hidden = !has;
      if (!st.textContent) st.textContent = has ? "On for this phone." : (pushSupported() ? "Get reminders, hearts and meal plans even when the app is closed." : (isIOS() && !installed() ? "On iPhone: tap Share, then Add to Home Screen. Open the app from there to turn this on." : "This browser can't show notifications.")); };
    on.addEventListener("click", async () => { st.textContent = "Turning on…"; await enablePush(st).catch(() => { st.textContent = "Couldn't turn notifications on. Try again."; }); mark(); });
    off.addEventListener("click", async () => { await disablePush(st).catch(() => {}); mark(); });
    test.addEventListener("click", async () => { const r = await api("/api/push/test", { method: "POST" }).then(x => x.json()).catch(() => ({})); st.textContent = r.sent ? "Test sent. Check your phone." : "Couldn't send a test. Turn notifications off and on again."; });
    mark();
    const acct = document.createElement("div"); acct.className = "card acct"; acct.id = "acct";
    const t = document.createElement("span"); const p = docs["logs/" + auth.me] || {}; t.textContent = "This phone is logged in as " + (p.name || "you") + ".";
    const b = document.createElement("button"); b.type = "button"; b.className = "pill"; b.textContent = "Log out or switch person"; b.addEventListener("click", () => logout());
    acct.append(t, b); host.append(acct);
  }

  // ---------- Login screen ----------
  const css = `
  .gate{position:fixed;inset:0;z-index:60;background:var(--bg,#FFF4F4);display:flex;align-items:center;justify-content:center;
    padding:calc(24px + env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) calc(24px + env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));overflow:auto}
  .gate-box{width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px;text-align:center}
  .gate-box svg{width:64px;height:64px;margin:0 auto}
  .gate-box h1{font-family:var(--display,system-ui);color:var(--red,#E0182D);font-size:2rem;margin:0}
  .gate-box p{margin:0;color:var(--muted,#84585D)}
  .gate-box input{font:inherit;font-size:1.1rem;text-align:center;color:var(--ink,#2B0C10);background:var(--surface,#fff);border:1px solid var(--line,#F4D3D6);border-radius:14px;padding:14px}
  .gate-box .go{border:0;border-radius:14px;padding:14px;background:var(--red,#E0182D);color:#fff;font:600 1.1rem var(--display,system-ui);cursor:pointer}
  .gate-box .who-btn{border:2px solid var(--line,#F4D3D6);background:var(--surface,#fff);color:var(--ink,#2B0C10);border-radius:16px;padding:16px;font:600 1.15rem var(--display,system-ui);cursor:pointer}
  .gate-box .err{color:var(--red,#E0182D);font-weight:600;min-height:1.3em}
  .acct{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}`;
  const stl = document.createElement("style"); stl.textContent = css; document.head.append(stl);
  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="var(--red,#E0182D)" d="M12 21.6C5.4 16.3 1.5 12.6 1.5 8.4 1.5 5.4 3.9 3 6.9 3c1.9 0 3.7.9 5.1 2.5C13.4 3.9 15.2 3 17.1 3c3 0 5.4 2.4 5.4 5.4 0 4.2-3.9 7.9-10.5 13.2z"/></svg>';
  let gate = null;
  function showGate(msg) {
    if (gate) gate.remove();
    gate = document.createElement("div"); gate.className = "gate"; gate.setAttribute("role", "dialog"); gate.setAttribute("aria-modal", "true"); gate.setAttribute("aria-label", "Log in");
    const box = document.createElement("form"); box.className = "gate-box"; box.noValidate = true;
    box.innerHTML = HEART + '<h1>Pulse for Two</h1><p>Enter the passcode you two share.</p><input id="gate-code" type="password" autocomplete="current-password" placeholder="Passcode" aria-label="Passcode"><button class="go" type="submit">Unlock</button><div class="err" role="alert"></div>';
    box.querySelector(".err").textContent = msg || "";
    box.addEventListener("submit", async e => {
      e.preventDefault();
      const code = box.querySelector("#gate-code").value.trim(); const err = box.querySelector(".err");
      if (!code) { err.textContent = "Type the passcode first."; return; }
      err.textContent = "Checking…";
      try {
        const r = await api("/api/state", {}, code);
        if (r.status === 401) { err.textContent = "That passcode isn't right. Try again."; return; }
        if (r.status === 500) { const b = await r.json().catch(() => ({})); err.textContent = b.error === "not_configured" ? "The app isn't set up yet. Add APP_PASSCODE in the Netlify site settings." : "Something went wrong. Try again."; return; }
        if (!r.ok) { err.textContent = "Something went wrong. Try again."; return; }
        docs = (await r.json()).docs || {}; pickPerson(code);
      } catch (_) { err.textContent = "Can't reach the app. Check your connection."; }
    });
    gate.append(box); document.body.append(gate); box.querySelector("#gate-code").focus();
  }
  function pickPerson(code) {
    const box = gate.querySelector(".gate-box"); box.replaceChildren();
    box.insertAdjacentHTML("beforeend", HEART + "<h1>Who are you?</h1><p>This phone will remember you.</p>");
    PEOPLE.forEach((p, i) => {
      const name = docs["logs/" + p] && docs["logs/" + p].name;
      const b = document.createElement("button"); b.type = "button"; b.className = "who-btn";
      b.textContent = name ? "I'm " + name : `Person ${i + 1} (not set up yet)`;
      b.addEventListener("click", () => (name ? finish(code, p) : askName(code, p)));
      box.append(b);
    });
  }
  function askName(code, p) {
    const box = gate.querySelector(".gate-box"); box.replaceChildren();
    box.insertAdjacentHTML("beforeend", HEART + "<h1>Nice to meet you</h1><p>What's your first name?</p><input id=\"gate-name\" type=\"text\" maxlength=\"30\" autocomplete=\"given-name\" placeholder=\"First name\" aria-label=\"First name\"><button class=\"go\" type=\"button\">Start</button><div class=\"err\" role=\"alert\"></div>");
    const go = async () => {
      const name = box.querySelector("#gate-name").value.trim(); const err = box.querySelector(".err");
      if (!name) { err.textContent = "Type your name first."; return; }
      err.textContent = "Saving…";
      try {
        const r = await fetch("/api/doc?path=" + encodeURIComponent("logs/" + p), { method: "PUT", headers: { "content-type": "application/json", "x-passcode": code, "x-person": p }, body: JSON.stringify({ name }) });
        if (!r.ok) { err.textContent = "Couldn't save. Try again."; return; }
        docs["logs/" + p] = Object.assign({}, docs["logs/" + p] || {}, { name }); finish(code, p);
      } catch (_) { err.textContent = "Can't reach the app. Check your connection."; }
    };
    box.querySelector(".go").addEventListener("click", go);
    box.querySelector("#gate-name").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
    box.querySelector("#gate-name").focus();
  }
  function begin() { loaded = true; resolveReady(); emit(); startPolling(); setTimeout(addSettingsCards, 0); refreshPushSub(); }
  function finish(code, me) { saveAuth({ code, me }); if (gate) { gate.remove(); gate = null; } begin(); refresh(); }
  function logout(msg) { saveAuth(null); clearInterval(timer); try { sessionStorage.setItem("pulse-msg", msg || ""); } catch (_) {} location.replace(location.pathname); }

  // Start: returning phones go straight in, new ones see the passcode screen.
  if (auth && auth.code && PEOPLE.includes(auth.me)) {
    (async () => {
      try {
        const r = await api("/api/state");
        if (r.status === 401) { logout("Enter the passcode to continue."); return; }
        if (r.ok) docs = (await r.json()).docs || {};
      } catch (_) { /* offline: start empty and keep polling */ }
      begin();
    })();
  } else {
    let msg = ""; try { msg = sessionStorage.getItem("pulse-msg") || ""; sessionStorage.removeItem("pulse-msg"); } catch (_) {}
    if (document.body) showGate(msg); else document.addEventListener("DOMContentLoaded", () => showGate(msg));
  }
})();
