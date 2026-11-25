// API for Pulse for Two. Storage-agnostic: pass any store with the
// Netlify Blobs interface (get, getWithMetadata, setJSON, set, delete).
//
// Data layout
//   person/<p1|p2>          -> { name, mode, kcalGoal, ... }
//   month/<p1|p2>/<YYYY-MM>  -> { "<YYYY-MM-DD>": dayDoc, ... }
//   photo/<32 hex>           -> image bytes (metadata.type = content type)

const PEOPLE = ["p1", "p2"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHOTO = /^[a-f0-9]{32}$/;
const TIME = /^\d{2}:\d{2}$/;
const SLOTS = ["Breakfast", "Lunch", "Dinner", "Snack"];
const MAX_PHOTO = 4 * 1024 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

const num = (v, lo, hi) => { const x = typeof v === "number" ? v : parseFloat(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : null; };
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function cleanPerson(p) {
  return {
    name: str(p.name, 30),
    mode: ["gain", "maintain", "lose"].includes(p.mode) ? p.mode : "gain",
    kcalGoal: num(p.kcalGoal, 800, 8000), proteinGoal: num(p.proteinGoal, 10, 400),
    waterGoal: num(p.waterGoal, 1, 20), sleepGoal: num(p.sleepGoal, 1, 14), stepsGoal: num(p.stepsGoal, 100, 60000),
    unit: p.unit === "lb" ? "lb" : "kg",
    targetWeight: num(p.targetWeight, 20, 700), startWeight: num(p.startWeight, 20, 700),
  };
}

function cleanDay(d, date) {
  const meals = (Array.isArray(d.meals) ? d.meals : []).slice(0, 80).filter(m => m && typeof m === "object").map(m => {
    const out = {
      id: str(m.id, 12) || Math.random().toString(36).slice(2, 10),
      name: str(m.name, 40) || "Food",
      kcal: Math.round(num(m.kcal, 0, 5000) || 0),
      protein: Math.round(num(m.protein, 0, 500) || 0),
      slot: SLOTS.includes(m.slot) ? m.slot : "Snack",
      time: TIME.test(m.time) ? m.time : "",
    };
    if (typeof m.photo === "string" && PHOTO.test(m.photo)) out.photo = m.photo;
    return out;
  });
  return {
    date, meals,
    water: num(d.water, 0, 40), sleep: num(d.sleep, 0, 24), steps: num(d.steps, 0, 200000), weight: num(d.weight, 0, 700),
    workoutMin: num(d.workoutMin, 0, 1000), workout: str(d.workout, 30), mood: num(d.mood, 1, 5),
    notes: str(d.notes, 500), love: Math.round(num(d.love, 0, 100000) || 0), updatedAt: Date.now(),
  };
}

async function readJson(req, max) {
  const text = await req.text();
  if (text.length > max) return null;
  try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

function monthKeys(now = new Date()) {
  // Three months back to one month ahead (clients may be ahead of the server's clock).
  const out = [];
  for (let i = -3; i <= 1; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

function sniffImage(buf) {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export function createHandler({ store, passcode }) {
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

    if (req.method === "GET" && parts[0] === "state") {
      const people = {}, days = {};
      await Promise.all(PEOPLE.map(async p => {
        people[p] = (await store.get("person/" + p, { type: "json" })) || null;
        const months = await Promise.all(monthKeys().map(m => store.get(`month/${p}/${m}`, { type: "json" })));
        days[p] = months.filter(Boolean).flatMap(m => Object.values(m)).sort((a, b) => (a.date < b.date ? 1 : -1));
      }));
      return json({ people, days });
    }

    if (req.method === "PUT" && parts[0] === "person" && PEOPLE.includes(parts[1]) && parts.length === 2) {
      const body = await readJson(req, 20000);
      if (!body) return json({ error: "bad_request" }, 400);
      const key = "person/" + parts[1];
      const current = (await store.get(key, { type: "json" })) || {};
      const next = cleanPerson({ ...current, ...body, name: body.name !== undefined ? body.name : current.name });
      await store.setJSON(key, next);
      return json(next);
    }

    if (req.method === "PUT" && parts[0] === "day" && PEOPLE.includes(parts[1]) && DATE.test(parts[2] || "") && parts.length === 3) {
      const body = await readJson(req, 200000);
      if (!body) return json({ error: "bad_request" }, 400);
      const date = parts[2], key = `month/${parts[1]}/${date.slice(0, 7)}`;
      const month = (await store.get(key, { type: "json" })) || {};
      month[date] = cleanDay(body, date);
      await store.setJSON(key, month);
      return json(month[date]);
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

    return json({ error: "not_found" }, 404);
  };
}
