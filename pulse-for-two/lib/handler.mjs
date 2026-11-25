// API for Pulse for Two (standalone version).
// Storage-agnostic: pass any store with the Netlify Blobs interface
// (get, getWithMetadata, setJSON, set, delete).
//
// The app saves "documents" by path, the same paths it uses on claude.ai:
//   logs/<p>                 -> person/<p>                 (goals, name, settings)
//   logs/<p>/days/<date>     -> month/<p>/<YYYY-MM>        { "<date>": day }
//   logs/<p>/usuals/<id>     -> usuals/<p>                 { "<id>": usual }
//   plans/<p>_<date>         -> plans/<YYYY-MM>            { "<p>_<date>": plan }
//   shared/<id>              -> shared                     { "<id>": doc }
// plus photo/<32 hex> (image bytes) and push/<p>, pushstate/<p> for notifications.

import webpush from "web-push";

export const PEOPLE = ["p1", "p2"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHOTO = /^[a-f0-9]{32}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PHOTO = 4 * 1024 * 1024;
const MAX_DOC = 200000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
const num = v => { const x = typeof v === "number" ? v : parseFloat(v); return Number.isFinite(x) ? x : null; };
const partnerOf = p => (p === "p1" ? "p2" : "p1");

function monthKeys(now = new Date()) {
  const out = [];
  for (let i = -3; i <= 1; i++) out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
  return out;
}

async function readJson(req, max) {
  const text = await req.text();
  if (text.length > max) return null;
  try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

function sniffImage(buf) {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

// Where a document path lives in storage, and who may write it.
function locate(path) {
  const s = String(path || "").split("/");
  if (s[0] === "logs" && PEOPLE.includes(s[1])) {
    if (s.length === 2) return { blob: "person/" + s[1], key: null, owner: s[1], merge: true };
    // Either of you may log in the other's diary; settings and saved meals stay personal.
    if (s.length === 4 && s[2] === "days" && DATE.test(s[3])) return { blob: `month/${s[1]}/${s[3].slice(0, 7)}`, key: s[3], owner: null, diaryOf: s[1], kind: "day" };
    if (s.length === 4 && s[2] === "usuals" && ID.test(s[3])) return { blob: "usuals/" + s[1], key: s[3], owner: s[1] };
  }
  if (s[0] === "plans" && s.length === 2) {
    const m = /^(p1|p2)_(\d{4}-\d{2}-\d{2})$/.exec(s[1]);
    if (m) return { blob: "plans/" + m[2].slice(0, 7), key: s[1], owner: null, kind: "plan", planFor: m[1], date: m[2] };
  }
  if (s[0] === "shared" && s.length === 2 && ID.test(s[1])) return { blob: "shared", key: s[1], owner: null };
  return null;
}

// ---------- Push notifications ----------
let vapidReady = null;
function setupVapid(env) {
  if (vapidReady !== null) return vapidReady;
  const pub = env("VAPID_PUBLIC_KEY"), priv = env("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return (vapidReady = false);
  webpush.setVapidDetails(env("VAPID_SUBJECT") || "https://example.com", pub, priv);
  return (vapidReady = true);
}
export async function sendPush(store, env, person, payload) {
  if (!setupVapid(env)) return 0;
  const rec = (await store.get("push/" + person, { type: "json" })) || { subs: [] };
  let sent = 0; const keep = [];
  for (const sub of rec.subs || []) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "high" }); sent++; keep.push(sub); }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) continue; keep.push(sub); }
  }
  if (keep.length !== (rec.subs || []).length) await store.setJSON("push/" + person, { ...rec, subs: keep });
  return sent;
}
const nameOf = async (store, p) => ((await store.get("person/" + p, { type: "json" })) || {}).name || "Your partner";
function dayLabel(date, tz) {
  const today = localNow(tz).date;
  if (date === today) return "today";
  const t = new Date(today + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + 1);
  if (date === t.toISOString().slice(0, 10)) return "tomorrow";
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

// Tell the partner about reminders, hearts and planned meals.
async function afterWrite(store, env, loc, prev, next, writer) {
  if (loc.kind === "day") {
    if (writer && writer !== loc.diaryOf) {
      const prevIds = new Set((Array.isArray(prev && prev.meals) ? prev.meals : []).map(m => m && m.id));
      const added = (Array.isArray(next.meals) ? next.meals : []).filter(m => m && !prevIds.has(m.id));
      if (added.length) await sendPush(store, env, loc.diaryOf, { title: `${await nameOf(store, writer)} logged food for you`, body: `${added[0].name || "Food"}${added.length > 1 ? ` and ${added.length - 1} more` : ""}`, tag: "logged" });
      return;
    }
    const to = partnerOf(loc.diaryOf); const from = await nameOf(store, loc.diaryOf);
    const seen = new Set((Array.isArray(prev && prev.nudges) ? prev.nudges : []).map(x => x && x.at));
    for (const nd of Array.isArray(next.nudges) ? next.nudges : []) {
      if (!nd || seen.has(nd.at) || nd.to !== to) continue;
      await sendPush(store, env, to, { title: `${from} says`, body: String(nd.text || "Time to eat!").slice(0, 120), tag: "nudge" });
    }
    const before = num(prev && prev.love) || 0, after = num(next.love) || 0;
    if (after > before) {
      const st = (await store.get("pushstate/" + to, { type: "json" })) || {};
      if (!st.loveAt || Date.now() - st.loveAt > 5 * 60000) {
        await store.setJSON("pushstate/" + to, { ...st, loveAt: Date.now() });
        await sendPush(store, env, to, { title: `${from} sent you a heart`, body: "Open the app to send one back.", tag: "love" });
      }
    }
  }
  if (loc.kind === "plan" && writer && writer !== loc.planFor) {
    const prevIds = new Set((Array.isArray(prev && prev.items) ? prev.items : []).map(i => i && i.id));
    const added = (Array.isArray(next.items) ? next.items : []).filter(i => i && !prevIds.has(i.id) && i.by === writer);
    if (added.length) {
      const from = await nameOf(store, writer); const rec = (await store.get("push/" + loc.planFor, { type: "json" })) || {};
      const i = added[0]; const more = added.length > 1 ? ` and ${added.length - 1} more` : "";
      await sendPush(store, env, loc.planFor, { title: `${from} planned a meal for you`, body: `${i.name}${more} for your ${String(i.slot || "meal").toLowerCase()} ${dayLabel(loc.date, rec.tz)}`, tag: "plan" });
    }
  }
}

// ---------- Meal-timer reminders (run every 15 minutes) ----------
function localNow(tz) {
  let zone = "UTC"; try { if (tz) { new Intl.DateTimeFormat("en-US", { timeZone: tz }); zone = tz; } } catch { zone = "UTC"; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
const SLOT_TIME = { Breakfast: "08:00", Lunch: "13:00", Dinner: "19:00", Snack: "16:00" };
const hm = t => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
export async function runReminders(store, env) {
  const out = [];
  for (const p of PEOPLE) {
    const person = (await store.get("person/" + p, { type: "json" })) || {};
    const push = (await store.get("push/" + p, { type: "json" })) || {};
    if (person.remindOn === false || !(push.subs || []).length) continue;
    const { date, minutes } = localNow(push.tz);
    if (minutes < 7 * 60 || minutes >= 22 * 60) continue;
    const month = (await store.get(`month/${p}/${date.slice(0, 7)}`, { type: "json" })) || {};
    const meals = (Array.isArray(month[date] && month[date].meals) ? month[date].meals : [])
      .map(m => ({ m, t: /^\d{2}:\d{2}$/.test(m && m.time) ? m.time : SLOT_TIME[m && m.slot] || "16:00" })).filter(x => hm(x.t) <= minutes + 5).sort((a, b) => hm(a.t) - hm(b.t));
    const last = meals[meals.length - 1];
    const since = minutes - (last ? hm(last.t) : 7 * 60);
    const hours = num(person.remindHours) >= 1 ? num(person.remindHours) : 3;
    if (since < hours * 60) continue;
    const key = date + "|" + (last ? last.m.id : "none");
    const st = (await store.get("pushstate/" + p, { type: "json" })) || {};
    if (st.remindKey === key && Date.now() - (st.remindAt || 0) < 2 * 3600000) continue;
    await store.setJSON("pushstate/" + p, { ...st, remindKey: key, remindAt: Date.now() });
    const h = Math.floor(since / 60), m = since % 60;
    const body = last ? `It's been ${h}h ${m}m since you last ate. Grab something and log it.` : "You haven't logged any food today. Eat something and add it to the app.";
    out.push([p, await sendPush(store, env, p, { title: "Time to eat!", body, tag: "remind" })]);
  }
  return out;
}

// ---------- Weather (Open-Meteo, free, no key) ----------
async function weather(url, fetchImpl, store) {
  const city = (url.searchParams.get("city") || "").trim().slice(0, 60);
  if (city) {
    const r = await fetchImpl("https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=" + encodeURIComponent(city));
    if (!r.ok) return json({ error: "lookup_failed" }, 502);
    const g = ((await r.json()).results || [])[0];
    if (!g) return json({ place: null });
    return json({ place: [g.name, g.admin1 && g.admin1 !== g.name ? g.admin1 : null, g.country_code].filter(Boolean).join(", "), lat: Math.round(g.latitude * 100) / 100, lon: Math.round(g.longitude * 100) / 100 });
  }
  const lat = num(url.searchParams.get("lat")), lon = num(url.searchParams.get("lon"));
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: "bad_request" }, 400);
  const key = `wxcache/${lat.toFixed(1)}_${lon.toFixed(1)}`;
  const cached = await store.get(key, { type: "json" });
  if (cached && Date.now() - cached.at < 20 * 60000) return json(cached);
  const r = await fetchImpl(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day,wind_speed_10m&timezone=auto`);
  if (!r.ok) return cached ? json(cached) : json({ error: "weather_failed" }, 502);
  const c = (await r.json()).current || {};
  const out = { temp: num(c.temperature_2m), code: num(c.weather_code), isDay: c.is_day === 1, wind: num(c.wind_speed_10m), at: Date.now() };
  await store.setJSON(key, out);
  return json(out);
}

export function createHandler({ store, passcode, env = () => undefined, fetchImpl = (...a) => fetch(...a) }) {
  return async function handle(req) {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);

    // Photos are served by unguessable id so <img> tags can load them.
    if (req.method === "GET" && parts[0] === "photo" && PHOTO.test(parts[1] || "")) {
      const r = await store.getWithMetadata("photo/" + parts[1], { type: "arrayBuffer" });
      if (!r) return new Response("Not found", { status: 404 });
      return new Response(r.data, { headers: { "content-type": (r.metadata && r.metadata.type) || "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } });
    }

    if (!passcode) return json({ error: "not_configured" }, 500);
    if (!safeEqual(req.headers.get("x-passcode") || "", passcode)) return json({ error: "wrong_passcode" }, 401);
    const me = PEOPLE.includes(req.headers.get("x-person")) ? req.headers.get("x-person") : null;

    if (req.method === "GET" && parts[0] === "state") {
      const docs = {}; const months = monthKeys();
      await Promise.all(PEOPLE.map(async p => {
        const person = await store.get("person/" + p, { type: "json" }); if (person) docs["logs/" + p] = person;
        const ms = await Promise.all(months.map(m => store.get(`month/${p}/${m}`, { type: "json" })));
        ms.filter(Boolean).forEach(m => Object.entries(m).forEach(([d, v]) => { docs[`logs/${p}/days/${d}`] = v; }));
        const us = (await store.get("usuals/" + p, { type: "json" })) || {};
        Object.entries(us).forEach(([id, v]) => { docs[`logs/${p}/usuals/${id}`] = v; });
      }));
      const plans = await Promise.all(months.map(m => store.get("plans/" + m, { type: "json" })));
      plans.filter(Boolean).forEach(m => Object.entries(m).forEach(([k, v]) => { docs["plans/" + k] = v; }));
      const shared = (await store.get("shared", { type: "json" })) || {};
      Object.entries(shared).forEach(([k, v]) => { docs["shared/" + k] = v; });
      return json({ docs });
    }

    if (parts[0] === "doc" && (req.method === "PUT" || req.method === "DELETE")) {
      const loc = locate(url.searchParams.get("path"));
      if (!loc) return json({ error: "bad_path" }, 400);
      if (loc.owner && loc.owner !== me) return json({ error: "not_yours" }, 403);
      if (req.method === "DELETE") {
        if (!loc.key) return json({ error: "bad_path" }, 400);
        const blob = (await store.get(loc.blob, { type: "json" })) || {}; delete blob[loc.key]; await store.setJSON(loc.blob, blob);
        return json({ ok: true });
      }
      const body = await readJson(req, MAX_DOC);
      if (!body) return json({ error: "bad_request" }, 400);
      let prev = null, next = body;
      if (loc.key === null) {
        prev = (await store.get(loc.blob, { type: "json" })) || {};
        next = loc.merge ? { ...prev, ...body } : body;
        if (typeof next.name === "string") next.name = next.name.trim().slice(0, 30);
        await store.setJSON(loc.blob, next);
      } else {
        const blob = (await store.get(loc.blob, { type: "json" })) || {};
        prev = blob[loc.key] || null; blob[loc.key] = next; await store.setJSON(loc.blob, blob);
      }
      try { await afterWrite(store, env, loc, prev, next, me); } catch (e) { console.error("push failed", e); }
      return json({ ok: true });
    }

    if (req.method === "POST" && parts[0] === "photo" && parts.length === 1) {
      const buf = await req.arrayBuffer();
      if (buf.byteLength > MAX_PHOTO) return json({ error: "too_large" }, 413);
      const type = sniffImage(buf);
      if (!type) return json({ error: "unsupported_type" }, 415);
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
      await store.set("photo/" + id, buf, { metadata: { type } });
      return json({ id });
    }
    if (req.method === "DELETE" && parts[0] === "photo" && PHOTO.test(parts[1] || "")) {
      await store.delete("photo/" + parts[1]);
      return json({ ok: true });
    }

    if (req.method === "GET" && parts[0] === "weather") {
      try { return await weather(url, fetchImpl, store); } catch (e) { return json({ error: "weather_failed" }, 502); }
    }

    // Notifications
    if (parts[0] === "push") {
      if (req.method === "GET" && parts[1] === "key") return json({ key: env("VAPID_PUBLIC_KEY") || null });
      if (!me) return json({ error: "who_are_you" }, 400);
      if (req.method === "POST" && parts[1] === "subscribe") {
        const body = await readJson(req, 8000);
        const sub = body && body.sub;
        if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys) return json({ error: "bad_request" }, 400);
        const rec = (await store.get("push/" + me, { type: "json" })) || { subs: [] };
        const subs = (rec.subs || []).filter(s => s.endpoint !== sub.endpoint).concat([{ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh || ""), auth: String(sub.keys.auth || "") } }]).slice(-5);
        await store.setJSON("push/" + me, { subs, tz: typeof body.tz === "string" ? body.tz.slice(0, 64) : rec.tz || "UTC" });
        return json({ ok: true });
      }
      if (req.method === "POST" && parts[1] === "unsubscribe") {
        const body = await readJson(req, 4000); const rec = (await store.get("push/" + me, { type: "json" })) || { subs: [] };
        await store.setJSON("push/" + me, { ...rec, subs: (rec.subs || []).filter(s => !body || s.endpoint !== body.endpoint) });
        return json({ ok: true });
      }
      if (req.method === "POST" && parts[1] === "test") {
        const n = await sendPush(store, env, me, { title: "Pulse for Two", body: "Notifications are on. Mochi says hi!", tag: "test" });
        return json({ sent: n, configured: setupVapid(env) });
      }
    }

    return json({ error: "not_found" }, 404);
  };
}
