// Pulse for Two: standalone backend connector.
// Provides the small `window.claude.use(...)` surface the app was written
// against (db, user, assets), backed by this site's own /api and a
// shared passcode instead of claude.ai accounts.
(() => {
  const PEOPLE = ["p1", "p2"];
  const KEY = "pulse-for-two.auth";
  const POLL_MS = 15000;

  let auth = null;
  try { auth = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) {}
  let state = { people: {}, days: {} };
  let loaded = false;
  const peopleListeners = new Set();
  const dayListeners = new Map(); // id -> Set
  let resolveReady; const ready = new Promise(r => { resolveReady = r; });
  let writes = 0, writeEpoch = 0;

  const clone = v => JSON.parse(JSON.stringify(v));
  const saveAuth = a => { auth = a; try { a ? localStorage.setItem(KEY, JSON.stringify(a)) : localStorage.removeItem(KEY); } catch (_) {} };

  async function api(path, opts = {}, code = auth && auth.code) {
    const headers = Object.assign({ "x-passcode": code || "" }, opts.headers || {});
    return fetch(path, Object.assign({}, opts, { headers }));
  }

  // ---------- Live state ----------
  function personDocs() {
    return PEOPLE.filter(p => state.people[p]).map(p => snap(p, state.people[p]));
  }
  function snap(id, data) { return { id, exists: true, data: () => clone(data), metadata: { fromCache: false, hasPendingWrites: false } }; }
  function query(docs) { return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: () => [] }; }
  function emit() {
    if (!loaded) return;
    peopleListeners.forEach(fn => { try { fn(query(personDocs())); } catch (e) { console.error(e); } });
    dayListeners.forEach((set, id) => {
      const docs = (state.days[id] || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map(d => snap(d.date, d));
      set.forEach(fn => { try { fn(query(docs)); } catch (e) { console.error(e); } });
    });
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
      state = { people: next.people || {}, days: next.days || {} };
      loaded = true; emit();
    } catch (_) { /* offline: keep showing what we have */ }
  }
  let timer = null;
  function startPolling() {
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  }

  async function write(path, body, apply) {
    apply(); emit();
    writes++; writeEpoch++;
    try {
      const r = await api(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 401) { logout("Your passcode changed. Log in again."); throw { code: "not_granted", message: "wrong passcode" }; }
      if (r.status === 400) throw { code: "invalid_argument", message: "rejected" };
      if (!r.ok) throw { code: "unavailable", message: "server error" };
    } catch (e) {
      if (e && e.code) throw e;
      throw { code: "unavailable", message: "offline" };
    } finally { writes--; writeEpoch++; }
  }

  // ---------- db ----------
  function docRef(path) {
    const seg = path.split("/");
    return {
      id: seg[seg.length - 1], path,
      async get() {
        if (seg.length === 2) return state.people[seg[1]] ? snap(seg[1], state.people[seg[1]]) : { id: seg[1], exists: false, data: () => undefined, metadata: {} };
        const d = (state.days[seg[1]] || []).find(x => x.date === seg[3]);
        return d ? snap(seg[3], d) : { id: seg[3], exists: false, data: () => undefined, metadata: {} };
      },
      async set(data) {
        if (seg[0] !== "logs" || !PEOPLE.includes(seg[1]) || seg[1] !== auth.me) throw { code: "invalid_argument", message: "not your data" };
        if (seg.length === 2) {
          return write("/api/person/" + seg[1], data, () => { state.people[seg[1]] = Object.assign({}, state.people[seg[1]] || {}, clone(data)); });
        }
        if (seg.length === 4 && seg[2] === "days") {
          return write(`/api/day/${seg[1]}/${seg[3]}`, data, () => {
            const list = (state.days[seg[1]] || []).filter(x => x.date !== seg[3]);
            list.push(Object.assign(clone(data), { date: seg[3] }));
            state.days[seg[1]] = list;
            if (!state.people[seg[1]]) state.people[seg[1]] = {};
          });
        }
        throw { code: "invalid_argument", message: "bad path" };
      },
      async update(data) { const cur = await this.get(); return this.set(Object.assign({}, cur.exists ? cur.data() : {}, data)); },
      async delete() { throw { code: "invalid_argument", message: "not supported" }; },
      onSnapshot() { return () => {}; },
      collection(sub) { return collRef(path + "/" + sub); },
    };
  }
  function collRef(path) {
    const seg = path.split("/");
    const q = {
      path,
      where() { return q; }, orderBy() { return q; }, limit() { return q; },
      async get() { return query(seg.length === 1 ? personDocs() : []); },
      onSnapshot(next) {
        let set;
        if (seg.length === 1) set = peopleListeners;
        else { if (!dayListeners.has(seg[1])) dayListeners.set(seg[1], new Set()); set = dayListeners.get(seg[1]); }
        set.add(next);
        if (loaded) setTimeout(emit, 0);
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
    async me() { const p = state.people[auth.me] || {}; return { id: auth.me, name: p.name || "", isOwner: true, canEdit: true }; },
    async profiles(ids) { const o = {}; (ids || []).forEach(id => { o[id] = { id, name: (state.people[id] && state.people[id].name) || "", isMe: auth && id === auth.me }; }); return o; },
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

  window.claude = { use: async name => { if (name === "db" || name === "user" || name === "assets") { await ready; return { db, user, assets }[name]; } return null; } };

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
  .gate-box .who-btn:hover{border-color:var(--red,#E0182D)}
  .gate-box .err{color:var(--red,#E0182D);font-weight:600;min-height:1.3em}
  .acct{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}`;
  const st = document.createElement("style"); st.textContent = css; document.head.append(st);
  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="var(--red,#E0182D)" d="M12 21.6C5.4 16.3 1.5 12.6 1.5 8.4 1.5 5.4 3.9 3 6.9 3c1.9 0 3.7.9 5.1 2.5C13.4 3.9 15.2 3 17.1 3c3 0 5.4 2.4 5.4 5.4 0 4.2-3.9 7.9-10.5 13.2z"/></svg>';
  let gate = null;
  function showGate(msg) {
    if (gate) gate.remove();
    gate = document.createElement("div"); gate.className = "gate"; gate.setAttribute("role", "dialog"); gate.setAttribute("aria-modal", "true"); gate.setAttribute("aria-label", "Log in");
    const box = document.createElement("form"); box.className = "gate-box"; box.noValidate = true;
    box.innerHTML = HEART + '<h1>Pulse for Two</h1><p>Enter the passcode you two share.</p>' +
      '<input id="gate-code" type="password" autocomplete="current-password" placeholder="Passcode" aria-label="Passcode">' +
      '<button class="go" type="submit">Unlock</button><div class="err" role="alert"></div>';
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
        const s = await r.json(); state = { people: s.people || {}, days: s.days || {} };
        pickPerson(code);
      } catch (_) { err.textContent = "Can't reach the app. Check your connection."; }
    });
    gate.append(box); document.body.append(gate); box.querySelector("#gate-code").focus();
  }
  function pickPerson(code) {
    const box = gate.querySelector(".gate-box"); box.replaceChildren();
    box.insertAdjacentHTML("beforeend", HEART + "<h1>Who are you?</h1><p>This phone will remember you.</p>");
    PEOPLE.forEach((p, i) => {
      const name = state.people[p] && state.people[p].name;
      const b = document.createElement("button"); b.type = "button"; b.className = "who-btn";
      b.textContent = name ? "I'm " + name : (i === 0 ? "Person 1 (not set up yet)" : "Person 2 (not set up yet)");
      b.addEventListener("click", () => name ? finish(code, p) : askName(code, p));
      box.append(b);
    });
  }
  function askName(code, p) {
    const box = gate.querySelector(".gate-box"); box.replaceChildren();
    box.insertAdjacentHTML("beforeend", HEART + "<h1>Nice to meet you</h1><p>What's your first name?</p>" +
      '<input id="gate-name" type="text" maxlength="30" autocomplete="given-name" placeholder="First name" aria-label="First name"><button class="go" type="button">Start</button><div class="err" role="alert"></div>');
    const go = async () => {
      const name = box.querySelector("#gate-name").value.trim(); const err = box.querySelector(".err");
      if (!name) { err.textContent = "Type your name first."; return; }
      err.textContent = "Saving…";
      try {
        const r = await api("/api/person/" + p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }, code);
        if (!r.ok) { err.textContent = "Couldn't save. Try again."; return; }
        state.people[p] = await r.json(); finish(code, p);
      } catch (_) { err.textContent = "Can't reach the app. Check your connection."; }
    };
    box.querySelector(".go").addEventListener("click", go);
    box.querySelector("#gate-name").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
    box.querySelector("#gate-name").focus();
  }
  function finish(code, me) {
    saveAuth({ code, me }); if (gate) { gate.remove(); gate = null; }
    loaded = true; resolveReady(); emit(); startPolling(); refresh(); addAccountCard();
  }
  function logout(msg) { saveAuth(null); clearInterval(timer); try { sessionStorage.setItem("pulse-msg", msg || ""); } catch (_) {} location.replace(location.pathname); }
  function addAccountCard() {
    const host = document.getElementById("v-log"); if (!host || document.getElementById("acct")) return;
    const c = document.createElement("div"); c.className = "card acct"; c.id = "acct";
    const t = document.createElement("span"); const p = state.people[auth.me] || {};
    t.textContent = "This phone is logged in as " + (p.name || "you") + ".";
    const b = document.createElement("button"); b.type = "button"; b.className = "pill"; b.textContent = "Log out or switch person";
    b.addEventListener("click", () => logout());
    c.append(t, b); host.append(c);
  }

  // Start: returning phones go straight in, new ones see the passcode screen.
  if (auth && auth.code && PEOPLE.includes(auth.me)) {
    (async () => {
      try {
        const r = await api("/api/state");
        if (r.status === 401) { logout("Enter the passcode to continue."); return; }
        if (r.ok) { const s = await r.json(); state = { people: s.people || {}, days: s.days || {} }; }
      } catch (_) { /* offline: start with nothing and keep polling */ }
      loaded = true; resolveReady(); emit(); startPolling(); addAccountCard();
    })();
  } else {
    let msg = ""; try { msg = sessionStorage.getItem("pulse-msg") || ""; sessionStorage.removeItem("pulse-msg"); } catch (_) {}
    showGate(msg);
  }
})();
