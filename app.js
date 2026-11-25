/* Forge — private, offline gym tracker. All data lives in IndexedDB on this device. */
(() => {
'use strict';

/* ======================= Utilities ======================= */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const DAY = 864e5;
const pad = (n) => String(n).padStart(2, '0');
const dkey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const sod = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
const num = (x, dp = 2) => (x == null || x === '' || isNaN(x)) ? '' : String(+(+x).toFixed(dp));
const pnum = (v) => { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const clone = (o) => JSON.parse(JSON.stringify(o));
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const fmtDate = (d, o) => new Date(d).toLocaleDateString(undefined, o || { weekday: 'short', day: 'numeric', month: 'short' });
const fmtClock = (sec) => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`; };
const fmtDur = (ms) => { const m = Math.round(ms / 6e4); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
const relDay = (ts) => {
  const d = Math.round((sod(Date.now()) - sod(ts)) / DAY);
  if (d === 0) return 'Today'; if (d === 1) return 'Yesterday'; if (d > 1 && d < 7) return `${d} days ago`;
  return fmtDate(ts, { day: 'numeric', month: 'short', year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/* ======================= Storage (IndexedDB) ======================= */
const Store = {
  db: null,
  open() {
    return new Promise((res) => {
      if (!('indexedDB' in window)) return res(null);
      let rq;
      try { rq = indexedDB.open('forge', 1); } catch (e) { return res(null); }
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onsuccess = () => { this.db = rq.result; res(this.db); };
      rq.onerror = () => res(null);
    });
  },
  get(k) {
    if (!this.db) { try { return Promise.resolve(JSON.parse(localStorage.getItem('forge:' + k))); } catch (e) { return Promise.resolve(null); } }
    return new Promise((res) => {
      const rq = this.db.transaction('kv').objectStore('kv').get(k);
      rq.onsuccess = () => res(rq.result ?? null); rq.onerror = () => res(null);
    });
  },
  set(k, v) {
    if (!this.db) { try { localStorage.setItem('forge:' + k, JSON.stringify(v)); } catch (e) { toast('Storage is full'); } return Promise.resolve(); }
    return new Promise((res) => {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = res; tx.onerror = () => { toast('Could not save'); res(); };
    });
  },
  del(k) {
    if (!this.db) { try { localStorage.removeItem('forge:' + k); } catch (e) { /* ignore */ } return Promise.resolve(); }
    return new Promise((res) => { const tx = this.db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = res; tx.onerror = res; });
  }
};

const KEYS = ['settings', 'custom', 'routines', 'plan', 'workouts', 'active', 'body', 'measures', 'meta', 'scans'];
const DEFAULTS = {
  unit: 'kg', theme: 'dark', accent: '#ff5a1f', weekStart: 1, bar: 20, plates: [25, 20, 15, 10, 5, 2.5, 1.25],
  rest: 120, effort: 'rpe', sound: true, keepAwake: true, owned: [], bwGoal: null, distUnit: 'km', textSize: 'l'
};
const freshState = () => ({ settings: { ...DEFAULTS }, custom: [], routines: [], plan: { days: {}, overrides: {} }, workouts: [], active: null, body: [], measures: [], meta: {}, scans: [] });
const S = freshState();

/* ---------- Profiles (one device can hold several people; each profile's data is stored separately) ---------- */
let PID = null;          // current profile id
let PROFILES = [];       // [{ id, name, color, created, lastUsed, details }]
const PK = (k) => `${PID}:${k}`;
const PROFILE_COLORS = ['#ff5a1f', '#0a84ff', '#30d158', '#bf5af2', '#ff375f', '#ff9f0a', '#64d2ff', '#ffd60a'];
const DEFAULT_DETAILS = { level: 'intermediate', goal: 'hypertrophy', sex: '', birthYear: null, heightCm: null, sessionsPerWeek: 4, rotate: true, rotateWeeks: 4, injuries: [], surgeries: [], healthNotes: '' };
const me = () => PROFILES.find((p) => p.id === PID) || { name: '', details: { ...DEFAULT_DETAILS } };
const details = () => ({ ...DEFAULT_DETAILS, ...(me().details || {}) });
const newProfile = (name) => ({ id: 'p' + uid(), name, color: PROFILE_COLORS[PROFILES.length % PROFILE_COLORS.length], created: Date.now(), lastUsed: Date.now(), details: { ...DEFAULT_DETAILS } });
const saveProfiles = () => Store.set('profiles', clone(PROFILES));
const initials = (n) => (n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const avatar = (p, cls = '') => `<span class="avatar ${cls}" style="background:${p.color || '#666'}">${esc(initials(p.name))}</span>`;
let ver = 1; // bumps when workouts/exercises change (for caches)
const dirty = new Set();
let saveTimer = null;
function save(...keys) {
  keys.forEach((k) => dirty.add(k));
  if (keys.includes('workouts') || keys.includes('custom') || keys.includes('body')) ver++;
  clearTimeout(saveTimer); saveTimer = setTimeout(flush, 200);
}
function flush() {
  clearTimeout(saveTimer);
  const ks = [...dirty]; dirty.clear();
  if (!PID) return;
  ks.forEach((k) => Store.set(PK(k), S[k] == null ? null : clone(S[k])));
}

/* ======================= Exercises ======================= */
let EX = {}, EX_LIST = [];
function buildEx() {
  EX = {};
  for (const [name, m, sec, eq, type] of window.EXERCISE_ROWS) {
    const id = 'b:' + slug(name);
    EX[id] = { id, name, muscle: m, secondary: sec ? sec.split(',') : [], equipment: eq, type };
  }
  for (const c of S.custom) EX[c.id] = { ...c, custom: true };
  EX_LIST = Object.values(EX).sort((a, b) => a.name.localeCompare(b.name));
}
const getEx = (id) => EX[id] || { id, name: 'Deleted exercise', muscle: 'chest', secondary: [], equipment: 'other', type: 'weight', missing: true };
const exByName = (n) => EX['b:' + slug(n)];
const MUSCLES = window.MUSCLES, EQUIPMENT = window.EQUIPMENT;
const TYPES = { weight: 'Weight × reps', bodyweight: 'Body weight (+ optional load)', assisted: 'Assisted (− load)', timed: 'Timed hold', cardio: 'Cardio (time + distance)', mobility: 'Warm-up / stretch (timed, not in stats)' };
const PATTERNS = window.PATTERNS, TECH = window.TECHNIQUES, GUIDE = window.GUIDE || {};
const PATTERN_OF = {};
for (const [p, list] of Object.entries(PATTERNS)) for (const n of list) PATTERN_OF['b:' + slug(n)] = p;
const COMPOUND = new Set(['hpush', 'vpush', 'hpull', 'vpull', 'squat', 'hinge', 'lunge']);

/* ======================= Units ======================= */
const LB = 2.2046226218;
const isLb = () => S.settings.unit === 'lb';
const toU = (kg) => (kg == null ? null : isLb() ? kg * LB : kg);
const fromU = (v) => (v == null ? null : isLb() ? v / LB : v);
const U = () => S.settings.unit;
const fmtW = (kg, dp = 1) => (kg == null ? '–' : `${num(toU(kg), dp)} ${U()}`);
const fmtVol = (kg) => { const v = toU(kg) || 0; return v >= 1e4 ? `${num(v / 1000, v >= 1e5 ? 0 : 1)}k ${U()}` : `${num(v, 0)} ${U()}`; };
const distU = () => (isLb() ? 'mi' : 'km');
const toD = (km) => (km == null ? null : isLb() ? km / 1.609344 : km);
const fromD = (v) => (v == null ? null : isLb() ? v * 1.609344 : v);
/* Round to a loadable weight: barbells need two equal plates (2.5 kg / 5 lb steps); others round finer. */
const BAR_EQ = ['barbell', 'trapbar', 'ezbar', 'smith'];
const roundPlate = (kg, eq = 'barbell') => { const q = BAR_EQ.includes(eq) ? (isLb() ? 5 : 2.5) : (isLb() ? 2.5 : 1); return fromU(Math.round(toU(kg) / q) * q); };

/* ======================= Training math ======================= */
const isWork = (s) => s.done && !s.warm;
const sortW = () => S.workouts.sort((a, b) => b.start - a.start);
function effRIR(s) {
  if (!s.eff || s.eff.v == null) return 0;
  const r = s.eff.scale === 'rpe' ? 10 - s.eff.v : s.eff.v;
  return Math.max(0, Math.min(5, r));
}
/* Epley, adjusted for reps in reserve. Declines to estimate above 12 reps. */
function e1rm(s) {
  if (!isWork(s) || !(s.w > 0) || !(s.r >= 1) || s.r > 12) return 0;
  const reps = s.r + effRIR(s);
  return reps <= 1 ? s.w : s.w * (1 + reps / 30);
}
function entriesFor(exId, opt = {}) {
  const out = [];
  for (const w of S.workouts) {
    if (w.id === opt.exclude) continue;
    if (opt.before != null && w.start >= opt.before) continue;
    for (const e of w.entries) if (e.exId === exId && e.sets.some(isWork)) out.push({ w, e });
  }
  return out;
}
/* Dumbbell modes. Weight is logged per dumbbell and reps per arm (per side). */
const DB_MODES = {
  both: { label: 'Both arms', short: 'Both', help: 'Both dumbbells move together. Weight = one dumbbell, reps = per arm.', factor: 2 },
  alt: { label: 'Alternating', short: 'Alternate', help: 'Arms take turns (L, R, L…). Weight = one dumbbell, reps = per arm (count each arm).', factor: 2 },
  single: { label: 'One arm at a time', short: 'One arm', help: 'Finish all reps on one side, then the other. Weight = the dumbbell, reps = per side. Rest after both sides.', factor: 2 },
  one: { label: 'One dumbbell, both hands', short: '1 DB', help: 'A single dumbbell held with both hands (e.g. goblet squat). Weight = that dumbbell.', factor: 1 }
};
const DB_DEFAULT = { 'Goblet Squat': 'one', 'Overhead Dumbbell Extension': 'one', 'One-Arm Dumbbell Row': 'single', 'Concentration Curl': 'single', 'Dumbbell Kickback': 'single', 'Dumbbell Side Bend': 'single', 'Suitcase Carry': 'single', 'Dumbbell Curl': 'alt', 'Hammer Curl': 'alt', 'Incline Dumbbell Curl': 'alt', 'Spider Curl': 'both', 'Bulgarian Split Squat': 'both', 'Front Raise': 'alt' };
const isDB = (ex) => ex.equipment === 'dumbbell' && (ex.type === 'weight' || ex.type === 'timed');
function dbModeFor(exId, item) {
  const ex = getEx(exId); if (!isDB(ex)) return null;
  if (item && DB_MODES[item.dbMode]) return item.dbMode;
  const last = S.workouts.find((w) => w.entries.some((e) => e.exId === exId && e.dbMode));
  if (last) return last.entries.find((e) => e.exId === exId && e.dbMode).dbMode;
  return DB_DEFAULT[ex.name] || 'both';
}
const loadFactor = (e) => (e.dbMode && DB_MODES[e.dbMode] ? DB_MODES[e.dbMode].factor : 1);
const wVolume = (w) => {
  let v = 0;
  for (const e of w.entries) {
    const t = getEx(e.exId).type, f = loadFactor(e);
    if (t === 'weight' || t === 'bodyweight') for (const s of e.sets) if (isWork(s) && s.w > 0 && s.r > 0) v += s.w * s.r * f;
  }
  return v;
};
const isMob = (exId) => getEx(exId).type === 'mobility';
const wSets = (w) => w.entries.reduce((n, e) => n + (isMob(e.exId) ? 0 : e.sets.filter(isWork).length), 0);
const wDur = (w) => Math.max(0, (w.end || Date.now()) - w.start);

const _rec = new Map();
function records(exId, opt = {}) {
  const key = `${exId}|${opt.exclude || ''}|${opt.before || ''}|${ver}`;
  if (_rec.has(key)) return _rec.get(key);
  const r = { e1rm: 0, e1rmSet: null, heavy: 0, heavySet: null, reps: 0, repsSet: null, vol: 0, volSet: null, time: 0, dist: 0, count: 0, last: null };
  for (const { w, e } of entriesFor(exId, opt)) {
    r.count++; if (!r.last) r.last = w.start;
    for (const s of e.sets) {
      if (!isWork(s)) continue;
      const x = e1rm(s), sd = { ...s, date: w.start };
      if (x > r.e1rm) { r.e1rm = x; r.e1rmSet = sd; }
      if ((s.w || 0) > r.heavy) { r.heavy = s.w; r.heavySet = sd; }
      if ((s.r || 0) > r.reps) { r.reps = s.r; r.repsSet = sd; }
      const v = (s.w || 0) * (s.r || 0); if (v > r.vol) { r.vol = v; r.volSet = sd; }
      if ((s.t || 0) > r.time) r.time = s.t;
      if ((s.d || 0) > r.dist) r.dist = s.d;
    }
  }
  if (_rec.size > 600) _rec.clear();
  _rec.set(key, r);
  return r;
}
function prTags(exId, s, rec) {
  if (!isWork(s) || !rec.count) return null;
  const t = getEx(exId).type, tags = [];
  if (t === 'weight') {
    if (rec.e1rm > 0 && e1rm(s) > rec.e1rm + 0.01) tags.push('e1RM');
    if (rec.heavy > 0 && (s.w || 0) > rec.heavy + 0.01) tags.push('Weight');
  } else if (t === 'bodyweight') { if ((s.r || 0) > rec.reps) tags.push('Reps'); }
  else if (t === 'timed') { if ((s.t || 0) > rec.time) tags.push('Time'); }
  else if (t === 'cardio') { if (s.d && s.d > rec.dist) tags.push('Distance'); }
  return tags.length ? tags : null;
}
/* PRs a saved workout set, compared with everything before it. */
function workoutPRs(w) {
  const out = [];
  for (const e of w.entries) {
    const rec = records(e.exId, { before: w.start, exclude: w.id });
    let best = null;
    for (const s of e.sets) { const t = prTags(e.exId, s, rec); if (t && (!best || e1rm(s) >= e1rm(best.s))) best = { s, t }; }
    if (best) out.push({ exId: e.exId, set: best.s, tags: best.t });
  }
  return out;
}
let _prCount = { v: -1, n: 0 };
function totalPRs() {
  if (_prCount.v === ver) return _prCount.n;
  const best = {}; let n = 0;
  for (const w of [...S.workouts].reverse()) for (const e of w.entries) {
    if (getEx(e.exId).type !== 'weight') continue;
    const m = Math.max(0, ...e.sets.map(e1rm));
    if (m > 0) { if (best[e.exId] && m > best[e.exId] + 0.01) n++; best[e.exId] = Math.max(best[e.exId] || 0, m); }
  }
  _prCount = { v: ver, n };
  return n;
}

/* ---------- Progression engine ---------- */
const PROG = { linear: 'Linear', double: 'Double progression', time: 'Added time', none: 'Repeat last' };
const PROG_HELP = {
  linear: 'Fixed reps. Hit every set → add weight. Miss 3 sessions → deload 10%.',
  double: 'Rep range. Hit the top of the range on every set → add weight and drop to the bottom.',
  time: 'For holds. Complete every hold → add 5 seconds.',
  none: 'Pre-fill exactly what you did last time.'
};
function defaultInc(ex) {
  const lower = ['quads', 'glutes', 'hamstrings', 'lowerback', 'adductors'].includes(ex.muscle);
  const bar = ex.equipment === 'barbell' || ex.equipment === 'trapbar';
  if (isLb()) return fromU(bar && lower ? 10 : 5);
  return bar ? (lower ? 5 : 2.5) : ex.equipment === 'dumbbell' ? 2 : 2.5;
}
function suggest(exId, item, routineProg, exclude) {
  const ex = getEx(exId); item = item || {};
  const sets = item.sets || 3;
  const lo = item.repMin || 8, hi = Math.max(item.repMax || lo, lo);
  const inc = item.inc != null ? item.inc : defaultInc(ex);
  let prog = item.prog && item.prog !== 'routine' ? item.prog : (routineProg || 'double');
  if (ex.type === 'timed') prog = 'time';
  if (ex.type === 'mobility') return { sets: item.sets || 1, w: null, r: null, t: item.time || 30, d: null, src: item.phase === 'cooldown' ? 'Cool-down: breathe and relax into it' : 'Warm-up: easy, controlled movement', prog: 'none' };
  const out = { sets, w: null, r: prog === 'double' ? lo : hi, t: ex.type === 'timed' ? (item.time || 30) : null, d: null, src: '', prog };
  const hist = entriesFor(exId, { exclude });
  if (!hist.length) { out.src = 'First time — pick a starting point'; return out; }
  const ws = hist[0].e.sets.filter((s) => isWork(s) && s.tech !== 'drop');
  const topW = Math.max(0, ...ws.map((s) => s.w || 0));
  const atTop = ws.filter((s) => (s.w || 0) >= topW - 0.01);
  out.w = topW || null;

  if (ex.type === 'cardio') {
    const s = ws[ws.length - 1]; out.t = s.t; out.d = s.d; out.sets = Math.max(1, Math.min(ws.length, sets)); out.r = null;
    out.src = 'Same as last time'; return out;
  }
  if (prog === 'time' || ex.type === 'timed') {
    const minT = Math.min(...ws.map((s) => s.t || 0)), target = item.time || 0;
    if (ws.length >= sets && minT >= target && minT > 0) { out.t = minT + 5; out.src = '+5 s: every hold completed'; }
    else { out.t = Math.max(target, minT) || 30; out.src = 'Hold target not reached yet — repeat'; }
    out.r = null; return out;
  }
  const minR = Math.min(...atTop.map((s) => s.r || 0)), maxR = Math.max(...atTop.map((s) => s.r || 0));
  const success = atTop.length >= sets && minR >= hi;
  if (ex.type === 'bodyweight' && !topW) {
    out.r = success ? maxR + 1 : Math.max(lo, Math.min(hi, minR + 1));
    out.src = success ? 'Top of range on every set — add a rep or some load' : `Aim for ${out.r} reps on every set`;
    return out;
  }
  if (ex.type === 'assisted') {
    if (success) { out.w = Math.max(0, roundPlate(topW - inc, ex.equipment)); out.r = lo; out.src = `−${fmtW(inc)} assistance: hit ${hi} reps on every set`; }
    else { out.r = Math.max(lo, Math.min(hi, minR + 1)); out.src = 'Same assistance — add reps'; }
    return out;
  }
  if (prog === 'none') { out.r = atTop[0]?.r || hi; out.src = 'Repeat last session'; return out; }
  if (prog === 'linear') {
    out.r = hi;
    if (success) { out.w = roundPlate(topW + inc, ex.equipment); out.src = `+${fmtW(inc)}: hit ${sets}×${hi} last time`; return out; }
    let fails = 0;
    for (const { e } of hist) {
      const s2 = e.sets.filter(isWork), t2 = Math.max(0, ...s2.map((s) => s.w || 0));
      if (Math.abs(t2 - topW) > 0.01) break;
      const top2 = s2.filter((s) => (s.w || 0) >= t2 - 0.01);
      if (top2.length >= sets && Math.min(...top2.map((s) => s.r || 0)) >= hi) break;
      fails++;
    }
    if (fails >= 3) { out.w = roundPlate(topW * 0.9, ex.equipment); out.src = 'Deload 10%: missed target 3 sessions in a row'; }
    else out.src = `Repeat ${fmtW(topW)}: missed target ${fails > 1 ? fails + '× in a row' : 'last time'}`;
    return out;
  }
  // double progression
  if (success) { out.w = roundPlate(topW + inc, ex.equipment); out.r = lo; out.src = `+${fmtW(inc)}: hit ${hi} reps on every set`; }
  else { out.r = Math.max(lo, Math.min(hi, minR + 1)); out.src = `Same weight — aim for ${out.r}+ reps`; }
  return out;
}

/* ---------- Muscles: balance, fatigue, strength ---------- */
function muscleSets(days = 7) {
  const since = Date.now() - days * DAY, out = {};
  for (const m in MUSCLES) out[m] = 0;
  for (const w of S.workouts) {
    if (w.start < since) break;
    for (const e of w.entries) {
      const ex = getEx(e.exId), n = e.sets.filter(isWork).length;
      if (ex.type === 'mobility') continue;
      out[ex.muscle] = (out[ex.muscle] || 0) + n;
      for (const m of ex.secondary) out[m] = (out[m] || 0) + n * 0.5;
    }
  }
  return out;
}
function muscleFatigue() {
  const now = Date.now(), out = {};
  for (const m in MUSCLES) out[m] = 0;
  for (const w of S.workouts) {
    const end = w.end || w.start; if (now - end > 7 * DAY) break;
    const decay = Math.exp(-((now - end) / 36e5) / 30);
    for (const e of w.entries) {
      const ex = getEx(e.exId);
      if (ex.type === 'mobility') continue;
      for (const s of e.sets) {
        if (!isWork(s)) continue;
        const intensity = s.eff && s.eff.v != null ? (effRIR(s) <= 1 ? 1.3 : effRIR(s) >= 4 ? 0.7 : 1) : 1;
        out[ex.muscle] += intensity * decay;
        for (const m of ex.secondary) out[m] += 0.5 * intensity * decay;
      }
    }
  }
  for (const m in out) out[m] = Math.min(1, out[m] / 8);
  return out;
}
function muscleStrength() {
  const out = {};
  for (const m in MUSCLES) out[m] = { last: null, lifts: {} };
  for (const w of S.workouts) for (const e of w.entries) {
    const ex = getEx(e.exId); if (!e.sets.some(isWork) || ex.type === 'mobility') continue;
    for (const m of [ex.muscle, ...ex.secondary]) {
      if (!out[m]) continue;
      if (!out[m].last) out[m].last = w.start;
      if (m === ex.muscle && ex.type === 'weight') {
        const best = Math.max(0, ...e.sets.map(e1rm));
        if (best > (out[m].lifts[ex.id] || 0)) out[m].lifts[ex.id] = best;
      }
    }
  }
  return out;
}
function latestBW() { const b = [...S.body].sort((a, b) => b.date - a.date)[0]; return b ? b.kg : null; }
function structuralBalance() {
  const bw = latestBW(), rows = [];
  for (const t of window.BALANCE_TARGETS) {
    const ex = exByName(t.name); if (!ex) continue;
    const rec = records(ex.id); if (!rec.e1rm) continue;
    let val = rec.e1rm;
    if (t.addBodyweight) { if (!bw) continue; val += bw; }
    rows.push({ name: t.name, e1rm: val, norm: val / t.ratio, ratio: t.ratio });
  }
  if (rows.length < 2) return null;
  const ref = Math.max(...rows.map((r) => r.norm));
  rows.forEach((r) => { r.pct = r.norm / ref * 100; r.expected = ref * r.ratio; });
  rows.sort((a, b) => a.pct - b.pct);
  return { rows, weakest: rows[0] };
}

/* ======================= Plan & calendar ======================= */
function weekStartOf(d) { const x = new Date(sod(d)); const diff = (x.getDay() - S.settings.weekStart + 7) % 7; x.setDate(x.getDate() - diff); return x.getTime(); }
function routineFor(date) {
  const k = dkey(date);
  if (k in S.plan.overrides) return S.routines.find((r) => r.id === S.plan.overrides[k]) || null;
  return S.routines.find((r) => r.id === S.plan.days[new Date(date).getDay()]) || null;
}
function workoutsOn(date) { const k = dkey(date); return S.workouts.filter((w) => dkey(w.start) === k); }
function weekStreak() {
  const weeks = new Set(S.workouts.map((w) => weekStartOf(w.start)));
  let cur = weekStartOf(Date.now()), n = 0;
  if (!weeks.has(cur)) cur = weekStartOf(cur - DAY);
  while (weeks.has(cur)) { n++; cur = weekStartOf(cur - DAY); }
  let best = 0, run = 0, prev = null;
  [...weeks].sort((a, b) => a - b).forEach((wk) => { run = prev != null && Math.round((wk - prev) / (7 * DAY)) === 1 ? run + 1 : 1; best = Math.max(best, run); prev = wk; });
  return { cur: n, best };
}

/* ======================= UI state ======================= */
const UI = { statsTab: 'overview', muscleMode: 'balance', libQ: '', libMuscle: '', libEq: '', libOwned: false, histLimit: 30 };
let wakeLock = null, actx = null, tickTimer = null, holdTimer = null;

function toast(msg, ms = 2200, icon) {
  const t = $('#toast'); t.innerHTML = (icon ? ico(icon, 'sm accent') : '') + `<span>${esc(msg)}</span>`; t.hidden = false;
  t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
function unlockAudio() {
  try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { /* ignore */ }
}
function beep(times = 1, freq = 880) {
  if (S.settings.sound && actx) {
    for (let i = 0; i < times; i++) {
      const o = actx.createOscillator(), g = actx.createGain(), t0 = actx.currentTime + i * 0.22;
      o.frequency.value = freq; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      o.start(t0); o.stop(t0 + 0.2);
    }
  }
  if (navigator.vibrate) navigator.vibrate(times > 1 ? [120, 80, 120] : 150);
}
async function requestWake() {
  if (!S.active || !S.settings.keepAwake || !('wakeLock' in navigator) || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch (e) { wakeLock = null; }
}
function releaseWake() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }

function confetti() {
  if (reduceMotion()) return;
  const box = document.createElement('div'); box.className = 'confetti';
  const cols = [S.settings.accent, '#ffd60a', '#30d158', '#64d2ff', '#ff375f', '#ffffff'];
  for (let i = 0; i < 46; i++) {
    const p = document.createElement('i');
    const a = Math.random() * Math.PI * 2, d = 120 + Math.random() * 220;
    p.style.cssText = `--x:${Math.cos(a) * d}px;--y:${Math.sin(a) * d - 140}px;--r:${Math.random() * 720 - 360}deg;background:${cols[i % cols.length]};animation-delay:${Math.random() * 80}ms;${i % 3 ? '' : 'border-radius:50%;'}`;
    box.appendChild(p);
  }
  document.body.appendChild(box); setTimeout(() => box.remove(), 1600);
}

/* ---------- Sheets (modal stack) ---------- */
const sheets = [];
function openSheet(def) { sheets.push(def); renderSheet(true); }
function closeSheet() { const d = sheets.pop(); if (d && d.onClose) d.onClose(); renderSheet(true); }
function closeAllSheets() { while (sheets.length) closeSheet(); }
function renderSheet(fresh) {
  const el = $('#sheet'), bd = $('#sheet-backdrop');
  if (!sheets.length) {
    if (el.hidden || reduceMotion()) { el.hidden = true; bd.hidden = true; el.innerHTML = ''; return; }
    el.classList.add('out'); bd.classList.add('out');
    clearTimeout(renderSheet._t); renderSheet._t = setTimeout(() => { if (!sheets.length) { el.hidden = true; bd.hidden = true; el.innerHTML = ''; } el.classList.remove('out'); bd.classList.remove('out'); }, 220);
    return;
  }
  el.classList.remove('out'); bd.classList.remove('out'); clearTimeout(renderSheet._t);
  const d = sheets[sheets.length - 1];
  const prevScroll = !fresh && el.querySelector('.sheet-body') ? el.querySelector('.sheet-body').scrollTop : 0;
  const right = d.right ? `<button class="iconbtn" data-act="sheetRight">${esc(d.right.label)}</button>` : '';
  if (fresh && !el.hidden && sheets.length > 1) { el.classList.remove('push'); void el.offsetWidth; el.classList.add('push'); }
  el.innerHTML = `<div class="sheet-head"><div><button class="iconbtn" data-act="sheetClose">${sheets.length > 1 ? '‹ Back' : esc(d.cancel || 'Close')}</button></div><h4>${esc(d.title || '')}</h4><div class="r">${right}</div></div><div class="sheet-body">${d.render()}</div>`;
  el.hidden = false; bd.hidden = false;
  if (fresh) { el.classList.add('fresh'); clearTimeout(renderSheet._f); renderSheet._f = setTimeout(() => el.classList.remove('fresh'), 700); }
  el.querySelector('.sheet-body').scrollTop = prevScroll;
  if (d.after) d.after(el);
}
const refreshSheet = () => { if (sheets.length) renderSheet(false); };
function confirmSheet(title, message, label, fn, danger = true) {
  openSheet({
    title, render: () => `<p class="muted">${message}</p><button class="btn block ${danger ? 'danger' : 'primary'}" data-act="confirmYes">${esc(label)}</button>`,
    yes: () => { closeSheet(); fn(); }
  });
}

/* ======================= Charts ======================= */
function lineChart(pts, o = {}) {
  if (!pts.length) return '<div class="empty small">Not enough data yet</div>';
  const W = 320, h = o.h || 150, P = { l: 36, r: 10, t: 12, b: 22 };
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y).concat(o.goal != null ? [o.goal] : []);
  let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x1 === x0) { x0 -= DAY; x1 += DAY; }
  let y0 = Math.min(...ys), y1 = Math.max(...ys); const py = (y1 - y0) * 0.15 || Math.max(1, y1 * 0.05); y0 -= py; y1 += py;
  const X = (x) => P.l + (x - x0) / (x1 - x0) * (W - P.l - P.r);
  const Y = (y) => P.t + (1 - (y - y0) / (y1 - y0)) * (h - P.t - P.b);
  const f = o.fmt || ((v) => num(v, 1));
  let g = '';
  for (let i = 0; i <= 3; i++) { const v = y0 + (y1 - y0) * i / 3, y = Y(v); g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}"/><text x="${P.l - 4}" y="${y + 3}" text-anchor="end">${f(v)}</text>`; }
  const fd = (t) => fmtDate(t, { day: 'numeric', month: 'short' });
  g += `<text x="${P.l}" y="${h - 6}">${fd(x0)}</text><text x="${W - P.r}" y="${h - 6}" text-anchor="end">${fd(x1)}</text>`;
  const sorted = [...pts].sort((a, b) => a.x - b.x);
  const d = sorted.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const area = `${d}L${X(sorted[sorted.length - 1].x).toFixed(1)},${h - P.b}L${X(sorted[0].x).toFixed(1)},${h - P.b}Z`;
  const goal = o.goal != null ? `<line class="goal" x1="${P.l}" x2="${W - P.r}" y1="${Y(o.goal)}" y2="${Y(o.goal)}"/><text x="${W - P.r}" y="${Y(o.goal) - 4}" text-anchor="end" style="fill:var(--good)">goal ${f(o.goal)}</text>` : '';
  const dots = sorted.length <= 40 ? sorted.map((p) => `<circle class="dot" cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="2.6"${p.c ? ` style="fill:${p.c}"` : ''}/>`).join('') : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${h}">${g}<path class="area" d="${area}"/><path class="line" d="${d}"/>${goal}${dots}</svg>`;
}
function barChart(labels, vals, o = {}) {
  const W = 320, h = o.h || 140, P = { l: 36, r: 6, t: 10, b: 22 };
  const max = Math.max(1, ...vals), n = vals.length, bw = (W - P.l - P.r) / n;
  const f = o.fmt || ((v) => num(v, 0));
  let g = '';
  for (let i = 0; i <= 2; i++) { const v = max * i / 2, y = P.t + (1 - i / 2) * (h - P.t - P.b); g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}"/><text x="${P.l - 4}" y="${y + 3}" text-anchor="end">${f(v)}</text>`; }
  vals.forEach((v, i) => {
    const bh = (h - P.t - P.b) * v / max, x = P.l + i * bw + bw * 0.15;
    g += `<rect class="bar" x="${x.toFixed(1)}" y="${(h - P.b - bh).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="2"${i === n - 1 ? '' : ' opacity=".75"'}/>`;
    if (labels[i] && (n <= 12 || i % 2 === 0)) g += `<text x="${(x + bw * 0.35).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(labels[i])}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${h}">${g}</svg>`;
}
function sparkline(vals, w = 110, h = 34) {
  if (vals.length < 2) return '';
  const min = Math.min(...vals), max = Math.max(...vals), r = max - min || 1;
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${(i / (vals.length - 1) * w).toFixed(1)},${(h - 3 - (v - min) / r * (h - 6)).toFixed(1)}`).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" style="width:${w}px"><path class="line" d="${d}"/></svg>`;
}

/* ---------- Body map ---------- */
const mir = (pts) => pts.map(([x, y]) => [100 - x, y]);
const poly = (pts) => pts.map((p) => p.join(',')).join(' ');
const ELL = (m, cx, cy, rx, ry) => [[m, `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/>`], [m, `<ellipse cx="${100 - cx}" cy="${cy}" rx="${rx}" ry="${ry}"/>`]];
const PL = (m, pts) => [[m, `<polygon points="${poly(pts)}"/>`], [m, `<polygon points="${poly(mir(pts))}"/>`]];
const BASE_COMMON = [
  '<circle cx="50" cy="13" r="8.5"/>', '<rect x="45.5" y="19" width="9" height="8" rx="2"/>',
  '<ellipse cx="22" cy="91" rx="3.4" ry="5"/>', '<ellipse cx="78" cy="91" rx="3.4" ry="5"/>',
  '<ellipse cx="42" cy="135" rx="4.6" ry="4"/>', '<ellipse cx="58" cy="135" rx="4.6" ry="4"/>',
  '<ellipse cx="42" cy="181" rx="5" ry="3"/>', '<ellipse cx="58" cy="181" rx="5" ry="3"/>',
  '<rect x="38" y="84" width="24" height="9" rx="4"/>'
];
const FRONT = [
  ['traps', '<polygon points="40,27 60,27 57,31 43,31"/>'],
  ...ELL('sidedelts', 25.5, 38, 3.4, 6.5), ...ELL('frontdelts', 31, 35, 6, 6.3),
  ...PL('chest', [[37, 30], [49.5, 31], [49.5, 47], [43, 50], [36.5, 46], [35.5, 37]]),
  ...ELL('biceps', 27, 53, 4.4, 9.5), ...ELL('forearms', 24, 74, 3.9, 10.5),
  ['abs', '<rect x="42.5" y="51" width="15" height="34" rx="4"/>'],
  ...PL('obliques', [[36.5, 50], [41.5, 52], [41.5, 84], [38, 80], [35.5, 66]]),
  ...ELL('quads', 41.5, 108, 6.8, 20), ...ELL('adductors', 47.4, 103, 2.4, 11),
  ...ELL('calves', 42, 156, 4.4, 14)
];
const BACK = [
  ...ELL('sidedelts', 25.5, 38, 3.4, 6.5), ...ELL('reardelts', 31, 36, 6, 6),
  ...PL('upperback', [[40, 35], [48, 38], [48, 52], [41, 48]]),
  ...PL('lats', [[36, 44], [42, 49], [48, 54], [47, 72], [40, 68], [36, 58]]),
  ['traps', '<polygon points="50,22 63,31 56,34 50,50 44,34 37,31"/>'],
  ['lowerback', '<rect x="44" y="70" width="12" height="16" rx="3"/>'],
  ...ELL('triceps', 27, 53, 4.4, 9.5), ...ELL('forearms', 24, 74, 3.9, 10.5),
  ...ELL('glutes', 43.5, 96, 7, 9), ...ELL('hamstrings', 42.5, 121, 6.5, 16),
  ...ELL('calves', 42.5, 154, 5, 13)
];
function mColor(v, mode) {
  if (!(v > 0.02)) return 'var(--card2)';
  if (mode === 'fatigue') return `hsl(${Math.round(130 - 130 * v)} 75% ${48 - 6 * v}%)`;
  return `color-mix(in srgb, var(--accent) ${Math.round(18 + 82 * v)}%, var(--card2))`;
}
function bodyMap(vals, mode) {
  const fig = (shapes, label) => `<div><svg viewBox="0 0 100 190"><g class="base">${BASE_COMMON.join('')}</g>${shapes.map(([m, s]) => s.replace(/^<(\w+)/, `<$1 class="m" style="fill:${mColor(vals[m], mode)}" data-m="${m}"`)).join('')}</svg><div class="center tiny faint">${label}</div></div>`;
  const grad = mode === 'fatigue' ? 'linear-gradient(90deg,hsl(130 75% 48%),hsl(65 75% 45%),hsl(0 75% 42%))' : 'linear-gradient(90deg,var(--card2),var(--accent))';
  const lo = mode === 'fatigue' ? 'Fresh' : mode === 'strength' ? 'Long ago' : '0 sets';
  const hi = mode === 'fatigue' ? 'Fatigued' : mode === 'strength' ? 'Recently' : '20+ sets';
  return `<div class="bodymap">${fig(FRONT, 'Front')}${fig(BACK, 'Back')}</div><div class="legend">${lo}<span class="grad" style="background:${grad}"></span>${hi}</div>`;
}

/* ======================= Routing & render ======================= */
const TABS = ['home', 'workout', 'plan', 'stats', 'library'];
const route = () => { const h = location.hash.slice(1); return TABS.includes(h) ? h : 'home'; };
const go = (t) => { if (location.hash !== '#' + t) location.hash = t; else render(); };
function setTop(title, left = '', right = '') { $('#title').innerHTML = title; $('#topbar-left').innerHTML = left; $('#topbar-right').innerHTML = right; }
const GEAR = ico('gear');

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function render() {
  const t = PID ? route() : 'picker', prev = render._last;
  const changed = prev !== t;
  if (changed && prev && document.startViewTransition && !reduceMotion()) {
    document.documentElement.dataset.dir = TABS.indexOf(t) >= TABS.indexOf(prev) ? 'fwd' : 'back';
    document.startViewTransition(() => renderNow(changed));
  } else renderNow(changed);
}
function renderNow(changed) {
  const v = $('#view');
  if (changed) { v.classList.remove('enter'); void v.offsetWidth; v.classList.add('enter'); clearTimeout(renderNow._t); renderNow._t = setTimeout(() => v.classList.remove('enter'), 900); }
  if (!PID) { render._last = 'picker'; v.innerHTML = pickerView(); renderRest(); return; }
  const t = route();
  const keep = render._last === t ? v.scrollTop : 0;
  render._last = t;
  document.querySelectorAll('#tabbar a').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === t);
    a.querySelector('.dot')?.remove();
    if (a.dataset.tab === 'workout' && S.active && t !== 'workout') a.insertAdjacentHTML('beforeend', '<i class="dot"></i>');
  });
  v.innerHTML = VIEWS[t]();
  v.scrollTop = keep; UI.justDone = null;
  const heat = $('#heat'); if (heat) heat.scrollLeft = heat.scrollWidth;
  renderRest();
}
const renderView = render;

/* ======================= Views ======================= */
const VIEWS = {};

/* ---------- Home ---------- */
VIEWS.home = () => {
  setTop('Forge', `<button class="iconbtn" data-act="profileMenu" aria-label="Profiles" style="padding:2px">${avatar(me())}</button>`, `<button class="iconbtn" data-act="openSettings" aria-label="Settings">${GEAR}</button>`);
  const now = Date.now(), h = new Date().getHours();
  const greet = h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  let html = `<h2>${greet}, ${esc(me().name)}</h2>`;
  html += healthBanner();
  if (me().migrated) html += `<div class="banner">Forge now supports a profile for each person. Your existing data was moved into the profile “${esc(me().name)}”. <button class="btn ghost sm" data-act="editProfile">Set your name</button></div>`;

  if (isIOS && !standalone()) {
    html += `<div class="banner"><b>Install on your iPhone:</b> tap <b>Share</b> <span class="muted">(□↑)</span> → <b>Add to Home Screen</b>. It then opens full-screen and works offline. Note: data saved here in Safari is separate from the installed app.</div>`;
  }
  const lastB = S.meta.lastBackup;
  if (S.workouts.length >= 3 && (!lastB || now - lastB > 14 * DAY)) {
    html += `<div class="banner">Your data lives only on this phone. ${lastB ? `Last backup ${relDay(lastB).toLowerCase()}.` : 'You have never backed up.'} <button class="btn ghost sm" data-act="exportJSON">Back up now</button></div>`;
  }
  if (S.active) {
    html += `<div class="card hero"><div class="row between"><div><div class="small muted">In progress</div><div class="big ellipsis">${esc(S.active.name)}</div><div class="muted small"><span data-elapsed>${fmtClock(wDur(S.active) / 1000)}</span> · ${wSets(S.active)} sets done</div></div><button class="btn primary" data-act="goWorkout">Resume</button></div></div>`;
  } else {
    const r = routineFor(now), done = workoutsOn(now);
    if (done.length) {
      const w = done[0];
      html += `<div class="card hero"><div class="small muted">Today</div><div class="big">✓ ${esc(w.name)}</div><div class="muted small">${fmtDur(wDur(w))} · ${wSets(w)} sets · ${fmtVol(wVolume(w))}</div><div class="row mt"><button class="btn sm" data-act="viewWorkout" data-id="${w.id}">View</button><button class="btn sm" data-act="startEmpty">Another session</button></div></div>`;
    } else if (r) {
      const mi = r.items.filter((i) => !isMob(i.exId)), mob = r.items.length - mi.length;
      const muscles = {}; mi.forEach((i) => { const e = getEx(i.exId); muscles[e.muscle] = 1; e.secondary.forEach((m) => { if (!muscles[m]) muscles[m] = 0.45; }); });
      html += `<div class="card hero"><div class="row" style="align-items:flex-start"><div class="grow"><div class="small muted">Today · ${DOW_LONG[new Date().getDay()]}</div><div class="big">${esc(r.name)}</div><div class="muted small"><b>${mi.length} exercises</b>${mob ? ` · warm-up & cool-down` : ''} · ${mi.reduce((n, i) => n + (i.sets || 3), 0)} sets</div></div><div style="width:84px">${miniMapVals(muscles)}</div></div><div class="small mt">${mi.slice(0, 7).map((i) => esc(getEx(i.exId).name)).join(' · ')}${mi.length > 7 ? ' …' : ''}</div>${rotationDue(r) ? `<div class="small mt" style="color:#64d2ff">${ico('sparkle', 'xs')} New training block ready — fresh variations will be suggested</div>` : ''}<button class="btn primary block mt" data-act="startRoutine" data-id="${r.id}">Start workout</button></div>`;
    } else if (!S.routines.length) {
      html += `<div class="card hero"><div class="big">Welcome, ${esc(me().name)} ${ico('wave', 'md wave-anim')}</div><p class="muted">Everything you log stays on this phone — no account, no cloud. Pick a proven program (with warm-ups, cool-downs and progression built in) or build your own.</p><button class="btn primary block" data-act="openTemplates">Browse ${PROGRAMS.length} proven programs</button><button class="btn block mt" data-act="newRoutine">Build my own routine</button><button class="btn ghost block mt" data-act="startEmpty">Just start an empty workout</button></div>`;
    } else {
      html += `<div class="card hero"><div class="small muted">Today · ${DOW_LONG[new Date().getDay()]}</div><div class="big">Rest day</div><p class="muted small">Recovery is where the gains happen. Or train anyway:</p><div class="row"><button class="btn sm" data-act="pickRoutineToStart">Pick a routine</button><button class="btn sm" data-act="startEmpty">Empty workout</button></div></div>`;
    }
  }

  // Week strip
  const ws = weekStartOf(now);
  html += `<h3>This week</h3><div class="week">`;
  let doneCount = 0, planned = 0, weekVol = 0;
  for (let i = 0; i < 7; i++) {
    const d = ws + i * DAY + 3600e3 * 2, r = routineFor(d), ww = workoutsOn(d);
    if (ww.length) doneCount++;
    if (r) planned++;
    ww.forEach((w) => { weekVol += wVolume(w); });
    const cls = [sod(d) === sod(now) ? 'today' : '', ww.length ? 'done' : '', r ? 'planned' : ''].join(' ');
    html += `<button class="day ${cls}" data-act="dayMenu" data-d="${dkey(d)}" style="border:0">${DOW[new Date(d).getDay()].slice(0, 2)}<b>${new Date(d).getDate()}</b><span class="tiny ellipsis" style="display:block">${r ? esc(r.name.slice(0, 7)) : '&nbsp;'}</span><div class="pip"></div></button>`;
  }
  html += `</div>`;
  const st = weekStreak();
  html += `<div class="grid3 mt"><div class="stat"><div class="v">${doneCount}<span class="muted small">/${planned || '–'}</span></div><div class="l">Sessions</div></div><div class="stat"><div class="v">${st.cur} ${ico('flame', 'sm accent')}</div><div class="l">Week streak</div></div><div class="stat"><div class="v" style="font-size:18px;padding:2px 0">${fmtVol(weekVol)}</div><div class="l">Volume</div></div></div>`;

  // Rotation due
  for (const r of S.routines) if (rotationDue(r) && routineFor(now)?.id !== r.id) {
    html += `<button class="card block-card" style="width:100%;border:0;text-align:left;display:block" data-act="rotNow" data-id="${r.id}"><div class="small muted">Training block complete</div><b>Time to mix up “${esc(r.name)}”</b><div class="small muted mt">Your muscles have adapted to these movements. See fresh variations and a new rep range →</div></button>`;
  }
  // Plateau watch
  const pls = S.workouts.length ? plateauList().slice(0, 3) : [];
  if (pls.length) html += `<h3>Plateau watch</h3><div class="card"><div class="small">${MOTIVATION[new Date().getDate() % MOTIVATION.length]}</div>${pls.map((p) => `<button class="row" style="width:100%;border:0;background:none;padding:8px 0;text-align:left" data-act="exDetail" data-id="${p.id}">${thumb(getEx(p.id), 'sm')}<div class="grow"><b>${esc(getEx(p.id).name)}</b><div class="tiny muted">${p.n} sessions at ~${fmtW(p.w)} — next time try +${fmtW(defaultInc(getEx(p.id)))} or a drop set</div></div><span class="chev faint">›</span></button>`).join('')}</div>`;
  // Monthly challenges
  if (S.workouts.length || S.routines.length) {
    const ch = challenges();
    html += `<h3>${esc(ch.month)} challenges</h3><div class="card">${ch.list.map(([icn, label, v, goal]) => `<div class="challenge"><div class="row between"><span class="row" style="gap:8px">${ico(icn, 'sm accent')} ${esc(label)}</span><span class="${v >= goal ? 'good' : 'muted'} small">${v >= goal ? '✓ ' : ''}${Math.min(v, goal)}/${goal}</span></div><div class="progress"><i style="width:${Math.min(100, v / goal * 100)}%;${v >= goal ? 'background:var(--good)' : ''}"></i></div></div>`).join('')}</div>`;
  }
  // Recovery
  const ng = S.workouts.length >= 3 ? neglected() : [];
  if (ng.length) html += `<div class="banner" style="background:color-mix(in srgb,#64d2ff 14%,var(--card))">${ico('compass', 'xs')} Your <b>${MUSCLES[ng[0][0]].toLowerCase()}</b> hasn't been trained in ${ng[0][1]} days${ng[1] ? `, ${MUSCLES[ng[1][0]].toLowerCase()} in ${ng[1][1]}` : ''}. Consider adding it this week.</div>`;
  if (S.workouts.length) {
    const f = muscleFatigue();
    const ready = Object.keys(MUSCLES).filter((m) => m !== 'cardio' && f[m] < 0.25);
    const tired = Object.keys(MUSCLES).filter((m) => m !== 'cardio' && f[m] >= 0.5).sort((a, b) => f[b] - f[a]);
    html += `<h3>Recovery</h3><button class="card" style="width:100%;border:0;text-align:left" data-act="goMuscles"><div class="row between"><div class="grow"><div class="small"><span class="bad">●</span> Recovering: ${tired.length ? tired.slice(0, 4).map((m) => MUSCLES[m]).join(', ') : 'nothing — you\'re fresh'}</div><div class="small mt"><span class="good">●</span> Ready: ${ready.slice(0, 6).map((m) => MUSCLES[m]).join(', ') || '—'}</div></div><span class="chev faint">›</span></div></button>`;
  }

  // Body weight
  const bw = [...S.body].sort((a, b) => a.date - b.date);
  const last = bw[bw.length - 1];
  html += `<h3>Body weight</h3><div class="card"><div class="row between"><div>${last ? `<div class="big">${fmtW(last.kg)}</div><div class="small muted">${relDay(last.date)}${S.settings.bwGoal ? ` · goal ${fmtW(S.settings.bwGoal)}` : ''}</div>` : '<div class="muted">No entries yet</div>'}</div><div class="row">${sparkline(bw.slice(-20).map((b) => b.kg))}<button class="btn sm primary" data-act="addBW">+ Log</button></div></div></div>`;

  // Last workout
  const lw = S.workouts.find((w) => dkey(w.start) !== dkey(now));
  if (lw) html += `<h3>Last workout</h3><div class="list"><button class="list-item" data-act="viewWorkout" data-id="${lw.id}"><div class="grow"><div>${esc(lw.name)}</div><div class="sub">${relDay(lw.start)} · ${fmtDur(wDur(lw))} · ${fmtVol(wVolume(lw))}</div></div><span class="chev">›</span></button></div>`;
  return html;
};

/* ---------- Workout ---------- */
VIEWS.workout = () => {
  if (!S.active) return workoutStart();
  const a = S.active;
  setTop(`<span data-elapsed>${a.editing ? 'Edit workout' : fmtClock(wDur(a) / 1000)}</span>`,
    `<button class="iconbtn" data-act="workoutMenu">•••</button>`,
    `<button class="btn primary sm" data-act="finishWorkout">${a.editing ? 'Save' : 'Finish'}</button>`);
  const eff = S.settings.effort;
  const mains = a.entries.filter((e) => !isMob(e.exId));
  const mob = a.entries.length - mains.length;
  const totalSets = mains.reduce((n, e) => n + e.sets.filter((s) => !s.warm).length, 0), doneSets = wSets(a);
  const exDone = mains.filter((e) => e.sets.length && e.sets.filter((s) => !s.warm).every((s) => s.done)).length;
  let html = `<div class="card"><input class="input" data-on="wName" value="${esc(a.name)}" style="font-weight:650;font-size:1.15rem;border:0;background:transparent;padding:4px 0">`;
  if (a.editing) {
    const dt = new Date(a.start); const local = `${dkey(dt)}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    html += `<div class="grid2 mt"><div class="field mb0"><label>Started</label><input class="input" type="datetime-local" data-on="wStart" value="${local}"></div><div class="field mb0"><label>Duration (min)</label><input class="input" inputmode="numeric" data-on="wDurMin" value="${Math.round(wDur(a) / 6e4) || ''}"></div></div>`;
  } else {
    html += `<div class="row between small"><span><b>${mains.length}</b> exercise${mains.length === 1 ? '' : 's'}${mob ? ` <span class="muted">+ ${mob} warm-up/stretch</span>` : ''}</span><span class="muted">${exDone}/${mains.length} done · ${doneSets}/${totalSets} sets</span></div><div class="progress"><i style="width:${totalSets ? Math.round(doneSets / totalSets * 100) : 0}%"></i></div><div class="tiny muted mt">${fmtDate(a.start, { weekday: 'long', day: 'numeric', month: 'long' })} · ${fmtVol(wVolume(a))}</div>`;
  }
  html += `</div>`;
  html += healthBanner();
  if (!a.entries.length) html += `<div class="empty"><div class="ico">${ico('lift', 'xl')}</div>Add your first exercise to get going.</div>`;

  let lastPhase = null, exN = 0;
  a.entries.forEach((e, ei) => {
    const ex = getEx(e.exId), t = ex.type, mobil = t === 'mobility';
    const phase = e.phase || (mobil ? 'warmup' : 'main');
    if (phase !== lastPhase && (mob || lastPhase)) {
      const ph = a.entries.filter((x) => (x.phase || (isMob(x.exId) ? 'warmup' : 'main')) === phase);
      const mins = Math.round(ph.reduce((n, x) => n + x.sets.reduce((m, s) => m + (s.t || 0), 0), 0) / 60);
      html += `<div class="phase ${phase === 'warmup' ? 'warm' : phase === 'cooldown' ? 'cool' : ''}">${phase === 'warmup' ? `${ico('sun', 'xs')} Warm-up${mins ? ` · ~${mins} min` : ''}` : phase === 'cooldown' ? `${ico('snow', 'xs')} Cool-down${mins ? ` · ~${mins} min` : ''}` : `${ico('dumbbell', 'xs')} Workout · ${mains.length} exercises`}</div>`;
      lastPhase = phase;
    }
    if (!mobil) exN++;
    const rec = records(e.exId, { exclude: a.origId || a.id });
    const ssPrev = ei > 0 && e.ss && a.entries[ei - 1].ss === e.ss, ssNext = a.entries[ei + 1] && e.ss && a.entries[ei + 1].ss === e.ss;
    const ssLabel = e.ss ? `<span class="tag accent">Superset${ssPrev ? '' : ' ↓'}</span>` : '';
    let target = '';
    if (e.item && !mobil) {
      if (t === 'timed') target = `${e.item.sets || 3}× ${e.sg?.t || e.item.time || 30}s`;
      else if (t !== 'cardio') target = `${e.item.sets || 3}×${e.item.repMin || 8}${e.item.repMax && e.item.repMax !== e.item.repMin ? '–' + e.item.repMax : ''}`;
    }
    const hint = e.sg && e.sg.src ? `<div class="ex-hint">${target ? `Target ${target}${e.sg.w ? ' @ ' + fmtW(e.sg.w) : ''} · ` : ''}<span class="src">${esc(e.sg.src)}</span>${rec.e1rm ? ` · best e1RM ${fmtW(rec.e1rm)}` : ''}</div>` : '';
    const timedLike = t === 'timed' || mobil;
    const dbm = e.dbMode && DB_MODES[e.dbMode];
    const wLabel = t === 'bodyweight' ? `+${U()}` : t === 'assisted' ? `−${U()}` : t === 'cardio' ? 'Min' : dbm ? `${U()}/DB` : U();
    const rLabel = timedLike ? (dbm && e.dbMode !== 'one' ? 'Sec/side' : 'Sec') : t === 'cardio' ? distU() : dbm && e.dbMode !== 'one' ? 'Reps/arm' : 'Reps';
    html += `<div class="ex ${e.ss ? 'superset' : ''}" ${ssNext ? 'style="margin-bottom:3px"' : ''}><div class="ex-head"><button style="border:0;background:none;padding:0" data-act="exDetail" data-id="${e.exId}" aria-label="How to do ${esc(ex.name)}">${thumb(ex)}</button><div class="grow" style="min-width:0"><div class="exnum">${mobil ? (phase === 'cooldown' ? 'STRETCH' : 'WARM-UP') : `EXERCISE ${exN} OF ${mains.length}`}</div><div class="name">${esc(ex.name)} ${ssLabel}</div><div class="tiny muted">${MUSCLES[ex.muscle] || ''}${ex.secondary.length ? ' + ' + ex.secondary.slice(0, 2).map((m) => MUSCLES[m]).join(', ') : ''}${e.note ? ` · ${ico('note', 'xs')} ` + esc(e.note) : ''}</div><button class="btn ghost sm" style="padding:2px 0" data-act="exDetail" data-id="${e.exId}">How to ›</button></div><button class="iconbtn" data-act="exMenu" data-e="${ei}">•••</button></div>${hint}${dbm ? `<div style="padding:0 12px 8px"><div class="chips" style="padding:0 0 4px">${Object.entries(DB_MODES).map(([k, m]) => `<button class="chip ${e.dbMode === k ? 'on' : ''}" style="padding:4px 10px" data-act="dbMode" data-e="${ei}" data-v="${k}">${m.short}</button>`).join('')}</div><div class="tiny muted">${ico('dumbbell', 'xs')} ${dbm.help}</div></div>` : ''}${riskNote(e.exId, ei)}${mobil ? '' : coachHTML(e, ei)}`;
    const showEff = eff !== 'off' && t !== 'cardio' && !mobil;
    html += `<table class="sets"><thead><tr><th>Set</th><th>Prev</th>${mobil ? '' : `<th>${wLabel}</th>`}<th>${rLabel}</th>${showEff ? `<th>${eff.toUpperCase()}</th>` : ''}<th>✓</th></tr></thead><tbody>`;
    let wn = 0;
    e.sets.forEach((s, si) => {
      const p = s.warm ? null : e.prev[wn];
      const label = s.warm ? 'W' : ++wn;
      const prs = !s.warm && s.done && !mobil ? prTags(e.exId, s, rec) : null;
      let prevTxt = '–';
      if (p) {
        if (timedLike) prevTxt = `${p.t || 0}s`;
        else if (t === 'cardio') prevTxt = `${Math.round((p.t || 0) / 60)}′ ${num(toD(p.d), 1)}`;
        else if (t === 'bodyweight' && !p.w) prevTxt = `${p.r || 0}`;
        else prevTxt = `${num(toU(p.w), 1)}×${p.r || 0}`;
      }
      const ph = (v) => (v == null || v === '' ? '' : esc(v));
      let c1 = '', c2;
      if (t === 'cardio') {
        c1 = `<td><input class="cell" inputmode="decimal" data-cell="tm" value="${s.t != null ? num(s.t / 60, 1) : ''}" placeholder="${p ? num((p.t || 0) / 60, 1) : 'min'}"></td>`;
        c2 = `<input class="cell" inputmode="decimal" data-cell="d" value="${s.d != null ? num(toD(s.d), 2) : ''}" placeholder="${p ? num(toD(p.d), 2) : distU()}">`;
      } else {
        if (!mobil) c1 = `<td><input class="cell" inputmode="decimal" data-cell="w" value="${s.w != null ? num(toU(s.w), 2) : ''}" placeholder="${p && p.w ? num(toU(p.w), 1) : (t === 'weight' ? U() : '0')}"></td>`;
        c2 = timedLike
          ? `<div class="row" style="gap:3px;justify-content:center"><input class="cell" style="max-width:56px" inputmode="numeric" data-cell="t" value="${ph(s.t)}" placeholder="${p ? p.t : 's'}"><button class="check" style="width:32px" data-act="holdTimer" data-e="${ei}" data-s="${si}">▶</button></div>`
          : `<input class="cell" inputmode="numeric" data-cell="r" value="${ph(s.r)}" placeholder="${p ? p.r : (e.sg?.r || '')}">`;
      }
      const c3 = showEff ? `<td><input class="cell rpe" inputmode="decimal" data-cell="eff" value="${s.eff && s.eff.v != null ? num(s.eff.v, 1) : ''}" placeholder="${s.eff && s.eff.scale !== eff ? s.eff.scale : '–'}"></td>` : '';
      const tech = s.tech && TECH[s.tech] ? `<span class="tech">${TECH[s.tech].short}</span>` : '';
      html += `<tr class="${s.done ? 'done' : ''} ${s.warm ? 'warm' : ''} ${UI.justDone === s.id ? 'pop' : ''}" data-e="${ei}" data-s="${si}"><td><button class="setno" data-act="setMenu" data-e="${ei}" data-s="${si}">${s.tech === 'drop' ? '↓' : label}${tech}</button></td><td class="prev">${prs ? `<span class="prflag">${ico('trophy', 'xs gold')}</span> ` : ''}${prevTxt}</td>${c1}<td>${c2}</td>${c3}<td><button class="check" data-act="toggleDone" data-e="${ei}" data-s="${si}">✓</button></td></tr>`;
    });
    const isBar = ['barbell', 'trapbar', 'ezbar'].includes(ex.equipment);
    html += `</tbody></table><div class="ex-foot"><button class="btn sm" data-act="addSet" data-e="${ei}">+ Set</button>${t === 'weight' ? `<button class="btn sm" data-act="addDrop" data-e="${ei}">+ Drop set</button><button class="btn sm" data-act="addWarmups" data-e="${ei}">Warm-ups</button>` : ''}${isBar ? `<button class="btn sm" data-act="plateCalc" data-e="${ei}">Plates</button>` : ''}</div></div>`;
  });
  html += `<button class="btn block primary" data-act="addExercise">+ Add exercise</button>`;
  html += `<div class="grid3 mt"><button class="btn sm" data-act="plateCalc">Plates</button><button class="btn sm" data-act="oneRmCalc">1RM calc</button><button class="btn sm" data-act="techGuide">Methods</button></div>`;
  html += `<div class="field mt"><label>Workout notes</label><textarea class="input" data-on="wNotes" placeholder="How did it feel?">${esc(a.notes || '')}</textarea></div>`;
  html += `<p class="tiny faint center">Tap a set number for warm-up, drop set, rest-pause and other techniques. Tap the photo for a how-to guide.</p>`;
  return html;
};

function workoutStart() {
  setTop('Workout', '', `<button class="iconbtn" data-act="logPast">Log past</button>`);
  const r = routineFor(Date.now());
  let html = '';
  if (r) html += `<div class="card hero"><div class="small muted">Planned for today</div><div class="big">${esc(r.name)}</div><button class="btn primary block mt" data-act="startRoutine" data-id="${r.id}">Start ${esc(r.name)}</button></div>`;
  html += `<button class="btn block ${r ? '' : 'primary'}" data-act="startEmpty">Start empty workout</button>`;
  if (S.routines.length) {
    html += `<h3>Routines</h3><div class="list">${S.routines.map((x) => `<button class="list-item" data-act="startRoutine" data-id="${x.id}"><div class="grow"><div>${esc(x.name)}</div><div class="sub ellipsis"><b>${x.items.filter((i) => !isMob(i.exId)).length} exercises</b> · ${x.items.filter((i) => !isMob(i.exId)).map((i) => esc(getEx(i.exId).name)).join(', ') || 'No exercises'}</div></div><span class="accent small">Start</span></button>`).join('')}</div>`;
  }
  html += `<h3>History</h3>`;
  if (!S.workouts.length) return html + `<div class="empty"><div class="ico">${ico('clipboard', 'xl')}</div>No workouts yet. Your history will appear here.</div>`;
  let month = '';
  html += `<div>`;
  S.workouts.slice(0, UI.histLimit).forEach((w) => {
    const m = fmtDate(w.start, { month: 'long', year: 'numeric' });
    if (m !== month) { if (month) html += `</div>`; html += `<h3 style="margin-top:14px">${m}</h3><div class="list">`; month = m; }
    const prs = workoutPRs(w).length;
    html += `<button class="list-item" data-act="viewWorkout" data-id="${w.id}"><div class="grow"><div>${esc(w.name)} ${prs ? `<span class="tag pr">${ico('trophy', 'xs')} ${prs}</span>` : ''}</div><div class="sub">${fmtDate(w.start)} · ${fmtDur(wDur(w))} · ${wSets(w)} sets · ${fmtVol(wVolume(w))}</div></div><span class="chev">›</span></button>`;
  });
  html += `</div></div>`;
  if (S.workouts.length > UI.histLimit) html += `<button class="btn block mt" data-act="moreHistory">Show more</button>`;
  return html;
}

/* ---------- Plan ---------- */
VIEWS.plan = () => {
  setTop('Plan', '', `<button class="iconbtn" data-act="newRoutine">+ New</button>`);
  const order = [0, 1, 2, 3, 4, 5, 6].map((i) => (i + S.settings.weekStart) % 7);
  let html = `<h3>Weekly plan</h3><div class="list">`;
  order.forEach((d) => {
    html += `<div class="list-item"><div style="width:92px">${DOW_LONG[d]}</div><select class="input grow" data-on="planDay" data-d="${d}"><option value="">Rest</option>${S.routines.map((r) => `<option value="${r.id}" ${S.plan.days[d] === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>`;
  });
  html += `</div><p class="tiny faint" style="margin:-4px 4px 10px">Tip: tap a day on the Home screen to move a single session without changing the plan.</p>`;
  const ov = Object.entries(S.plan.overrides).filter(([k]) => parseKey(k).getTime() >= sod(Date.now())).sort();
  if (ov.length) {
    html += `<h3>Moved sessions</h3><div class="list">${ov.map(([k, id]) => `<div class="list-item"><div class="grow">${fmtDate(parseKey(k))}</div><div class="muted">${id ? esc(S.routines.find((r) => r.id === id)?.name || '?') : 'Rest'}</div><button class="btn ghost sm" data-act="clearOverride" data-d="${k}">Reset</button></div>`).join('')}</div>`;
  }
  html += `<h3>Routines</h3>`;
  if (!S.routines.length) html += `<div class="empty"><div class="ico">${ico('calendar', 'xl')}</div>No routines yet.</div>`;
  else html += `<div class="list">${S.routines.map((r) => `<button class="list-item" data-act="editRoutine" data-id="${r.id}"><div class="grow"><div>${esc(r.name)}</div><div class="sub ellipsis">${r.items.filter((i) => !isMob(i.exId)).length} exercises${r.items.some((i) => isMob(i.exId)) ? ' + warm-up/cool-down' : ''} · block ${routineBlock(r).n} · ${PROG[r.prog]}</div></div><span class="chev">›</span></button>`).join('')}</div>`;
  html += `<div class="grid2"><button class="btn" data-act="newRoutine">+ New routine</button><button class="btn" data-act="openTemplates">Program library</button></div>`;
  return html;
};

/* ---------- Stats ---------- */
VIEWS.stats = () => {
  setTop('Stats');
  const tabs = { overview: 'Overview', exercises: 'Lifts', muscles: 'Muscles', body: 'Body' };
  let html = `<div class="seg" style="margin-bottom:14px">${Object.entries(tabs).map(([k, v]) => `<button class="${UI.statsTab === k ? 'on' : ''}" data-act="statsTab" data-v="${k}">${v}</button>`).join('')}</div>`;
  return html + STATS[UI.statsTab]();
};
const STATS = {};
STATS.overview = () => {
  const W = S.workouts;
  if (!W.length) return `<div class="empty"><div class="ico">${ico('trend', 'xl')}</div>Log a workout to see your stats.</div>`;
  const totalVol = W.reduce((a, w) => a + wVolume(w), 0), totalTime = W.reduce((a, w) => a + wDur(w), 0);
  const st = weekStreak(), prs = totalPRs();
  let html = `<div class="grid2"><div class="stat"><div class="v">${W.length}</div><div class="l">Workouts</div></div><div class="stat"><div class="v">${Math.round(totalTime / 36e5)}h</div><div class="l">Time trained</div></div><div class="stat"><div class="v">${fmtVol(totalVol)}</div><div class="l">Total volume</div></div><div class="stat"><div class="v">${prs}</div><div class="l">Personal records</div></div><div class="stat"><div class="v">${st.cur} wk</div><div class="l">Current streak</div></div><div class="stat"><div class="v">${st.best} wk</div><div class="l">Best streak</div></div></div>`;
  // Heatmap
  const start = weekStartOf(Date.now() - 52 * 7 * DAY), byDay = {};
  W.forEach((w) => { const k = dkey(w.start); byDay[k] = (byDay[k] || 0) + wDur(w); });
  let cells = '', n = 0;
  for (let t = start; n < 53 * 7; t += DAY, n++) {
    const d = new Date(t); d.setHours(12); const k = dkey(d), m = (byDay[k] || 0) / 6e4;
    const l = d.getTime() > Date.now() ? 'fut' : !m ? '' : m < 30 ? 'l1' : m < 60 ? 'l2' : m < 90 ? 'l3' : 'l4';
    cells += `<i class="${l}" title="${k}"></i>`;
  }
  html += `<h3>Last 12 months</h3><div class="card"><div class="heat" id="heat">${cells}</div><div class="legend">Less <i style="width:10px;height:10px;background:var(--card2);border-radius:2px"></i><i class="l2" style="width:10px;height:10px;border-radius:2px;background:color-mix(in srgb,var(--accent) 55%,var(--card2))"></i><i style="width:10px;height:10px;background:var(--accent);border-radius:2px"></i> More (by duration)</div></div>`;
  // Weekly volume
  const weeks = [], labels = [], counts = [];
  const ws0 = weekStartOf(Date.now());
  for (let i = 11; i >= 0; i--) {
    const a = ws0 - i * 7 * DAY, b = a + 7 * DAY;
    const ww = W.filter((w) => w.start >= a && w.start < b);
    weeks.push(toU(ww.reduce((s, w) => s + wVolume(w), 0))); counts.push(ww.length);
    labels.push(fmtDate(a, { day: 'numeric', month: 'numeric' }));
  }
  html += `<h3>Weekly volume (${U()})</h3><div class="card">${barChart(labels, weeks, { fmt: (v) => (v >= 1000 ? num(v / 1000, 1) + 'k' : num(v, 0)) })}</div>`;
  html += `<h3>Sessions per week</h3><div class="card">${barChart(labels, counts, { h: 110 })}</div>`;
  // Badges
  const hasEarly = W.some((w) => new Date(w.start).getHours() < 7), hasLate = W.some((w) => new Date(w.start).getHours() >= 21), long = W.some((w) => wDur(w) >= 7200e3);
  const B = [
    ['flag', 'First workout', W.length >= 1], ['medal', '10 workouts', W.length >= 10], ['dumbbell', '50 workouts', W.length >= 50], ['trophy', '100 workouts', W.length >= 100],
    ['flame', '4-week streak', st.best >= 4], ['bolt', '12-week streak', st.best >= 12], ['star', '10 PRs', prs >= 10], ['crown', '50 PRs', prs >= 50],
    ['lift', '10 t lifted', totalVol >= 1e4], ['barbell', '100 t lifted', totalVol >= 1e5], ['sunrise', 'Early bird', hasEarly], ['moon', 'Night owl', hasLate],
    ['stopwatch', '2-hour session', long], ['calendar', '3 months logged', W.length && (Date.now() - W[W.length - 1].start) > 90 * DAY], ['scale', '10 weigh-ins', S.body.length >= 10], ['target', 'Used RPE/RIR', W.some((w) => w.entries.some((e) => e.sets.some((s) => s.eff && s.eff.v != null)))]
  ];
  html += `<h3>Badges</h3><div class="badge-grid">${B.map(([e, l, got]) => `<div class="badge ${got ? 'got' : ''}"><div class="e">${ico(e, 'lg')}</div>${l}</div>`).join('')}</div>`;
  return html;
};
STATS.exercises = () => {
  const done = {};
  for (const w of S.workouts) for (const e of w.entries) if (e.sets.some(isWork)) { done[e.exId] = done[e.exId] || { n: 0, last: w.start }; done[e.exId].n++; }
  const ids = Object.keys(done);
  if (!ids.length) return `<div class="empty"><div class="ico">${ico('dumbbell', 'xl')}</div>No lifts logged yet.</div>`;
  let html = '';
  const sb = structuralBalance();
  html += `<h3>Structural balance</h3><div class="card">`;
  if (sb) {
    html += `<div class="small">Weakest link: <b class="accent">${sb.weakest.name}</b> (${Math.round(sb.weakest.pct)}% of expected)</div><div class="bars mt">${sb.rows.map((r) => `<div class="b"><div class="n ellipsis">${r.name}</div><div class="track"><div class="fill" style="width:${Math.min(100, r.pct)}%;${r.pct < 85 ? 'background:var(--bad)' : r.pct < 95 ? 'background:var(--warn)' : ''}"></div></div><div class="v">${Math.round(r.pct)}%</div></div>`).join('')}</div><p class="tiny faint">Compares your estimated 1RMs to classic strength-coach ratios (squat = 100, deadlift ≈ 120, bench ≈ 75, overhead press ≈ 47…). 100% = your strongest lift relative to the ratio. Approximate — use it as a nudge, not a rule.</p>`;
  } else html += `<div class="small muted">Log at least two of: Back Squat, Deadlift, Bench Press, Overhead Press, Barbell Row, Front Squat, Romanian Deadlift to compare your lifts against classic strength ratios.</div>`;
  html += `</div><h3>Your exercises</h3><div class="list">`;
  ids.sort((a, b) => done[b].last - done[a].last).forEach((id) => {
    const ex = getEx(id), rec = records(id);
    const best = ex.type === 'weight' && rec.e1rm ? `e1RM ${fmtW(rec.e1rm)}` : ex.type === 'timed' ? `${rec.time}s best` : ex.type === 'cardio' ? `${num(toD(rec.dist), 1)} ${distU()} best` : `${rec.reps} reps best`;
    html += `<button class="list-item" data-act="exDetail" data-id="${id}"><div class="grow"><div>${esc(ex.name)}</div><div class="sub">${done[id].n} sessions · ${relDay(done[id].last)}</div></div><div class="small accent">${best}</div><span class="chev">›</span></button>`;
  });
  return html + `</div>`;
};
STATS.muscles = () => {
  const modes = { balance: 'Balance', fatigue: 'Fatigue', strength: 'Strength' };
  let html = `<div class="seg" style="margin-bottom:12px">${Object.entries(modes).map(([k, v]) => `<button class="${UI.muscleMode === k ? 'on' : ''}" data-act="muscleMode" data-v="${k}">${v}</button>`).join('')}</div>`;
  const ms = Object.keys(MUSCLES).filter((m) => m !== 'cardio');
  if (UI.muscleMode === 'balance') {
    const sets = muscleSets(7), vals = {};
    ms.forEach((m) => { vals[m] = Math.min(1, sets[m] / 20); });
    const low = ms.filter((m) => sets[m] < 10).sort((a, b) => sets[a] - sets[b]);
    html += `<div class="card">${bodyMap(vals, 'balance')}</div><div class="card"><div class="small">Hard sets per muscle, last 7 days. Secondary muscles count as ½ set. Shaded zone = 10–20 sets, a common hypertrophy target.</div>${low.length ? `<div class="small mt">Gaps: <b class="accent">${low.slice(0, 5).map((m) => MUSCLES[m]).join(', ')}</b></div>` : ''}<div class="bars mt">${ms.sort((a, b) => sets[b] - sets[a]).map((m) => `<div class="b"><div class="n">${MUSCLES[m]}</div><div class="track"><div class="zone" style="left:${10 / 25 * 100}%;width:${10 / 25 * 100}%"></div><div class="fill" style="width:${Math.min(100, sets[m] / 25 * 100)}%"></div></div><div class="v">${num(sets[m], 1)}</div></div>`).join('')}</div></div>`;
  } else if (UI.muscleMode === 'fatigue') {
    const f = muscleFatigue();
    html += `<div class="card">${bodyMap(f, 'fatigue')}</div><div class="card"><div class="small">Recovery estimate from the last 7 days. Each set's effect fades over ~2–3 days; sets near failure (low RIR / high RPE) count more.</div><div class="bars mt">${ms.sort((a, b) => f[b] - f[a]).map((m) => `<div class="b"><div class="n">${MUSCLES[m]}</div><div class="track"><div class="fill" style="width:${Math.round((1 - f[m]) * 100)}%;background:${f[m] > 0.6 ? 'var(--bad)' : f[m] > 0.3 ? 'var(--warn)' : 'var(--good)'}"></div></div><div class="v">${Math.round((1 - f[m]) * 100)}%</div></div>`).join('')}</div><p class="tiny faint">% = estimated recovery.</p></div>`;
  } else {
    const s = muscleStrength(), vals = {};
    ms.forEach((m) => { const d = s[m].last ? (Date.now() - s[m].last) / DAY : 99; vals[m] = Math.max(0, 1 - d / 14); });
    html += `<div class="card">${bodyMap(vals, 'strength')}</div><div class="list">${ms.sort((a, b) => (s[b].last || 0) - (s[a].last || 0)).map((m) => {
      const lifts = Object.entries(s[m].lifts).sort((a, b) => b[1] - a[1]).slice(0, 2);
      return `<div class="list-item"><div class="grow"><div>${MUSCLES[m]}</div><div class="sub ellipsis">${lifts.length ? lifts.map(([id, v]) => `${esc(getEx(id).name)} ${fmtW(v, 0)}`).join(' · ') : 'No weighted lifts'}</div></div><div class="small ${s[m].last && Date.now() - s[m].last > 10 * DAY ? 'bad' : 'muted'}">${s[m].last ? relDay(s[m].last) : 'Never'}</div></div>`;
    }).join('')}</div>`;
  }
  return html;
};
STATS.body = () => {
  const bw = [...S.body].sort((a, b) => a.date - b.date), goal = S.settings.bwGoal;
  let html = `<div class="row between"><h3 style="margin:0">Body weight</h3><div class="row"><button class="btn sm" data-act="setGoal">Goal</button><button class="btn sm primary" data-act="addBW">+ Log</button></div></div><div class="card mt">`;
  if (bw.length) {
    const pts = bw.map((b, i) => {
      let c = null;
      if (goal != null && i > 0) { const prev = Math.abs(bw[i - 1].kg - goal), cur = Math.abs(b.kg - goal); c = cur < prev ? 'var(--good)' : cur > prev ? 'var(--bad)' : null; }
      return { x: b.date, y: toU(b.kg), c };
    });
    const last = bw[bw.length - 1], m30 = bw.filter((b) => b.date >= last.date - 30 * DAY)[0];
    const delta = last.kg - m30.kg;
    html += `<div class="row between"><div class="big">${fmtW(last.kg)}</div><div class="small ${goal != null ? (Math.abs(last.kg - goal) < Math.abs(m30.kg - goal) ? 'good' : 'bad') : 'muted'}">${delta >= 0 ? '+' : ''}${num(toU(delta), 1)} ${U()} / 30 days</div></div>${lineChart(pts, { goal: goal != null ? toU(goal) : null })}${goal != null ? `<div class="tiny faint">Green dots moved toward your goal, red away.</div>` : ''}`;
  } else html += `<div class="empty small">No weigh-ins yet.</div>`;
  html += `</div>`;
  if (bw.length) html += `<div class="list">${[...bw].reverse().slice(0, 15).map((b) => `<button class="list-item" data-act="editBW" data-id="${b.id}"><div class="grow">${fmtDate(b.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div><div>${fmtW(b.kg)}</div></button>`).join('')}</div>`;
  html += scansHTML();
  // Measurements
  const MS = measureFields();
  html += `<div class="row between mt"><h3 style="margin:0">Measurements</h3><button class="btn sm primary" data-act="addMeasure">+ Log</button></div>`;
  const mm = [...S.measures].sort((a, b) => b.date - a.date);
  if (!mm.length) html += `<div class="card mt small muted">Track waist, chest, arms and more to see changes the scale misses.</div>`;
  else {
    const first = mm[mm.length - 1], latest = mm[0];
    html += `<div class="card mt"><div class="small muted">Latest ${fmtDate(latest.date)} · change since ${fmtDate(first.date, { day: 'numeric', month: 'short' })}</div><div class="bars">${MS.filter(([k]) => latest[k] != null).map(([k, l, u]) => { const d = first[k] != null ? latest[k] - first[k] : 0; return `<div class="b"><div class="n">${l}</div><div class="grow">${num(latest[k], 1)} ${u}</div><div class="v small ${d < 0 ? 'good' : d > 0 ? 'accent' : 'muted'}" style="width:60px">${d > 0 ? '+' : ''}${num(d, 1)}</div></div>`; }).join('')}</div></div><div class="list">${mm.slice(0, 10).map((m) => `<button class="list-item" data-act="editMeasure" data-id="${m.id}"><div class="grow">${fmtDate(m.date)}</div><span class="chev">›</span></button>`).join('')}</div>`;
  }
  return html;
};
const measureFields = () => { const u = isLb() ? 'in' : 'cm'; return [['waist', 'Waist', u], ['chest', 'Chest', u], ['hips', 'Hips', u], ['arm', 'Arm', u], ['thigh', 'Thigh', u], ['calf', 'Calf', u], ['neck', 'Neck', u], ['bodyfat', 'Body fat', '%']]; };

/* ---------- Library ---------- */
function fuzzy(q, list) {
  q = q.trim().toLowerCase(); if (!q) return list;
  const toks = q.split(/\s+/);
  const scored = [];
  for (const ex of list) {
    const n = ex.name.toLowerCase(), hay = `${n} ${MUSCLES[ex.muscle] || ''} ${EQUIPMENT[ex.equipment] || ''}`.toLowerCase();
    let score = 0, ok = true;
    for (const t of toks) {
      const i = hay.indexOf(t);
      if (i >= 0) { score += i === 0 ? 0 : (hay[i - 1] === ' ' ? 1 : 3); continue; }
      let j = 0; for (const ch of hay) if (ch === t[j]) j++;
      if (j === t.length) score += 8; else { ok = false; break; }
    }
    if (ok) scored.push([score + n.length / 50, ex]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}
function filterEx(q, muscle, eq, owned) {
  let l = EX_LIST;
  if (muscle) l = l.filter((e) => e.muscle === muscle);
  if (eq) l = l.filter((e) => e.equipment === eq);
  if (owned && S.settings.owned.length) l = l.filter((e) => e.equipment === 'bodyweight' || e.equipment === 'other' || S.settings.owned.includes(e.equipment));
  return fuzzy(q, l);
}
const muscleChips = (cur, act) => `<div class="chips"><button class="chip ${!cur ? 'on' : ''}" data-act="${act}" data-v="">All</button>${Object.entries(MUSCLES).map(([k, v]) => `<button class="chip ${cur === k ? 'on' : ''}" data-act="${act}" data-v="${k}">${v}</button>`).join('')}</div>`;
VIEWS.library = () => {
  setTop('Library', `<button class="iconbtn" data-act="techGuide">Methods</button>`, `<button class="iconbtn" data-act="newCustomEx">+ Custom</button>`);
  const list = filterEx(UI.libQ, UI.libMuscle, UI.libEq, UI.libOwned);
  let html = `<div class="search"><input class="input" type="search" placeholder="Search ${EX_LIST.length} exercises" data-oninput="libQ" value="${esc(UI.libQ)}" autocomplete="off"></div>`;
  html += muscleChips(UI.libMuscle, 'libMuscle');
  html += `<div class="row" style="margin-bottom:10px"><select class="input grow" data-on="libEq"><option value="">All equipment</option>${Object.entries(EQUIPMENT).map(([k, v]) => `<option value="${k}" ${UI.libEq === k ? 'selected' : ''}>${v}</option>`).join('')}</select>${S.settings.owned.length ? `<button class="chip ${UI.libOwned ? 'on' : ''}" data-act="libOwned">My gear</button>` : ''}</div>`;
  html += `<div id="liblist">${libList(list)}</div>`;
  return html;
};
const libList = (list) => list.length ? `<div class="list">${list.slice(0, 250).map((ex) => `<button class="list-item" data-act="exDetail" data-id="${ex.id}">${thumb(ex)}<div class="grow"><div>${esc(ex.name)} ${ex.custom ? '<span class="tag accent">custom</span>' : ''}</div><div class="sub">${MUSCLES[ex.muscle] || ''} · ${EQUIPMENT[ex.equipment] || ''}</div></div><span class="chev">›</span></button>`).join('')}</div>` : `<div class="empty">No matches. <button class="btn ghost" data-act="newCustomEx">Create a custom exercise</button></div>`;

/* ======================= Sheets content ======================= */
function exDetailSheet(id) {
  const st = { tab: 'guide' };
  openSheet({
    title: getEx(id).name, st,
    right: getEx(id).custom ? { label: 'Edit', fn: () => customExSheet(id) } : null,
    render: () => {
      const ex = getEx(id), hist = entriesFor(id), g = guideOf(ex);
      let h = `<div class="seg" style="margin-bottom:12px"><button class="${st.tab === 'guide' ? 'on' : ''}" data-act="exTab" data-v="guide">How to</button><button class="${st.tab === 'stats' ? 'on' : ''}" data-act="exTab" data-v="stats">My progress${hist.length ? ` (${hist.length})` : ''}</button></div>`;
      if (st.tab === 'guide') {
        if (g && g.n) h += `<div class="gallery" data-act="galleryTap"><img src="img/${g.img}-0.jpg" alt="${esc(ex.name)} start position">${g.n > 1 ? `<img class="b" src="img/${g.img}-1.jpg" alt="${esc(ex.name)} end position">` : ''}<span class="lbl">${g.n > 1 ? 'Start ⇄ finish · tap to pause' : 'Position'}</span></div>`;
        h += `<div class="card musclecard"><div style="width:120px">${miniMap(ex)}</div><div><div class="small"><b class="accent">${MUSCLES[ex.muscle] || ''}</b> <span class="muted">primary</span></div>${ex.secondary.length ? `<div class="small mt">${ex.secondary.map((m) => MUSCLES[m] || m).join(', ')} <span class="muted">secondary</span></div>` : ''}<div class="row wrap mt" style="gap:4px"><span class="tag">${EQUIPMENT[ex.equipment] || ''}</span><span class="tag">${TYPES[ex.type]}</span>${g && g.level ? `<span class="tag">${g.level}</span>` : ''}</div></div></div>`;
        h += riskNote(ex.id, null);
        const steps = (g && g.steps) || window.CUSTOM_STEPS[ex.name] || (ex.notes ? [ex.notes] : []);
        if (steps.length) h += `<h3>Step by step</h3><div class="card"><ol class="steps">${steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>`;
        const tips = safetyFor(ex);
        if (tips.length) h += `<h3>Stay safe</h3><div class="card"><ul class="tips">${tips.map((x) => `<li>${ico('shield', 'xs accent')}<span>${esc(x)}</span></li>`).join('')}</ul></div>`;
        const tq = techFor(ex);
        if (tq.length) h += `<h3>Push it further</h3><div class="card small">Good techniques for this exercise: ${tq.map((k) => `<button class="chip" data-act="techGuide" data-v="${k}">${TECH[k].name}</button>`).join(' ')}</div>`;
        const alts = altsFor(ex);
        if (alts.length) h += `<h3>Variations (same movement)</h3><div class="list">${alts.map((x) => `<button class="list-item" data-act="exDetail" data-id="${x.id}">${thumb(x, 'sm')}<div class="grow">${esc(x.name)}<div class="sub">${EQUIPMENT[x.equipment]}</div></div><span class="chev">›</span></button>`).join('')}</div>`;
        if (ex.link && /^https?:\/\//i.test(ex.link)) h += `<a class="btn block" href="${esc(ex.link)}" target="_blank" rel="noopener noreferrer">Open guide ↗</a>`;
        h += `<a class="btn ghost block" href="https://www.youtube.com/results?search_query=${encodeURIComponent(ex.name + ' exercise proper form')}" target="_blank" rel="noopener noreferrer">Watch form videos on YouTube ↗</a>`;
        if (S.active) h += `<button class="btn primary block mt" data-act="addExToActive" data-id="${id}">Add to current workout</button>`;
        if (g) h += `<p class="tiny faint center mt">Photos & steps: Free Exercise DB (public domain).</p>`;
        return h;
      }
      const rec = records(id);
      if (!hist.length) return h + `<div class="empty small">You haven't logged this yet.</div>`;
      const pl = plateau(id);
      if (pl) h += `<div class="coach" style="margin:0 0 12px">${ico('bolt', 'xs warn')} <b>Plateau:</b> no new best in ${pl.n} sessions at ~${fmtW(pl.w)}. Next time try +${fmtW(defaultInc(ex))}, a rest-pause last set, or a drop set.</div>`;
      if (ex.type === 'weight') {
        const pts = [...hist].reverse().map(({ w, e }) => ({ x: w.start, y: toU(Math.max(0, ...e.sets.map(e1rm))) })).filter((p) => p.y > 0);
        h += `<h3>Estimated 1RM (${U()})</h3><div class="card">${lineChart(pts)}</div>`;
        h += `<div class="grid2"><div class="stat"><div class="v">${fmtW(rec.e1rm)}</div><div class="l">Best e1RM${rec.e1rmSet ? ` · ${num(toU(rec.e1rmSet.w), 1)}×${rec.e1rmSet.r}` : ''}</div></div><div class="stat"><div class="v">${fmtW(rec.heavy)}</div><div class="l">Heaviest${rec.heavySet ? ` · ${relDay(rec.heavySet.date)}` : ''}</div></div><div class="stat"><div class="v">${rec.volSet ? `${num(toU(rec.volSet.w), 1)}×${rec.volSet.r}` : '–'}</div><div class="l">Best volume set</div></div><div class="stat"><div class="v">${rec.count}</div><div class="l">Sessions</div></div></div>`;
        if (rec.e1rm) h += `<h3>Rep maxes (estimated)</h3><div class="card"><div class="grid3">${[1, 2, 3, 5, 8, 10, 12, 15, 20].map((r) => `<div><div class="tiny muted">${r}RM</div><b>${num(toU(r === 1 ? rec.e1rm : rec.e1rm / (1 + r / 30)), 1)}</b></div>`).join('')}</div><div class="tiny faint mt">Percentages: ${[90, 80, 70, 60].map((p) => `${p}% = ${num(toU(roundPlate(rec.e1rm * p / 100)), 1)}`).join(' · ')}</div></div>`;
      } else {
        const metric = ex.type === 'timed' || ex.type === 'mobility' ? (s) => s.t || 0 : ex.type === 'cardio' ? (s) => toD(s.d || 0) : (s) => s.r || 0;
        const pts = [...hist].reverse().map(({ w, e }) => ({ x: w.start, y: Math.max(0, ...e.sets.filter(isWork).map(metric)) }));
        h += `<h3>Best ${ex.type === 'timed' || ex.type === 'mobility' ? 'hold (s)' : ex.type === 'cardio' ? 'distance (' + distU() + ')' : 'reps'}</h3><div class="card">${lineChart(pts, { fmt: (v) => num(v, ex.type === 'cardio' ? 1 : 0) })}</div>`;
      }
      h += `<h3>History</h3><div class="list">${hist.slice(0, 25).map(({ w, e }) => `<button class="list-item" data-act="viewWorkout" data-id="${w.id}"><div class="grow"><div class="small">${fmtDate(w.start, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div><div class="sub">${e.sets.filter(isWork).map((s) => setStr(ex, s)).join(', ')}</div></div></button>`).join('')}</div>`;
      return h;
    }
  });
}
function setStr(ex, s) {
  const t = s.tech && TECH[s.tech] ? ` [${TECH[s.tech].short}]` : '';
  return setStr0(ex, s) + t;
}
function setStr0(ex, s) {
  if (ex.type === 'mobility') return `${s.t || 0}s`;
  if (ex.type === 'timed') return `${s.w ? num(toU(s.w), 1) + U() + ' ' : ''}${s.t || 0}s`;
  if (ex.type === 'cardio') return `${Math.round((s.t || 0) / 60)} min${s.d ? ' ' + num(toD(s.d), 2) + ' ' + distU() : ''}`;
  if (ex.type === 'bodyweight') return s.w ? `+${num(toU(s.w), 1)}×${s.r}` : `${s.r}`;
  if (ex.type === 'assisted') return `−${num(toU(s.w || 0), 1)}×${s.r}`;
  return `${num(toU(s.w), 1)}×${s.r}${s.eff && s.eff.v != null ? ` @${s.eff.scale === 'rpe' ? 'RPE' : 'RIR'}${num(s.eff.v, 1)}` : ''}`;
}

function viewWorkoutSheet(id) {
  openSheet({
    title: 'Workout',
    render: () => {
      const w = S.workouts.find((x) => x.id === id); if (!w) return '<div class="empty">Deleted.</div>';
      const prs = workoutPRs(w);
      let h = `<div class="big">${esc(w.name)}</div><div class="muted small">${fmtDate(w.start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${new Date(w.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`;
      h += `<div class="grid3 mt"><div class="stat"><div class="v" style="font-size:18px">${fmtDur(wDur(w))}</div><div class="l">Duration</div></div><div class="stat"><div class="v" style="font-size:18px">${fmtVol(wVolume(w))}</div><div class="l">Volume</div></div><div class="stat"><div class="v" style="font-size:18px">${wSets(w)}</div><div class="l">Sets</div></div></div>`;
      if (prs.length) h += `<div class="card mt"><b>${ico('trophy', 'xs gold')} ${prs.length} personal record${prs.length > 1 ? 's' : ''}</b>${prs.map((p) => `<div class="small mt">${esc(getEx(p.exId).name)} — ${setStr(getEx(p.exId), p.set)} <span class="tag pr">${p.tags.join(', ')}</span></div>`).join('')}</div>`;
      if (w.notes) h += `<div class="card small">${esc(w.notes)}</div>`;
      h += w.entries.map((e) => { const ex = getEx(e.exId); return `<div class="card"><div class="row between"><b>${esc(ex.name)}</b><span>${e.dbMode && DB_MODES[e.dbMode] ? `<span class="tag">${DB_MODES[e.dbMode].short}${e.dbMode !== 'one' ? ' · per arm' : ''}</span>` : ''}${e.ss ? '<span class="tag accent">superset</span>' : ''}</span></div>${e.note ? `<div class="tiny muted">${esc(e.note)}</div>` : ''}<div class="small mt">${e.sets.map((s, i) => `<div class="row between" style="padding:3px 0;border-bottom:1px solid var(--line)"><span class="${s.warm ? '' : 'muted'}" style="${s.warm ? 'color:var(--warn)' : ''}">${s.warm ? 'Warm-up' : 'Set ' + (e.sets.slice(0, i + 1).filter((x) => !x.warm).length)}</span><span>${setStr(ex, s)}${ex.type === 'weight' && e1rm(s) ? ` <span class="faint tiny">e1RM ${num(toU(e1rm(s)), 0)}</span>` : ''}</span></div>`).join('')}</div></div>`; }).join('');
      h += `<div class="grid2"><button class="btn" data-act="editWorkout" data-id="${w.id}">Edit</button><button class="btn" data-act="repeatWorkout" data-id="${w.id}">Repeat</button><button class="btn" data-act="saveAsRoutine" data-id="${w.id}">Save as routine</button><button class="btn" data-act="shareWorkout" data-id="${w.id}">Share summary</button></div><button class="btn danger block mt" data-act="deleteWorkout" data-id="${w.id}">Delete workout</button>`;
      return h;
    }
  });
}

/* ---------- Exercise picker ---------- */
function pickerSheet(onPick, opts = {}) {
  const st = { q: '', muscle: opts.muscle || '', sel: [] };
  const list = () => filterEx(st.q, st.muscle, '', UI.libOwned);
  const rows = () => {
    const l = list();
    const alts = !st.q && opts.alts && opts.alts.length ? opts.alts : [];
    const recent = !alts.length && !st.q && !st.muscle ? [...new Set(S.workouts.slice(0, 15).flatMap((w) => w.entries.map((e) => e.exId)))].filter((id) => EX[id] && !isMob(id)).slice(0, 8) : [];
    const item = (ex) => `<button class="list-item" data-act="pickToggle" data-id="${ex.id}">${thumb(ex, 'sm')}<div class="grow"><div>${esc(ex.name)}</div><div class="sub">${riskOf(ex.id) ? (riskOf(ex.id).level === 'avoid' ? ico('stop', 'xs bad') + ' ' : ico('warning', 'xs warn') + ' ') : ''}${MUSCLES[ex.muscle] || ''} · ${EQUIPMENT[ex.equipment] || ''}${ex.type === 'mobility' ? ' · stretch' : ''}</div></div><span class="${st.sel.includes(ex.id) ? 'accent' : 'faint'}" style="font-size:1.25rem">${st.sel.includes(ex.id) ? '●' : '○'}</span></button>`;
    return (alts.length ? `<h3>Same movement, new angle</h3><div class="list">${alts.map(item).join('')}</div><h3>All ${MUSCLES[st.muscle] || ''}</h3>` : '') + (recent.length ? `<h3>Recent</h3><div class="list">${recent.map((id) => item(EX[id])).join('')}</div><h3>All</h3>` : '') + (l.length ? `<div class="list">${l.slice(0, 200).map(item).join('')}</div>` : `<div class="empty">No matches. <button class="btn ghost" data-act="newCustomEx" data-q="${esc(st.q)}">Create “${esc(st.q)}”</button></div>`);
  };
  const def = {
    title: opts.single ? 'Choose exercise' : 'Add exercises', picker: st,
    right: { label: 'Add', fn: () => { if (!st.sel.length) return toast('Select at least one'); const s = [...st.sel]; closeSheet(); onPick(s); } },
    render: () => `<div class="search" style="background:var(--bg2)"><input class="input" type="search" placeholder="Search" data-oninput="pickQ" value="${esc(st.q)}" autocomplete="off"></div>${muscleChips(st.muscle, 'pickMuscle')}<div id="picklist">${rows()}</div>`,
    rows, single: !!opts.single, onPick
  };
  openSheet(def);
}

/* ---------- Routine editor ---------- */
function routineSheet(id) {
  openSheet({
    title: 'Routine', right: { label: 'Done', fn: () => closeSheet() },
    onClose: () => render(),
    render: () => {
      const r = S.routines.find((x) => x.id === id); if (!r) return '<div class="empty">Deleted.</div>';
      const b = routineBlock(r), sch = SCHEMES.find((x) => x.id === b.scheme) || SCHEMES[0];
      const mains = r.items.filter((i) => !isMob(i.exId)).length;
      let h = `<div class="field"><label>Name</label><input class="input" data-on="rName" data-id="${id}" value="${esc(r.name)}"></div>`;
      h += `<div class="field"><label>Progression</label><div class="seg">${Object.entries(PROG).map(([k, v]) => `<button class="${r.prog === k ? 'on' : ''}" data-act="rProg" data-id="${id}" data-v="${k}">${v.replace(' progression', '')}</button>`).join('')}</div><div class="tiny muted">${PROG_HELP[r.prog]}</div></div>`;
      const weeks = Math.floor((Date.now() - b.start) / (7 * DAY));
      h += `<div class="card block-card small"><div class="row between"><b>Block ${b.n} · ${sch.name}</b><span class="muted">week ${weeks + 1}${details().rotate && !r.noRotate ? ` of ${details().rotateWeeks}` : ''}</span></div><div class="muted mt">${r.noRotate ? 'Automatic rotation is off for this routine.' : details().rotate ? 'Forge will suggest fresh variations when this block ends.' : 'Rotation is off in your profile.'}</div><div class="row wrap mt"><button class="btn sm" data-act="rotNow" data-id="${id}">Rotate exercises now</button>${(r.history || []).length ? `<button class="btn sm" data-act="rotUndo" data-id="${id}">Undo last rotation</button>` : ''}${r.noRotate ? `<button class="btn sm" data-act="rotEnable" data-id="${id}">Turn rotation on</button>` : ''}</div></div>`;
      let lastPhase = null;
      r.items.forEach((it, i) => {
        const ex = getEx(it.exId), t = ex.type, mob = t === 'mobility', phase = it.phase || (mob ? 'warmup' : 'main');
        if (phase !== lastPhase) { h += `<div class="phase ${phase === 'warmup' ? 'warm' : phase === 'cooldown' ? 'cool' : ''}">${phase === 'warmup' ? `${ico('sun', 'xs')} Warm-up` : phase === 'cooldown' ? `${ico('snow', 'xs')} Cool-down` : `${ico('dumbbell', 'xs')} Exercises (${mains})`}</div>`; lastPhase = phase; }
        const f = (k, l, v, mode = 'numeric', ph = '') => `<div class="field mb0"><label class="tiny">${l}</label><input class="input" style="padding:8px" inputmode="${mode}" data-on="rItem" data-id="${id}" data-i="${i}" data-k="${k}" value="${v ?? ''}" placeholder="${ph}"></div>`;
        h += `<div class="card" style="${it.ss ? 'border-left:3px solid var(--accent);margin-bottom:3px' : (i > 0 && r.items[i - 1].ss ? 'border-left:3px solid var(--accent)' : '')}${mob ? ';padding:10px 14px' : ''}"><div class="row">${thumb(ex, 'sm')}<div class="grow" style="min-width:0"><b>${esc(ex.name)}</b><div class="tiny muted">${MUSCLES[ex.muscle] || ''}${mob ? ` · ${it.time || 30}s` : ''}${it.tech ? ` · <span class="accent">${TECH[it.tech].name} on last set</span>` : ''}</div></div><div class="reorder"><button data-act="rMove" data-id="${id}" data-i="${i}" data-d="-1">▲</button><button data-act="rMove" data-id="${id}" data-i="${i}" data-d="1">▼</button></div><button class="iconbtn" style="color:var(--bad)" data-act="rRemove" data-id="${id}" data-i="${i}">✕</button></div>`;
        if (mob) { h += `<div class="grid2 mt" style="gap:6px">${f('time', 'Seconds', it.time)}<div class="field mb0"><label class="tiny">Phase</label><select class="input" style="padding:8px" data-on="rItem" data-id="${id}" data-i="${i}" data-k="phase"><option value="warmup" ${phase === 'warmup' ? 'selected' : ''}>Warm-up</option><option value="cooldown" ${phase === 'cooldown' ? 'selected' : ''}>Cool-down</option></select></div></div></div>`; return; }
        h += `<div class="grid3 mt" style="grid-template-columns:repeat(${t === 'cardio' ? 2 : 4},1fr);gap:6px">`;
        h += f('sets', 'Sets', it.sets);
        if (t === 'timed') h += f('time', 'Hold (s)', it.time);
        else if (t === 'cardio') h += f('time', 'Seconds', it.time);
        else { h += f('repMin', 'Reps min', it.repMin); h += f('repMax', 'Reps max', it.repMax); }
        if (t === 'weight' || t === 'assisted') h += f('inc', `+${U()}`, it.inc != null ? num(toU(it.inc), 2) : num(toU(defaultInc(ex)), 2), 'decimal');
        else if (t !== 'cardio') h += f('rest', 'Rest (s)', it.rest, 'numeric', S.settings.rest);
        h += `</div><div class="grid2 mt" style="gap:6px">`;
        if (t === 'weight' || t === 'assisted') h += f('rest', 'Rest (s)', it.rest, 'numeric', S.settings.rest);
        if (isDB(ex)) h += `<div class="field mb0"><label class="tiny">Dumbbell style</label><select class="input" style="padding:8px" data-on="rItem" data-id="${id}" data-i="${i}" data-k="dbMode">${Object.entries(DB_MODES).map(([k, m]) => `<option value="${k}" ${(it.dbMode || DB_DEFAULT[ex.name] || 'both') === k ? 'selected' : ''}>${m.label}</option>`).join('')}</select></div>`;
        if (t === 'weight' || t === 'bodyweight') h += `<div class="field mb0"><label class="tiny">Last-set technique</label><select class="input" style="padding:8px" data-on="rItem" data-id="${id}" data-i="${i}" data-k="tech"><option value="">None</option>${Object.entries(TECH).map(([k, v]) => `<option value="${k}" ${it.tech === k ? 'selected' : ''}>${v.name}</option>`).join('')}</select></div>`;
        if (t === 'weight') h += `<div class="field mb0"><label class="tiny">Progression</label><select class="input" style="padding:8px" data-on="rItem" data-id="${id}" data-i="${i}" data-k="prog"><option value="routine">Routine default</option>${Object.entries(PROG).filter(([k]) => k !== 'time').map(([k, v]) => `<option value="${k}" ${it.prog === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`;
        h += `</div>`;
        if (i < r.items.length - 1 && !isMob(r.items[i + 1].exId)) h += `<label class="row small mt" style="justify-content:space-between">Superset with next exercise<span class="switch"><input type="checkbox" data-on="rSS" data-id="${id}" data-i="${i}" ${it.ss ? 'checked' : ''}><span></span></span></label>`;
        h += `</div>`;
      });
      h += `<button class="btn primary block" data-act="rAddEx" data-id="${id}">+ Add exercises</button>`;
      if (!r.items.some((i) => i.phase === 'warmup') || !r.items.some((i) => i.phase === 'cooldown')) h += `<button class="btn block mt" data-act="rWarmCool" data-id="${id}">+ Add warm-up & cool-down</button>`;
      h += `<h3>Schedule</h3><div class="chips">${[0, 1, 2, 3, 4, 5, 6].map((i) => (i + S.settings.weekStart) % 7).map((d) => `<button class="chip ${S.plan.days[d] === id ? 'on' : ''}" data-act="rDay" data-id="${id}" data-d="${d}">${DOW[d]}</button>`).join('')}</div>`;
      h += `<div class="grid2 mt"><button class="btn" data-act="startRoutine" data-id="${id}">Start now</button><button class="btn" data-act="dupRoutine" data-id="${id}">Duplicate</button></div><button class="btn danger block mt" data-act="delRoutine" data-id="${id}">Delete routine</button>`;
      return h;
    }
  });
}

/* ---------- Settings ---------- */
function settingsSheet() {
  openSheet({
    title: 'Settings',
    onClose: () => render(),
    render: () => {
      const s = S.settings;
      const seg = (key, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${String(s[key]) === String(v) ? 'on' : ''}" data-act="setOpt" data-k="${key}" data-v="${v}">${l}</button>`).join('')}</div>`;
      const sw = (key, label, sub = '') => `<label class="list-item" style="justify-content:space-between"><div><div>${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div><span class="switch"><input type="checkbox" data-on="setBool" data-k="${key}" ${s[key] ? 'checked' : ''}><span></span></span></label>`;
      const accents = ['#ff5a1f', '#ff375f', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#0a84ff', '#bf5af2'];
      let h = `<button class="card row" style="width:100%;border:0;text-align:left" data-act="profileMenu">${avatar(me())}<div class="grow"><b>${esc(me().name)}</b><div class="small muted">Profile, PIN, send to another device</div></div><span class="chev faint">›</span></button>`;
      h += `<h3>Text size</h3><div class="card"><div class="seg">${[['m', 'A', 'Normal'], ['l', 'A', 'Large'], ['xl', 'A', 'Larger'], ['xxl', 'A', 'Largest']].map(([k, , l], i) => `<button class="${s.textSize === k ? 'on' : ''}" data-act="setOpt" data-k="textSize" data-v="${k}" style="font-size:${0.8 + i * 0.12}rem">${l}</button>`).join('')}</div></div>`;
      h += `<h3>Units & equipment</h3><div class="card"><div class="field"><label>Weight unit</label>${seg('unit', [['kg', 'Kilograms'], ['lb', 'Pounds']])}</div><div class="grid2"><div class="field"><label>Bar weight (${U()})</label><input class="input" inputmode="decimal" data-on="setNum" data-k="bar" value="${s.bar}"></div><div class="field"><label>Default rest (s)</label><input class="input" inputmode="numeric" data-on="setNum" data-k="rest" value="${s.rest}"></div></div><div class="field mb0"><label>Plates you have (${U()}, comma separated)</label><input class="input" data-on="setPlates" value="${s.plates.join(', ')}"></div></div>`;
      h += `<div class="card"><div class="small muted" style="margin-bottom:8px">Equipment you own (used by the Library's “My gear” filter)</div><div class="row wrap" style="gap:6px">${Object.entries(EQUIPMENT).filter(([k]) => !['bodyweight', 'other'].includes(k)).map(([k, v]) => `<button class="chip ${s.owned.includes(k) ? 'on' : ''}" data-act="toggleOwned" data-v="${k}">${v}</button>`).join('')}</div></div>`;
      h += `<h3>Training</h3><div class="card"><div class="field"><label>Effort tracking per set</label>${seg('effort', [['off', 'Off'], ['rpe', 'RPE'], ['rir', 'RIR']])}<div class="tiny faint">RPE 10 = failure; RIR = reps left in the tank. Each set keeps the scale it was logged in.</div></div><div class="field mb0"><label>Week starts on</label>${seg('weekStart', [[1, 'Monday'], [0, 'Sunday']])}</div></div>`;
      h += `<div class="list">${sw('sound', 'Rest timer sound', 'Plays when the app is open. iPhone silent mode mutes it.')}${sw('keepAwake', 'Keep screen awake during workouts')}</div>`;
      h += `<h3>Appearance</h3><div class="card"><div class="field">${seg('theme', [['dark', 'Dark'], ['light', 'Light'], ['auto', 'Auto']])}</div><div class="swatches">${accents.map((c) => `<button class="swatch ${s.accent === c ? 'on' : ''}" style="background:${c}" data-act="setOpt" data-k="accent" data-v="${c}" aria-label="${c}"></button>`).join('')}<label class="swatch ${accents.includes(s.accent) ? '' : 'on'}" style="background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);position:relative;overflow:hidden"><input type="color" data-on="setAccent" value="${s.accent}" style="opacity:0;position:absolute;inset:0"></label></div></div>`;
      h += `<h3>Your data</h3><div class="card small"><div id="storage-info" class="muted">Checking storage…</div><div class="muted mt">Everything is stored only on this device, inside this app. Deleting the app from your Home Screen deletes the data — back up regularly.</div></div>`;
      h += `<div class="list"><button class="list-item" data-act="exportJSON"><div class="grow"><div>Back up (JSON)</div><div class="sub">${S.meta.lastBackup ? 'Last: ' + relDay(S.meta.lastBackup) : 'Never backed up'}</div></div><span class="chev">›</span></button><button class="list-item" data-act="importJSON"><div class="grow"><div>Restore / merge backup</div><div class="sub">Merges — never overwrites existing workouts</div></div><span class="chev">›</span></button><button class="list-item" data-act="exportCSV"><div class="grow">Export workouts (CSV)</div><span class="chev">›</span></button><button class="list-item" data-act="importCSV"><div class="grow"><div>Import from Strong, Hevy or FitNotes</div><div class="sub">CSV export from those apps</div></div><span class="chev">›</span></button><button class="list-item" data-act="persist"><div class="grow">Ask the browser to protect storage</div><span class="chev">›</span></button><button class="list-item" data-act="cacheImages"><div class="grow"><div>Save all exercise photos for offline</div><div class="sub">~4 MB. Photos you open are saved automatically</div></div><span class="chev">›</span></button></div>`;
      h += `<div class="list"><button class="list-item" data-act="loadDemo"><div class="grow"><div>Load demo data</div><div class="sub">10 weeks of sample training to explore the app</div></div></button><button class="list-item" data-act="eraseAll"><div class="grow bad">Erase this profile's data</div></button></div>`;
      h += `<p class="tiny faint center">Forge v1.0 · no account, no tracking, no network calls.<br>Inspired by openGym.</p>`;
      return h;
    },
    after: async () => {
      const el = $('#storage-info'); if (!el) return;
      let txt = `${S.workouts.length} workouts · ${S.body.length} weigh-ins · ${S.custom.length} custom exercises.`;
      try {
        if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); txt += ` Using ${num((e.usage || 0) / 1048576, 1)} MB.`; }
        if (navigator.storage?.persisted) txt += (await navigator.storage.persisted()) ? ' Storage is protected ✓' : '';
      } catch (e) { /* ignore */ }
      if (standalone()) txt += ' Installed as app ✓';
      el.textContent = txt;
    }
  });
}

function customExSheet(id, presetName = '') {
  const ex = id ? { ...getEx(id) } : { id: null, name: presetName, muscle: 'chest', secondary: [], equipment: 'barbell', type: 'weight', notes: '', link: '' };
  const st = { ex };
  openSheet({
    title: id ? 'Edit exercise' : 'New exercise', st,
    right: { label: 'Save', fn: () => {
      const e = st.ex; if (!e.name.trim()) return toast('Name required');
      e.name = e.name.trim();
      if (e.id) { const i = S.custom.findIndex((c) => c.id === e.id); S.custom[i] = { ...e }; delete S.custom[i].custom; }
      else { e.id = 'c:' + uid(); const c = { ...e }; delete c.custom; S.custom.push(c); }
      save('custom'); buildEx(); closeSheet(); refreshSheet(); render(); toast('Saved');
      const top = sheets[sheets.length - 1]; if (top && top.picker && !top.picker.sel.includes(e.id)) { top.picker.sel.push(e.id); refreshSheet(); }
    } },
    render: () => {
      const e = st.ex;
      const opts = (o, v) => Object.entries(o).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('');
      return `<div class="field"><label>Name</label><input class="input" data-on="cx" data-k="name" value="${esc(e.name)}"></div>
        <div class="grid2"><div class="field"><label>Primary muscle</label><select class="input" data-on="cx" data-k="muscle">${opts(MUSCLES, e.muscle)}</select></div><div class="field"><label>Equipment</label><select class="input" data-on="cx" data-k="equipment">${opts(EQUIPMENT, e.equipment)}</select></div></div>
        <div class="field"><label>How it's logged</label><select class="input" data-on="cx" data-k="type">${opts(TYPES, e.type)}</select></div>
        <div class="field"><label>Secondary muscles</label><div class="row wrap" style="gap:6px">${Object.entries(MUSCLES).filter(([k]) => k !== e.muscle).map(([k, v]) => `<button class="chip ${e.secondary.includes(k) ? 'on' : ''}" data-act="cxSec" data-v="${k}">${v}</button>`).join('')}</div></div>
        <div class="field"><label>Notes / cues</label><textarea class="input" data-on="cx" data-k="notes">${esc(e.notes || '')}</textarea></div>
        <div class="field"><label>Guide link (optional)</label><input class="input" type="url" data-on="cx" data-k="link" value="${esc(e.link || '')}" placeholder="https://"></div>
        ${id ? `<button class="btn danger block" data-act="delCustom" data-id="${id}">Delete exercise</button>` : ''}`;
    }
  });
}

function plateSheet(kg) {
  const st = { w: kg != null ? toU(kg) : null };
  const colors = ['#e53935', '#1e63d6', '#f2c200', '#2e9e48', '#eaeaea', '#c62828', '#9e9e9e', '#6d4c41', '#7b1fa2'];
  openSheet({
    title: 'Plate calculator', st,
    render: () => {
      const s = S.settings, plates = [...s.plates].sort((a, b) => b - a);
      let h = `<div class="grid2"><div class="field"><label>Target (${U()})</label><input class="input" inputmode="decimal" data-oninput="plateW" value="${st.w != null ? num(st.w, 2) : ''}" placeholder="e.g. ${isLb() ? 225 : 100}"></div><div class="field"><label>Bar (${U()})</label><input class="input" inputmode="decimal" data-on="setNum" data-k="bar" value="${s.bar}"></div></div><div id="plate-out">${plateOut(st.w, plates, colors)}</div>`;
      return h;
    },
    plates: colors
  });
}
function plateOut(w, plates, colors) {
  const bar = S.settings.bar;
  if (!(w > 0)) return `<div class="empty small">Enter a weight.</div>`;
  if (w < bar) return `<div class="empty small">That's less than the bar (${bar} ${U()}).</div>`;
  let per = (w - bar) / 2; const used = [];
  for (const p of plates) while (per >= p - 1e-6) { used.push(p); per -= p; }
  const max = Math.max(...plates);
  const vis = used.map((p) => { const i = plates.indexOf(p); return `<div class="p" style="background:${colors[i % colors.length]};height:${36 + 54 * p / max}px;width:${p >= max * 0.4 ? 16 : 10}px;${colors[i % colors.length] === '#eaeaea' ? 'color:#333' : ''}">${num(p, 2)}</div>`; }).join('');
  return `<div class="plates"><div class="bar"></div><div class="sleeve"></div>${vis}</div><div class="center"><b>Each side:</b> ${used.length ? used.map((p) => num(p, 2)).join(' + ') : 'nothing — just the bar'}</div>${per > 1e-6 ? `<div class="center small bad mt">Can't make the last ${num(per * 2, 2)} ${U()} with your plates. Loaded: ${num(w - per * 2, 2)} ${U()}</div>` : ''}<div class="tiny faint center mt">Bar ${bar} ${U()} · edit available plates in Settings</div>`;
}
function oneRmSheet() {
  const st = { w: null, r: null };
  openSheet({
    title: '1RM calculator', st,
    render: () => `<div class="grid2"><div class="field"><label>Weight (${U()})</label><input class="input" inputmode="decimal" data-oninput="ormW" value="${st.w ?? ''}"></div><div class="field"><label>Reps</label><input class="input" inputmode="numeric" data-oninput="ormR" value="${st.r ?? ''}"></div></div><div id="orm-out">${ormOut(st)}</div>`
  });
}
function ormOut(st) {
  if (!(st.w > 0 && st.r >= 1)) return `<div class="empty small">Enter a set you did.</div>`;
  if (st.r > 12) return `<div class="empty small">Estimates above 12 reps are unreliable.</div>`;
  const epley = st.r === 1 ? st.w : st.w * (1 + st.r / 30), brz = st.r === 1 ? st.w : st.w * 36 / (37 - st.r);
  const e = (epley + brz) / 2;
  return `<div class="center"><div class="muted small">Estimated 1RM</div><div class="timerbig" style="font-size:52px">${num(e, 1)}</div><div class="tiny faint">Epley ${num(epley, 1)} · Brzycki ${num(brz, 1)}</div></div><div class="card mt"><div class="grid3">${[95, 90, 85, 80, 75, 70, 65, 60, 50].map((p) => `<div><div class="tiny muted">${p}%</div><b>${num(e * p / 100, 1)}</b></div>`).join('')}</div></div>`;
}

function bwSheet(id) {
  const ex = id ? S.body.find((b) => b.id === id) : null;
  const st = { v: ex ? num(toU(ex.kg), 2) : (latestBW() ? num(toU(latestBW()), 1) : ''), d: dkey(ex ? ex.date : Date.now()) };
  openSheet({
    title: ex ? 'Edit weigh-in' : 'Log body weight', st,
    right: { label: 'Save', fn: () => {
      const v = pnum(st.v); if (!(v > 0)) return toast('Enter a weight');
      const date = parseKey(st.d).getTime() + 12 * 3600e3;
      if (ex) { ex.kg = fromU(v); ex.date = date; } else S.body.push({ id: uid(), date, kg: fromU(v) });
      save('body'); closeSheet(); render(); toast('Saved');
    } },
    render: () => `<div class="field"><label>Weight (${U()})</label><input class="input" inputmode="decimal" data-oninput="stv" value="${esc(st.v)}" style="font-size:28px;font-weight:700;text-align:center"></div><div class="field"><label>Date</label><input class="input" type="date" data-oninput="std" value="${st.d}"></div>${ex ? `<button class="btn danger block" data-act="delBW" data-id="${ex.id}">Delete</button>` : ''}<p class="tiny faint">Tip: weigh yourself at the same time each day — first thing in the morning is most consistent.</p>`
  });
}
function measureSheet(id) {
  const ex = id ? S.measures.find((m) => m.id === id) : null;
  const st = { d: dkey(ex ? ex.date : Date.now()), v: {} };
  const MS = measureFields(), conv = (k, v, to) => (k === 'bodyfat' || v == null ? v : isLb() ? (to ? v / 2.54 : v * 2.54) : v);
  if (ex) MS.forEach(([k]) => { st.v[k] = ex[k] != null ? num(conv(k, ex[k], true), 1) : ''; });
  openSheet({
    title: 'Measurements', st,
    right: { label: 'Save', fn: () => {
      const m = ex || { id: uid() }; m.date = parseKey(st.d).getTime() + 12 * 3600e3;
      MS.forEach(([k]) => { const v = pnum(st.v[k]); m[k] = v == null ? null : conv(k, v, false); });
      if (!ex) S.measures.push(m);
      save('measures'); closeSheet(); render();
    } },
    render: () => `<div class="field"><label>Date</label><input class="input" type="date" data-oninput="msd" value="${st.d}"></div><div class="grid2">${MS.map(([k, l, u]) => `<div class="field"><label>${l} (${u})</label><input class="input" inputmode="decimal" data-oninput="msv" data-k="${k}" value="${esc(st.v[k] ?? '')}"></div>`).join('')}</div>${ex ? `<button class="btn danger block" data-act="delMeasure" data-id="${ex.id}">Delete</button>` : ''}`
  });
}
function holdTimerSheet(ei, si) {
  const e = S.active.entries[ei], s = e.sets[si];
  const target = s.t || e.sg?.t || 30;
  holdTimer = { ei, si, target, start: null, ready: Date.now() + 3000, beeped: false };
  openSheet({
    title: getEx(e.exId).name,
    onClose: () => { holdTimer = null; },
    render: () => `<div class="center muted">Target ${target}s</div><div class="timerbig" id="hold-t">3</div><div class="center small muted" id="hold-l">Get ready…</div><button class="btn primary block mt" data-act="holdStop">Done</button>`
  });
}

/* ======================= Workout actions ======================= */
function makeEntry(exId, item, prog, ss, past) {
  const ex = getEx(exId), sg = suggest(exId, item, prog, S.active?.origId);
  const prev = ex.type === 'mobility' ? [] : entriesFor(exId, { exclude: S.active?.origId })[0]?.e.sets.filter((s) => isWork(s) && s.tech !== 'drop') || [];
  const sets = [];
  const noReps = ['timed', 'cardio', 'mobility'].includes(ex.type);
  for (let i = 0; i < sg.sets; i++) {
    const p = prev[i];
    sets.push({ id: uid(), w: ex.type === 'mobility' ? null : sg.w, r: noReps ? null : sg.r, t: ex.type === 'cardio' ? (p?.t ?? sg.t) : sg.t, d: ex.type === 'cardio' ? (p?.d ?? sg.d) : null, eff: null, warm: false, done: !!past });
  }
  const tech = item && item.tech && TECH[item.tech] ? item.tech : null;
  if (tech && sets.length) {
    const last = sets[sets.length - 1];
    if (tech === 'drop') {
      for (const f of [0.8, 0.64]) sets.push({ ...last, id: uid(), w: last.w ? roundPlate(last.w * f, ex.equipment) : null, r: null, tech: 'drop' });
    } else last.tech = tech;
  }
  const phase = item && item.phase ? item.phase : (ex.type === 'mobility' ? 'warmup' : 'main');
  return { id: uid(), exId, ss: ss || null, phase, dbMode: dbModeFor(exId, item), item: item ? { ...item } : null, prog, sg: { src: sg.src, w: sg.w, r: sg.r, t: sg.t }, prev: prev.map((s) => ({ w: s.w, r: s.r, t: s.t, d: s.d })), sets, note: '' };
}
function startWorkout(routineId, opts = {}) {
  if (S.active) { toast('Finish or discard the current workout first'); closeAllSheets(); go('workout'); return; }
  const r = S.routines.find((x) => x.id === routineId);
  if (r && !opts.noRotateCheck && !opts.past && rotationDue(r)) { closeAllSheets(); rotationSheet(r.id, true); return; }
  const a = { id: uid(), start: opts.start || Date.now(), end: null, routineId: r ? r.id : null, name: opts.name || (r ? r.name : 'Workout'), notes: '', entries: [], editing: !!opts.past };
  if (opts.past) a.end = a.start + 60 * 6e4;
  S.active = a;
  if (r) {
    let g = null;
    r.items.forEach((it, i) => {
      const linkedPrev = i > 0 && r.items[i - 1].ss;
      if (it.ss || linkedPrev) { if (!linkedPrev) g = uid(); } else g = null;
      a.entries.push(makeEntry(it.exId, it, r.prog, (it.ss || linkedPrev) ? g : null, opts.past));
    });
  }
  if (opts.from) {
    opts.from.entries.forEach((e) => {
      const en = makeEntry(e.exId, { sets: e.sets.filter((s) => !s.warm && s.tech !== 'drop').length || 1, phase: e.phase }, 'none', e.ss, opts.past);
      a.entries.push(en);
    });
  }
  save('active'); closeAllSheets(); go('workout'); requestWake(); startTick();
}
function addExercisesToActive(ids) {
  const routine = S.routines.find((r) => r.id === S.active.routineId);
  const E = S.active.entries, anyMainDone = E.some((e) => !isMob(e.exId) && e.sets.some((s) => s.done));
  for (const id of ids) {
    const ex = getEx(id);
    if (ex.type === 'mobility') {
      const phase = anyMainDone ? 'cooldown' : 'warmup';
      const en = makeEntry(id, { sets: 1, time: 30, phase }, 'none', null, S.active.editing);
      if (phase === 'warmup') { const i = E.findIndex((e) => (e.phase || 'main') !== 'warmup'); E.splice(i < 0 ? E.length : i, 0, en); } else E.push(en);
    } else {
      const en = makeEntry(id, { sets: ex.type === 'cardio' ? 1 : 3, repMin: 8, repMax: 12, time: 30, phase: 'main' }, routine ? routine.prog : 'double', null, S.active.editing);
      const i = E.findIndex((e) => e.phase === 'cooldown'); E.splice(i < 0 ? E.length : i, 0, en);
    }
  }
  save('active'); render();
}
function startRest(ei, si) {
  const a = S.active, e = a.entries[ei], s = e.sets[si];
  // Intensity techniques: keep going (drop set) or take a short pause (rest-pause / myo-reps).
  const nextSet = e.sets.slice(si + 1).find((x) => !x.done);
  if (nextSet && nextSet.tech === 'drop') { toast('↓ Drop set: strip ~20% and go — no rest!', 2600); a.rest = null; save('active'); return; }
  const next = a.entries[ei + 1];
  if (e.ss && next && next.ss === e.ss) { toast(`Superset → ${getEx(next.exId).name}`); return; }
  let secs = s.warm ? 60 : (e.item?.rest || S.settings.rest);
  if (isMob(e.exId)) secs = 10;
  if (nextSet && nextSet.tech === 'rp') secs = 20;
  if (nextSet && nextSet.tech === 'myo') secs = 15;
  let label = '';
  for (let i = ei; i < a.entries.length && !label; i++) {
    const en = a.entries[i]; const idx = en.sets.findIndex((x) => !x.done);
    if (idx >= 0) label = `${getEx(en.exId).name} · set ${idx + 1}${en.sets[idx].tech ? ' (' + TECH[en.sets[idx].tech].name + ')' : ''}`;
  }
  if (e.ss) {
    const first = a.entries.findIndex((x) => x.ss === e.ss);
    const en = a.entries[first], idx = en.sets.findIndex((x) => !x.done);
    if (idx >= 0) label = `${getEx(en.exId).name} · set ${idx + 1}`;
  }
  a.rest = { end: Date.now() + secs * 1000, total: secs, label, beeped: false };
  save('active');
}
function renderRest() {
  const el = $('#restbar'), v = $('#view');
  const r = S.active && S.active.rest;
  if (!r || S.active.editing) { el.hidden = true; v.classList.remove('with-rest'); return; }
  const left = (r.end - Date.now()) / 1000;
  if (left < -180) { S.active.rest = null; save('active'); el.hidden = true; v.classList.remove('with-rest'); return; }
  if (el.hidden || !el.querySelector('.t')) {
    el.innerHTML = `<div class="t"></div><div class="grow" style="min-width:0"><div class="small" id="rest-h">Rest</div><div class="tiny muted ellipsis" id="rest-l"></div></div><button class="btn sm" data-act="restAdj" data-v="-15">−15</button><button class="btn sm" data-act="restAdj" data-v="15">+15</button><button class="btn sm primary" data-act="restSkip">Skip</button><div class="prog"></div>`;
    el.hidden = false; v.classList.add('with-rest');
  }
  el.classList.toggle('over', left <= 0);
  el.querySelector('.t').textContent = left > 0 ? fmtClock(left) : '+' + fmtClock(-left);
  $('#rest-h').textContent = left > 0 ? 'Rest' : 'Go!';
  $('#rest-l').textContent = r.label ? 'Next: ' + r.label : '';
  el.querySelector('.prog').style.width = `${Math.max(0, Math.min(100, left / r.total * 100))}%`;
  if (left <= 0 && !r.beeped) { r.beeped = true; beep(3); save('active'); }
  else if (left > 0 && left <= 3.2 && !r.warned) { r.warned = true; beep(1, 660); }
}
function tick() {
  if (S.active && !S.active.editing) document.querySelectorAll('[data-elapsed]').forEach((n) => { n.textContent = fmtClock(wDur(S.active) / 1000); });
  renderRest();
  if (holdTimer) {
    const tEl = $('#hold-t'), lEl = $('#hold-l'); if (!tEl) return;
    const now = Date.now();
    if (now < holdTimer.ready) { tEl.textContent = Math.ceil((holdTimer.ready - now) / 1000); return; }
    if (!holdTimer.start) { holdTimer.start = holdTimer.ready; beep(1, 990); }
    const el = (now - holdTimer.start) / 1000;
    tEl.textContent = Math.floor(el) + 's';
    lEl.textContent = el >= holdTimer.target ? 'Target reached — keep going or stop' : `${Math.ceil(holdTimer.target - el)}s to target`;
    if (el >= holdTimer.target && !holdTimer.beeped) { holdTimer.beeped = true; beep(2); }
  }
}
function startTick() { if (!tickTimer) tickTimer = setInterval(tick, 250); }

function commitWorkout() {
  const a = S.active;
  const w = { id: a.origId || a.id, start: a.start, end: a.editing ? a.end : Date.now(), routineId: a.routineId, name: a.name.trim() || 'Workout', notes: a.notes || '', entries: [] };
  w.entries = a.entries.map((e) => ({ id: e.id, exId: e.exId, ss: e.ss, note: e.note || '', phase: e.phase, dbMode: e.dbMode || undefined, sets: e.sets.filter((s) => s.done).map((s) => { const c = { ...s }; delete c.ts; return c; }) })).filter((e) => e.sets.length);
  if (a.origId) { const i = S.workouts.findIndex((x) => x.id === a.origId); if (i >= 0) S.workouts[i] = w; else S.workouts.push(w); }
  else S.workouts.push(w);
  sortW();
  S.active = null; holdTimer = null;
  save('workouts', 'active'); releaseWake(); closeAllSheets();
  return w;
}
function summarySheet(w) {
  const prs = workoutPRs(w);
  const prevSame = S.workouts.find((x) => x.id !== w.id && x.start < w.start && (w.routineId ? x.routineId === w.routineId : x.name === w.name));
  render();
  const vol = wVolume(w), dv = prevSame && wVolume(prevSame) ? (vol / wVolume(prevSame) - 1) * 100 : null;
  openSheet({
    title: 'Workout saved', cancel: 'Done', onClose: () => render(),
    after: () => { if (prs.length && !summarySheet._fired) { summarySheet._fired = true; setTimeout(confetti, 150); setTimeout(() => { summarySheet._fired = false; }, 2000); } },
    render: () => `<div class="center"><div class="celebrate">${ico(prs.length ? 'trophy' : 'lift', 'hero-ic')}</div><div class="big">${esc(w.name)}</div><div class="muted">${fmtDate(w.start, { weekday: 'long', day: 'numeric', month: 'long' })}</div></div>
      <div class="grid3 mt"><div class="stat"><div class="v" style="font-size:18px">${fmtDur(wDur(w))}</div><div class="l">Duration</div></div><div class="stat"><div class="v" style="font-size:18px">${fmtVol(vol)}</div><div class="l">Volume${dv != null ? ` <span class="${dv >= 0 ? 'good' : 'bad'}">${dv >= 0 ? '+' : ''}${num(dv, 0)}%</span>` : ''}</div></div><div class="stat"><div class="v" style="font-size:18px">${wSets(w)}</div><div class="l">Sets</div></div></div>
      ${prs.length ? `<h3>Personal records</h3><div class="list">${prs.map((p) => `<div class="list-item"><div class="grow">${esc(getEx(p.exId).name)}<div class="sub">${setStr(getEx(p.exId), p.set)}</div></div><span class="tag pr">${p.tags.join(' · ')}</span></div>`).join('')}</div>` : ''}
      <button class="btn block mt" data-act="shareWorkout" data-id="${w.id}">Share summary</button>`
  });
}
function workoutText(w) {
  let t = `${w.name} — ${fmtDate(w.start, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}\n${fmtDur(wDur(w))} · ${fmtVol(wVolume(w))} · ${wSets(w)} sets\n\n`;
  for (const e of w.entries) { const ex = getEx(e.exId); t += `${ex.name}\n  ${e.sets.filter(isWork).map((s) => setStr(ex, s)).join(', ')}\n`; }
  const prs = workoutPRs(w); if (prs.length) t += `\n🏆 PRs: ${prs.map((p) => getEx(p.exId).name).join(', ')}\n`;
  return t;
}
function warmups(e) {
  const ex = getEx(e.exId), first = e.sets.find((s) => !s.warm);
  const W = first && first.w; if (!(W > 0)) { toast('Enter a working weight first'); return; }
  const barKg = fromU(S.settings.bar), isBar = ['barbell', 'trapbar', 'ezbar'].includes(ex.equipment);
  const scheme = isBar ? [[0, 10], [0.4, 5], [0.6, 3], [0.8, 2]] : [[0.5, 10], [0.75, 5]];
  const ws = [];
  for (const [p, r] of scheme) {
    const w = p === 0 ? barKg : roundPlate(W * p, ex.equipment);
    if (w >= W - 0.01 || (isBar && p > 0 && w <= barKg + 0.01)) continue;
    ws.push({ id: uid(), w, r, t: null, d: null, eff: null, warm: true, done: false });
  }
  e.sets = e.sets.filter((s) => !(s.warm && !s.done));
  const firstWork = e.sets.findIndex((s) => !s.warm);
  e.sets.splice(firstWork < 0 ? e.sets.length : firstWork, 0, ...ws);
  save('active'); render(); toast(`Added ${ws.length} warm-up sets`);
}

/* ======================= Import / export ======================= */
function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const file = new File([blob], name, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && isIOS) {
    return navigator.share({ files: [file], title: name }).then(() => true).catch((e) => e && e.name === 'AbortError' ? false : fallback());
  }
  return Promise.resolve(fallback());
  function fallback() {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); return true;
  }
}
function pickFile(accept) {
  return new Promise((res) => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept;
    i.onchange = () => { const f = i.files[0]; if (!f) return res(null); const r = new FileReader(); r.onload = () => res(r.result); r.readAsText(f); };
    i.click();
  });
}
function exportData() { const o = { app: 'forge', version: 2, exported: Date.now(), profile: me() }; KEYS.forEach((k) => { if (k !== 'active') o[k] = S[k]; }); return JSON.stringify(o, null, 1); }
function mergeData(o) {
  if (!o || (o.app !== 'forge' && !o.workouts)) throw new Error('Not a Forge backup');
  o = sanitizeData(o);
  const mergeArr = (key) => { if (!Array.isArray(o[key])) return 0; const ids = new Map(S[key].map((x, i) => [x.id, i])); let n = 0; for (const x of o[key]) { if (!x || !x.id) continue; if (ids.has(x.id)) S[key][ids.get(x.id)] = x; else { S[key].push(x); n++; } } return n; };
  const n = mergeArr('workouts'); mergeArr('routines'); mergeArr('custom'); mergeArr('body'); mergeArr('measures'); mergeArr('scans');
  if (o.plan) { S.plan.days = { ...o.plan.days, ...S.plan.days }; S.plan.overrides = { ...o.plan.overrides, ...S.plan.overrides }; }
  if (o.settings && !S.workouts.length) S.settings = { ...DEFAULTS, ...o.settings };
  sortW(); buildEx(); save('workouts', 'routines', 'custom', 'body', 'measures', 'plan', 'settings', 'scans');
  return n;
}
function csvParse(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = text.replace(/^﻿/, '');
  const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}
const ALIASES = { 'squat': 'Back Squat', 'squat (barbell)': 'Back Squat', 'barbell squat': 'Back Squat', 'bench press (barbell)': 'Bench Press', 'flat barbell bench press': 'Bench Press', 'deadlift (barbell)': 'Deadlift', 'conventional deadlift': 'Deadlift', 'overhead press (barbell)': 'Overhead Press', 'military press': 'Overhead Press', 'strict press': 'Overhead Press', 'bent over row (barbell)': 'Barbell Row', 'bent over row': 'Barbell Row', 'pull up': 'Pull-Up', 'pullup': 'Pull-Up', 'chin up': 'Chin-Up', 'lat pulldown (cable)': 'Lat Pulldown', 'bicep curl (barbell)': 'Barbell Curl', 'bicep curl (dumbbell)': 'Dumbbell Curl', 'triceps pushdown (cable - straight bar)': 'Triceps Pushdown', 'leg press (machine)': 'Leg Press', 'romanian deadlift (barbell)': 'Romanian Deadlift', 'incline bench press (barbell)': 'Incline Bench Press', 'hip thrust (barbell)': 'Hip Thrust', 'lateral raise (dumbbell)': 'Lateral Raise', 'seated row (cable)': 'Seated Cable Row', 'front squat (barbell)': 'Front Squat', 'running': 'Outdoor Run', 'running (treadmill)': 'Treadmill Run', 'cycling': 'Stationary Bike', 'rowing (machine)': 'Rowing Machine' };
function guessMuscle(n) {
  n = n.toLowerCase();
  const map = [['curl', 'biceps'], ['tricep', 'triceps'], ['pushdown', 'triceps'], ['extension', 'triceps'], ['squat', 'quads'], ['leg press', 'quads'], ['lunge', 'quads'], ['deadlift', 'lowerback'], ['row', 'upperback'], ['pull', 'lats'], ['chin', 'lats'], ['bench', 'chest'], ['fly', 'chest'], ['chest', 'chest'], ['press', 'frontdelts'], ['raise', 'sidedelts'], ['calf', 'calves'], ['glute', 'glutes'], ['hip', 'glutes'], ['leg curl', 'hamstrings'], ['crunch', 'abs'], ['plank', 'abs'], ['run', 'cardio'], ['bike', 'cardio'], ['row machine', 'cardio']];
  for (const [k, m] of map) if (n.includes(k)) return m;
  return 'abs';
}
function resolveExercise(name, created) {
  const n = name.trim(), l = n.toLowerCase();
  if (ALIASES[l]) return exByName(ALIASES[l]).id;
  let ex = exByName(n); if (ex) return ex.id;
  const stripped = n.replace(/\s*\(.*?\)\s*/g, ' ').trim(); ex = exByName(stripped); if (ex) return ex.id;
  if (ALIASES[stripped.toLowerCase()]) return exByName(ALIASES[stripped.toLowerCase()]).id;
  const c = S.custom.find((x) => x.name.toLowerCase() === l); if (c) return c.id;
  if (created[l]) return created[l];
  const m = guessMuscle(n);
  const nc = { id: 'c:' + uid(), name: n, muscle: m, secondary: [], equipment: /dumbbell/i.test(n) ? 'dumbbell' : /cable/i.test(n) ? 'cable' : /machine/i.test(n) ? 'machine' : /barbell/i.test(n) ? 'barbell' : 'other', type: m === 'cardio' ? 'cardio' : 'weight', notes: 'Imported' };
  S.custom.push(nc); EX[nc.id] = { ...nc, custom: true }; created[l] = nc.id;
  return nc.id;
}
function parseDateLoose(s) {
  if (!s) return NaN;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 12), +(m[5] || 0), +(m[6] || 0)).getTime();
  m = s.match(/^(\d{1,2}) (\w{3})\w* (\d{4}),? (\d{1,2}):(\d{2})/); // Hevy: "5 Jan 2024, 18:30"
  if (m) { const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase()); return new Date(+m[3], mi, +m[1], +m[4], +m[5]).getTime(); }
  const t = Date.parse(s); return t;
}
function importCSV(text) {
  const rows = csvParse(text); if (!rows.length) throw new Error('Empty file');
  const h = Object.keys(rows[0]);
  const has = (k) => h.includes(k);
  let fmt = has('exercise_title') ? 'hevy' : has('Exercise Name') ? 'strong' : has('Exercise') && has('Reps') ? 'fitnotes' : null;
  if (!fmt) throw new Error('Unrecognised CSV — expected Strong, Hevy or FitNotes');
  const created = {}, groups = new Map();
  for (const r of rows) {
    let key, start, end = null, name, exName, w = null, reps = null, t = null, d = null, rpe = null, warm = false;
    if (fmt === 'hevy') {
      start = parseDateLoose(r.start_time); end = parseDateLoose(r.end_time); name = r.title; exName = r.exercise_title;
      w = r.weight_kg ? pnum(r.weight_kg) : r.weight_lbs ? pnum(r.weight_lbs) / LB : null; reps = pnum(r.reps); t = pnum(r.duration_seconds); d = pnum(r.distance_km); rpe = pnum(r.rpe); warm = r.set_type === 'warmup';
      key = r.start_time + '|' + r.title;
    } else if (fmt === 'strong') {
      start = parseDateLoose(r.Date); name = r['Workout Name']; exName = r['Exercise Name'];
      if (String(r['Set Order']).toUpperCase() === 'W') warm = true;
      w = pnum(r.Weight); if (w != null) w = fromU(w); reps = pnum(r.Reps); t = pnum(r.Seconds); d = pnum(r.Distance); rpe = pnum(r.RPE);
      const dm = (r.Duration || '').match(/(?:(\d+)h)?\s*(?:(\d+)m)?/); if (dm && (dm[1] || dm[2])) end = start + ((+dm[1] || 0) * 60 + (+dm[2] || 0)) * 6e4;
      key = r.Date + '|' + name;
    } else {
      start = parseDateLoose(r.Date); name = r.Category ? 'Workout' : 'Workout'; exName = r.Exercise;
      const unit = (r['Weight Unit'] || '').toLowerCase();
      const wv = pnum(r['Weight (kg)'] ?? r['Weight (lbs)'] ?? r.Weight);
      w = wv == null ? null : (unit.startsWith('lb') || has('Weight (lbs)') ? wv / LB : wv);
      reps = pnum(r.Reps); d = pnum(r.Distance); if (d != null && /mi/i.test(r['Distance Unit'] || '')) d *= 1.609344;
      const tm = (r.Time || '').split(':').map(Number); if (tm.length > 1) t = tm.reduce((a, b) => a * 60 + b, 0);
      key = r.Date;
    }
    if (isNaN(start) || !exName) continue;
    if (!groups.has(key)) groups.set(key, { id: 'imp:' + slug(key), start, end: end || start + 60 * 6e4, name: name || 'Workout', notes: 'Imported', entries: [], routineId: null, _ex: {} });
    const g = groups.get(key);
    const exId = resolveExercise(exName, created);
    if (!g._ex[exId]) { g._ex[exId] = { id: uid(), exId, ss: null, note: '', sets: [] }; g.entries.push(g._ex[exId]); }
    const ex = getEx(exId);
    if (ex.type === 'cardio' && t == null && reps == null && d == null) continue;
    g._ex[exId].sets.push({ id: uid(), w: w || null, r: reps, t, d, eff: rpe ? { v: rpe, scale: 'rpe' } : null, warm, done: true });
  }
  let n = 0; const existing = new Set(S.workouts.map((w) => w.id));
  for (const g of groups.values()) { delete g._ex; g.entries = g.entries.filter((e) => e.sets.length); if (!g.entries.length || existing.has(g.id)) continue; S.workouts.push(g); n++; }
  sortW(); save('workouts', 'custom'); buildEx();
  return { n, fmt, created: Object.keys(created).length };
}
function exportCSV() {
  const lines = [['Date', 'Workout', 'Duration (min)', 'Exercise', 'Set', 'Warm-up', `Weight (${U()})`, 'Reps', 'Seconds', `Distance (${distU()})`, 'Effort', 'Scale', 'Notes']];
  for (const w of [...S.workouts].reverse()) for (const e of w.entries) {
    let n = 0;
    for (const s of e.sets) lines.push([new Date(w.start).toISOString(), w.name, Math.round(wDur(w) / 6e4), getEx(e.exId).name, s.warm ? 'W' : ++n, s.warm ? 1 : 0, s.w != null ? num(toU(s.w), 2) : '', s.r ?? '', s.t ?? '', s.d != null ? num(toD(s.d), 3) : '', s.eff?.v ?? '', s.eff?.scale ?? '', e.note || '']);
  }
  return lines.map((l) => l.map((c) => { c = String(c); return /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c; }).join(',')).join('\n');
}

/* ---------- Demo data ---------- */
function loadDemo() {
  if (!S.routines.length) applyProgram('ul4', true);
  const rs = S.routines.slice(-4);
  const now = Date.now(), weeks = 10;
  const base = { 'Back Squat': 80, 'Bench Press': 60, 'Barbell Row': 55, 'Deadlift': 110, 'Overhead Press': 40, 'Front Squat': 65, 'Romanian Deadlift': 80, 'Weighted Pull-Up': 5, 'Lat Pulldown': 50, 'Seated Dumbbell Press': 18, 'Incline Dumbbell Press': 22, 'Chest-Supported Row': 22, 'Leg Press': 140, 'Lying Leg Curl': 35, 'Standing Calf Raise': 60, 'Triceps Pushdown': 25, 'Dumbbell Curl': 12, 'Lateral Raise': 8, 'Face Pull': 20, 'Bulgarian Split Squat': 16, 'Hip Thrust': 80 };
  let bw = 82;
  for (let wk = weeks; wk >= 0; wk--) {
    for (let di = 0; di < 4; di++) {
      const dayOffset = [0, 1, 3, 4][di];
      const t = weekStartOf(now - wk * 7 * DAY) + dayOffset * DAY + (17 + Math.floor(Math.random() * 3)) * 3600e3;
      if (t > now - 3600e3 || Math.random() < 0.1) continue;
      const r = rs[di % rs.length]; if (!r) continue;
      const prog = (weeks - wk) / weeks;
      const w = { id: uid(), start: t, end: t + (55 + Math.random() * 30) * 6e4, routineId: r.id, name: r.name, notes: '', entries: [] };
      for (const it of r.items) {
        const ex = getEx(it.exId), b = base[ex.name] ?? 20, sets = [];
        const kg = roundPlate(b * (1 + 0.18 * prog + (Math.random() - 0.5) * 0.03), ex.equipment);
        for (let i = 0; i < (it.sets || 3); i++) {
          const reps = Math.max(1, (it.repMax || it.repMin || 8) - Math.floor(Math.random() * 3) - (i > 1 ? 1 : 0));
          sets.push({ id: uid(), w: ex.type === 'weight' ? kg : ex.type === 'bodyweight' ? null : null, r: ex.type === 'timed' ? null : reps, t: ex.type === 'timed' ? 30 + Math.round(prog * 30) : null, d: null, eff: Math.random() < 0.5 ? { v: 7 + Math.round(Math.random() * 2), scale: 'rpe' } : null, warm: false, done: true });
        }
        w.entries.push({ id: uid(), exId: it.exId, ss: null, note: '', sets });
      }
      S.workouts.push(w);
    }
    for (let d = 0; d < 7; d += 2) { bw -= 0.12 + (Math.random() - 0.5) * 0.4; const ts = weekStartOf(now - wk * 7 * DAY) + d * DAY + 7 * 3600e3; if (ts < now) S.body.push({ id: uid(), date: ts, kg: Math.round(bw * 10) / 10 }); }
  }
  S.measures.push({ id: uid(), date: now - 70 * DAY, waist: 88, chest: 102, arm: 36, thigh: 58, hips: 98, bodyfat: 19 }, { id: uid(), date: now - 2 * DAY, waist: 85, chest: 104, arm: 37.2, thigh: 59, hips: 97, bodyfat: 17 });
  if (S.settings.bwGoal == null) S.settings.bwGoal = 78;
  sortW(); save('workouts', 'body', 'measures', 'settings');
}
/* ======================= Profiles UI ======================= */
function pickerView() {
  const list = [...PROFILES].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  return `<div class="picker-screen"><div class="center"><img src="icons/icon-192.png" alt="" style="width:76px;height:76px;border-radius:18px;margin:0 auto 10px"><h2 style="margin:0 0 6px">Who's training?</h2><p class="muted small" style="margin:0 12px 18px">Each person gets their own profile. Everything is saved only on this phone, and Forge remembers you next time.</p></div>
    ${list.length ? `<div class="list">${list.map((p) => `<button class="list-item" data-act="pickProfile" data-id="${p.id}">${avatar(p)}<div class="grow"><div style="font-weight:600">${esc(p.name)}</div><div class="sub">Last used ${relDay(p.lastUsed || p.created).toLowerCase()}</div></div><span class="chev">›</span></button>`).join('')}</div>` : ''}
    <div class="card"><div class="field"><label>${list.length ? 'Someone new? Enter your name' : 'Your name'}</label><input class="input" id="pname" autocomplete="given-name" placeholder="e.g. John" enterkeyhint="go" style="font-size:1.15rem"></div><button class="btn primary block" data-act="enterName">Continue</button></div>
    <button class="btn ghost block" data-act="receiveProfile">Moving from another phone? Receive your profile</button></div>`;
}
async function enterName(name) {
  name = (name || '').trim(); if (!name) return toast('Type your name first');
  const hit = PROFILES.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
  if (hit) return loadProfile(hit.id);
  const p = newProfile(name); PROFILES.push(p); await saveProfiles();
  await loadProfile(p.id);
  profileDetailsSheet(true);
}
function profileMenuSheet() {
  openSheet({
    title: 'Profiles',
    render: () => {
      const cur = me(), others = PROFILES.filter((p) => p.id !== PID);
      return `<div class="card row">${avatar(cur, 'lg')}<div class="grow"><div class="big">${esc(cur.name)}</div><div class="small muted">${S.workouts.length} workouts · ${details().level} · ${GOALS[details().goal] || ''}</div></div></div>
        <div class="list"><button class="list-item" data-act="editProfile"><div class="grow">Edit my details</div><span class="chev">›</span></button><button class="list-item" data-act="sendProfile"><div class="grow"><div>Send my profile to another device</div><div class="sub">One-time copy via a link or code — nothing is uploaded</div></div><span class="chev">›</span></button><button class="list-item" data-act="receiveProfile"><div class="grow">Receive a profile</div><span class="chev">›</span></button></div>
        ${others.length ? `<h3>Switch to</h3><div class="list">${others.map((p) => `<button class="list-item" data-act="pickProfile" data-id="${p.id}">${avatar(p)}<div class="grow">${esc(p.name)}</div><span class="chev">›</span></button>`).join('')}</div>` : ''}
        <button class="btn block" data-act="addPerson">+ Add another person</button>
        <p class="tiny faint mt">Profiles are stored only on this phone, in this app. Another phone or browser can't see them unless you send a copy.</p>`;
    }
  });
}
const GOALS = { strength: 'Strength', hypertrophy: 'Build muscle', fatloss: 'Lose fat / conditioning', general: 'General fitness' };
const LEVELS = { beginner: 'Beginner (< 1 yr)', intermediate: 'Intermediate (1–3 yrs)', advanced: 'Advanced (3+ yrs)' };
function profileDetailsSheet(isNew) {
  const p = me(); const st = { name: p.name, color: p.color, d: clone(details()), weight: latestBW() ? num(toU(latestBW()), 1) : '' };
  openSheet({
    title: isNew ? `Welcome, ${p.name}!` : 'My details', st, cancel: isNew ? 'Skip' : 'Close',
    right: { label: 'Save', fn: () => {
      p.name = (st.name || '').trim().slice(0, 40) || p.name; p.color = st.color; p.details = { ...st.d }; delete p.migrated;
      const w = pnum(st.weight);
      if (w && (!latestBW() || Math.abs(fromU(w) - latestBW()) > 0.05)) { S.body.push({ id: uid(), date: Date.now(), kg: fromU(w) }); save('body'); }
      _riskCache.key = null; saveProfiles(); closeSheet(); render();
      const conds = activeConditions(); let changed = 0;
      if (conds.length || lowImpact()) { S.routines.forEach((r) => { changed += adaptRoutine(r).length; }); if (changed) save('routines'); }
      toast(changed ? `Saved — ${changed} exercise${changed > 1 ? 's' : ''} in your routines swapped for safer options` : 'Saved', 3500);
      if (isNew && !S.routines.length) programsSheet();
    } },
    render: () => {
      const d = st.d;
      const seg = (k, opts) => `<div class="seg">${Object.entries(opts).map(([v, l]) => `<button class="${String(d[k]) === String(v) ? 'on' : ''}" data-act="pdSeg" data-k="${k}" data-v="${v}">${l}</button>`).join('')}</div>`;
      return `${isNew ? '<p class="muted small">A few optional details help Forge recommend programs and when to rotate exercises. You can change them any time.</p>' : ''}
        <div class="field"><label>Name</label><input class="input" data-oninput="pdName" value="${esc(st.name)}"></div>
        <div class="field"><label>Colour</label><div class="swatches">${PROFILE_COLORS.map((c) => `<button class="swatch ${st.color === c ? 'on' : ''}" style="background:${c}" data-act="pdColor" data-v="${c}"></button>`).join('')}</div></div>
        <div class="field"><label>Experience</label>${seg('level', { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' })}</div>
        <div class="field"><label>Main goal</label><select class="input" data-oninput="pdSel" data-k="goal">${Object.entries(GOALS).map(([k, v]) => `<option value="${k}" ${d.goal === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label>Training days per week</label>${seg('sessionsPerWeek', { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6' })}</div>
        <div class="grid2"><div class="field"><label>Born (year)</label><input class="input" inputmode="numeric" data-oninput="pdNum" data-k="birthYear" value="${d.birthYear || ''}" placeholder="1990"></div><div class="field"><label>Height (cm)</label><input class="input" inputmode="numeric" data-oninput="pdNum" data-k="heightCm" value="${d.heightCm || ''}"></div></div>
        <div class="grid2"><div class="field"><label>Body weight (${U()})</label><input class="input" inputmode="decimal" data-oninput="pdWeight" value="${esc(st.weight)}"></div><div class="field"><label>Sex (optional)</label><select class="input" data-oninput="pdSel" data-k="sex"><option value="">—</option><option value="m" ${d.sex === 'm' ? 'selected' : ''}>Male</option><option value="f" ${d.sex === 'f' ? 'selected' : ''}>Female</option></select></div></div>
        <h3>Injuries & health</h3><div class="card"><div class="small muted" style="margin-bottom:8px">Tap anything that's currently bothering you or that you need to protect. Forge swaps risky exercises for safer variations and warns you during workouts.</div><div class="row wrap" style="gap:6px">${Object.entries(CONDS).map(([k, c]) => `<button class="chip ${(d.injuries || []).includes(k) ? 'on' : ''}" data-act="pdInjury" data-v="${k}">${ico('body', 'xs', k)} ${c.label}</button>`).join('')}</div>
          <div class="small mt"><b>Surgeries</b></div>${(d.surgeries || []).map((x, i) => `<div class="row small" style="margin-top:6px"><span class="grow">${esc(CONDS[x.area]?.label || x.area)} · ${x.date ? fmtDate(parseKey(x.date), { day: 'numeric', month: 'short', year: 'numeric' }) : 'date unknown'}${x.note ? ' · ' + esc(x.note) : ''}</span><button class="btn sm ghost" data-act="rmSurgery" data-i="${i}">Remove</button></div>`).join('') || '<div class="tiny faint">None added</div>'}
          <div class="grid2 mt" style="gap:6px"><select class="input" data-oninput="srgArea">${Object.entries(CONDS).filter(([k]) => k !== 'heart').map(([k, c]) => `<option value="${k}" ${st.srgArea === k ? 'selected' : ''}>${c.label}</option>`).join('')}<option value="other">Other</option></select><input class="input" type="date" data-oninput="srgDate" value="${st.srgDate || ''}"></div><input class="input mt" data-oninput="srgNote" placeholder="e.g. ACL reconstruction (optional)" value="${esc(st.srgNote || '')}"><button class="btn sm block mt" data-act="addSurgery">+ Add surgery</button>
          <div class="field mt mb0"><label>Other notes for your training (optional)</label><textarea class="input" data-oninput="pdNotes" placeholder="e.g. avoid heavy overhead work, physio says no running until March">${esc(d.healthNotes || '')}</textarea></div>
          <p class="tiny faint mb0">Surgeries in the last 6 months are treated like an injury in that area; in the first 12 weeks volume is reduced too. This is guidance, not medical advice: follow your doctor or physio.</p></div>
        <h3>Exercise rotation</h3><div class="card"><label class="row between"><span>Mix up exercises automatically</span><span class="switch"><input type="checkbox" data-on="pdRotate" ${d.rotate ? 'checked' : ''}><span></span></span></label><div class="field mt mb0"><label>Suggest a new block every</label>${seg('rotateWeeks', { 3: '3 wks', 4: '4 wks', 6: '6 wks', 8: '8 wks' })}</div><p class="tiny faint mb0">Muscles adapt to the same movements. When a block ends, Forge proposes new variations of each movement (same muscles, new angle) and a new rep range. You always review before anything changes.</p></div>
        ${!isNew ? `<h3>Privacy</h3><div class="list"><button class="list-item" data-act="setPin"><div class="grow"><div>${me().pin ? 'Change or remove PIN' : 'Lock my profile with a PIN'}</div><div class="sub">For phones shared with family or friends</div></div><span>${me().pin ? ico('lock', 'sm accent') : '›'}</span></button></div>` : ''}
        ${!isNew && PROFILES.length > 1 ? `<button class="btn danger block mt" data-act="deleteProfile">Delete this profile</button>` : ''}`;
    }
  });
}
/* ---------- Send / receive a profile (no server: the data travels in the link itself) ---------- */
const b64url = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64url = (str) => { str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const bin = atob(str); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
async function packProfile() {
  let bytes = new TextEncoder().encode(exportData()), tag = 'F0';
  if (window.CompressionStream) { try { const st = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw')); bytes = new Uint8Array(await new Response(st).arrayBuffer()); tag = 'F1'; } catch (e) { /* fall back */ } }
  return `${tag}.${b64url(bytes)}`;
}
async function unpackProfile(text) {
  text = String(text || '').trim();
  const m = text.match(/#import=([A-Za-z0-9._-]+)/); if (m) text = m[1];
  if (text.startsWith('{')) return JSON.parse(text);
  const [tag, data] = text.split('.');
  if (!data || !/^F[01]$/.test(tag)) throw new Error('That doesn’t look like a Forge transfer code');
  let bytes = unb64url(data.replace(/\s+/g, ''));
  if (tag === 'F1') { if (!window.DecompressionStream) throw new Error('This browser is too old to unpack the code — use a backup file instead'); const st = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')); bytes = new Uint8Array(await new Response(st).arrayBuffer()); }
  return JSON.parse(new TextDecoder().decode(bytes));
}
function sendProfileSheet() {
  const st = { code: null };
  openSheet({
    title: 'Send to another device', st,
    render: () => {
      if (!st.code) return '<div class="empty">Packing your data…</div>';
      const link = `${location.origin}${location.pathname}#import=${st.code}`;
      return `<p class="small">This makes a <b>one-time copy</b> of ${esc(me().name)}'s profile (${S.workouts.length} workouts, routines, body data, settings). It travels inside the link or code itself — it is never uploaded anywhere.</p>
        <div class="card small"><b>On the other device:</b><ol class="steps"><li>Install Forge from the same web address and open it.</li><li>On “Who's training?”, tap <b>Receive your profile</b> (or Profiles → Receive a profile).</li><li>Paste the code or link and tap <b>Import</b>.</li></ol></div>
        <div class="grid2"><button class="btn primary" data-act="copyXfer">Copy code</button><button class="btn" data-act="shareXfer">Share…</button></div>
        <button class="btn block mt" data-act="exportJSON">Or save a backup file</button>
        <p class="tiny faint mt">Size: ${num(st.code.length / 1024, 0)} KB. Using AirDrop, Notes or Messages to yourself works well. Devices don't stay in sync: send a fresh copy whenever you switch phones.</p><code class="xfer">${esc(link.slice(0, 400))}${link.length > 400 ? '…' : ''}</code>`;
    },
    after: async () => { if (!st.code) { st.code = await packProfile(); refreshSheet(); } }
  });
}
function receiveSheet(prefill = '') {
  const st = { text: prefill, data: null, err: '' };
  openSheet({
    title: 'Receive a profile', st,
    render: () => {
      if (st.data) {
        const o = st.data, name = o.profile?.name || 'Imported', same = PROFILES.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
        const last = (o.workouts || []).reduce((a, w) => Math.max(a, w.start || 0), 0);
        return `<div class="card row">${avatar({ name, color: o.profile?.color || '#888' }, 'lg')}<div><div class="big">${esc(name)}</div><div class="small muted">${(o.workouts || []).length} workouts · ${(o.routines || []).length} routines${last ? ' · last ' + relDay(last).toLowerCase() : ''}</div></div></div>
          ${same ? `<button class="btn primary block" data-act="importMerge" data-id="${same.id}">Merge into “${esc(same.name)}” on this device</button><button class="btn block mt" data-act="importNew">Add as a separate profile</button>` : `<button class="btn primary block" data-act="importNew">Add ${esc(name)} to this device</button>`}
          <p class="tiny faint mt">Merging adds missing workouts and never deletes anything.</p>`;
      }
      return `<p class="small muted">Paste the code or link from the other device.</p><textarea class="input" data-oninput="xferText" placeholder="F1.… or https://…#import=…" style="min-height:120px;font-size:0.8rem">${esc(st.text)}</textarea>${st.err ? `<p class="small bad">${esc(st.err)}</p>` : ''}<button class="btn primary block mt" data-act="xferRead">Import</button><button class="btn block mt" data-act="xferFile">Choose a backup file instead</button>`;
    },
    after: async () => { if (prefill && !st.data && !st.err) { prefill = ''; try { st.data = await unpackProfile(st.text); } catch (e) { st.err = e.message; } refreshSheet(); } }
  });
}
async function importAsNewProfile(o) {
  const src = o.profile || {};
  const p = { ...newProfile(src.name || 'Imported'), color: src.color || PROFILE_COLORS[0], details: { ...DEFAULT_DETAILS, ...(src.details || {}) } };
  if (PROFILES.some((x) => x.name.toLowerCase() === p.name.toLowerCase())) p.name += ' (2)';
  PROFILES.push(p); await saveProfiles();
  await Promise.all(KEYS.filter((k) => k !== 'active').map((k) => (o[k] != null ? Store.set(`${p.id}:${k}`, o[k]) : null)));
  await loadProfile(p.id); toast(`Welcome, ${p.name}! ${(o.workouts || []).length} workouts imported`, 3000);
}

/* ======================= Exercise visuals & guides ======================= */
const guideOf = (ex) => (ex && !ex.custom ? GUIDE[ex.name] : null);
function miniMap(ex) {
  const vals = {}; vals[ex.muscle] = 1; ex.secondary.forEach((m) => { if (!vals[m]) vals[m] = 0.45; });
  return miniMapVals(vals);
}
function miniMapVals(vals) {
  const col = (m) => (vals[m] ? `color-mix(in srgb, var(--accent) ${Math.round(vals[m] * 100)}%, var(--card2))` : '');
  const fig = (shapes) => `<svg viewBox="0 0 100 190"><g class="base">${BASE_COMMON.join('')}</g>${shapes.map(([m, sh]) => sh.replace(/^<(\w+)/, `<$1 class="m${vals[m] ? '' : ' base'}"${vals[m] ? ` style="fill:${col(m)}"` : ''}`)).join('')}</svg>`;
  return `<div class="mini">${fig(FRONT)}${fig(BACK)}</div>`;
}
function thumb(ex, cls = '') {
  const g = guideOf(ex);
  if (g && g.n) return `<img class="thumb ${cls}" loading="lazy" src="img/${g.img}-0.jpg" alt="">`;
  return `<div class="thumb map ${cls}">${miniMap(ex)}</div>`;
}
function safetyFor(ex) {
  const pat = ex.type === 'mobility' ? 'mobility' : PATTERN_OF[ex.id] || ({ abs: 'corehold', obliques: 'coreweighted', cardio: 'cardio', biceps: 'biceps', triceps: 'triceps', calves: 'calf' }[ex.muscle]);
  return [...(window.SAFETY[pat] || []), ...(ex.type === 'mobility' ? [] : window.SAFETY_GENERAL)];
}
function techFor(ex) {
  if (ex.type !== 'weight') return [];
  const pat = PATTERN_OF[ex.id];
  if (['squat', 'hinge'].includes(pat) && ex.equipment === 'barbell') return ['tempo', 'amrap'];
  if (COMPOUND.has(pat)) return ['rp', 'tempo', 'amrap'];
  return ['drop', 'myo', 'partials', 'fail'];
}
function altsFor(ex) {
  const pat = PATTERN_OF[ex.id]; if (!pat) return [];
  return PATTERNS[pat].map(exByName).filter((e) => e && e.id !== ex.id && e.type === ex.type).slice(0, 6);
}
function techGuideSheet(only) {
  openSheet({
    title: 'Hypertrophy methods',
    render: () => `<p class="small muted">Proven ways to push a set harder. Use them on the <b>last set</b> of an exercise, 1–2 exercises per session; they're tiring, so more is not better.</p>${Object.entries(TECH).filter(([k]) => !only || k === only).map(([k, t]) => `<div class="card"><div class="row between"><b>${t.name}</b><span class="tech">${t.short}</span></div><div class="small mt"><b>How:</b> ${t.how}</div><div class="small mt"><b>Why:</b> ${t.why}</div><div class="small mt muted"><b>Best for:</b> ${t.when}</div></div>`).join('')}
      <div class="card small"><b>The fundamentals still matter most:</b> progressive overload (a little more weight or reps over time), 10–20 hard sets per muscle per week, sets within 0–3 reps of failure, enough protein (~1.6–2.2 g/kg body weight) and sleep.</div>`
  });
}

/* ======================= Plateau coaching ======================= */
const MOTIVATION = [
  'Stuck is just the moment before strong. Today you push.',
  'Your body adapted — now give it a reason to grow again.',
  'You’ve owned this weight. Time to move in upstairs.',
  'Progress isn’t linear, but it is earned. One more rep than last time.',
  'Comfort is where gains go to sleep. Wake them up today.',
  'The bar doesn’t know you’re tired. Show it who’s in charge.',
  'Champions are built in the last two reps. Chase them.'
];
function plateau(exId, exclude) {
  const ex = getEx(exId); if (ex.type !== 'weight') return null;
  const sess = entriesFor(exId, { exclude }).slice(0, 8).map(({ w, e }) => {
    const ws = e.sets.filter((s) => isWork(s) && s.tech !== 'drop');
    const top = Math.max(0, ...ws.map((s) => s.w || 0));
    return { top, reps: ws.filter((s) => (s.w || 0) >= top - 0.01).reduce((a, s) => a + (s.r || 0), 0), e1: Math.max(0, ...ws.map(e1rm)), date: w.start };
  }).filter((x) => x.top > 0);
  if (sess.length < 3) return null;
  let n = 0;
  for (let i = 0; i < sess.length - 1; i++) {
    const older = sess.slice(i + 1), bestTop = Math.max(...older.map((x) => x.top)), bestE = Math.max(...older.map((x) => x.e1));
    const sameTop = older.filter((x) => Math.abs(x.top - bestTop) < 0.01);
    const s0 = sess[i];
    const progressed = s0.top > bestTop + 0.01 || s0.e1 > bestE * 1.015 || (Math.abs(s0.top - bestTop) < 0.01 && s0.reps > Math.max(...sameTop.map((x) => x.reps)));
    if (progressed) break;
    n++;
  }
  if (sess.length - 1 === n) n++; // never progressed in the whole window
  return n >= 3 ? { n, w: sess[0].top } : null;
}
function coachHTML(e, ei) {
  if (S.active.editing) return '';
  const pl = plateau(e.exId, S.active.origId); if (!pl) return '';
  const ex = getEx(e.exId), inc = e.item?.inc ?? defaultInc(ex);
  const msg = MOTIVATION[(pl.n + new Date().getDate()) % MOTIVATION.length];
  let tip, btns;
  if (pl.n <= 4) { tip = `You've been around ${fmtW(pl.w)} for ${pl.n} sessions. Try <b>${fmtW(pl.w + inc)}</b> on your first set today, or add one rep to every set.`; btns = `<button class="btn sm primary" data-act="bumpWeight" data-e="${ei}">Load +${fmtW(inc)}</button><button class="btn sm" data-act="addTechLast" data-e="${ei}" data-v="rp">Rest-pause last set</button>`; }
  else if (pl.n <= 6) { tip = `${pl.n} sessions without a new best. Extend your last set with a <b>drop set</b> or <b>rest-pause</b>, or add one extra set this week.`; btns = `<button class="btn sm primary" data-act="addTechLast" data-e="${ei}" data-v="drop">Add drop set</button><button class="btn sm" data-act="bumpWeight" data-e="${ei}">Try +${fmtW(inc)}</button><button class="btn sm" data-act="addSet" data-e="${ei}">+1 set</button>`; }
  else { tip = `${pl.n} sessions stuck: time for a reset. <b>Deload 10%</b> today and build back up with clean reps, or swap to a variation for a few weeks.`; btns = `<button class="btn sm primary" data-act="deloadEntry" data-e="${ei}">Deload −10%</button><button class="btn sm" data-act="replaceEx" data-e="${ei}">Swap variation</button>`; }
  return `<div class="coach">${ico('bolt', 'xs warn')} <b>Plateau buster</b> — ${esc(msg)}<div class="mt">${tip}</div><div class="row wrap">${btns}<button class="btn sm ghost" data-act="techGuide">Methods</button></div></div>`;
}
function plateauList() {
  const ids = new Set(); const out = [];
  for (const w of S.workouts.slice(0, 30)) for (const e of w.entries) ids.add(e.exId);
  for (const id of ids) { const p = plateau(id); if (p) out.push({ id, ...p }); }
  return out.sort((a, b) => b.n - a.n);
}

/* ======================= Program library ======================= */
const WARM = {
  upper: [['Jumping Jacks', '60s'], ['Arm Circles', '30s'], ['Band Dislocates', '30s'], ['Thoracic Rotation', '30s']],
  lower: [['Jumping Jacks', '60s'], ['Leg Swings', '30s'], ['Hip Circles', '30s'], ["World's Greatest Stretch", '45s'], ['Glute Bridge March', '30s']],
  full: [['Jumping Jacks', '60s'], ['Arm Circles', '30s'], ['Leg Swings', '30s'], ["World's Greatest Stretch", '45s'], ['Inchworm', '30s']],
  core: [['Jumping Jacks', '60s'], ['Cat-Cow', '30s'], ['Thoracic Rotation', '30s'], ['Glute Bridge March', '30s']],
  cardio: [['Jumping Jacks', '60s'], ['Leg Swings', '30s'], ['Ankle Circles', '30s']]
};
const COOL = {
  upper: [['Doorway Chest Stretch', '30s'], ['Cross-Body Shoulder Stretch', '30s'], ['Overhead Triceps Stretch', '30s'], ['Standing Side Stretch', '30s'], ["Child's Pose", '45s']],
  lower: [['Standing Quad Stretch', '30s'], ['Standing Hamstring Stretch', '30s'], ['Kneeling Hip Flexor Stretch', '30s'], ['Pigeon Stretch', '45s'], ['Wall Calf Stretch', '30s']],
  full: [['Standing Hamstring Stretch', '30s'], ['Kneeling Hip Flexor Stretch', '30s'], ['Doorway Chest Stretch', '30s'], ['Figure-4 Glute Stretch', '30s'], ["Child's Pose", '45s']],
  core: [['Cobra Stretch', '30s'], ['Supine Spinal Twist', '30s'], ["Child's Pose", '45s']],
  cardio: [['Standing Quad Stretch', '30s'], ['Standing Hamstring Stretch', '30s'], ['Wall Calf Stretch', '30s'], ['Butterfly Stretch', '30s']]
};
/* Item: [exercise, sets, reps ('5', '8-12', '45s', '20m'), technique?] */
const PROGRAMS = [
  { id: 'fb-ab', name: 'Full Body A/B', level: 'beginner', goal: ['strength', 'general'], days: 3, equip: 'gym', prog: 'linear', minutes: 50, sched: { 1: 0, 3: 1, 5: 0 },
    desc: 'The best place to start: three full-body sessions a week alternating two workouts. Add a little weight every session while you can.',
    routines: [['Full Body A', 'full', [['Back Squat', 3, '5'], ['Bench Press', 3, '5'], ['Barbell Row', 3, '8'], ['Plank', 3, '30s']]], ['Full Body B', 'full', [['Deadlift', 1, '5'], ['Overhead Press', 3, '5'], ['Lat Pulldown', 3, '8-12'], ['Hanging Knee Raise', 3, '10-15']]]] },
  { id: '5x5', name: '5×5 Linear Strength', level: 'beginner', goal: ['strength'], days: 3, equip: 'gym', prog: 'linear', minutes: 60, sched: { 1: 0, 3: 1, 5: 0 },
    desc: 'Five sets of five on the big barbell lifts, adding weight each session. Simple and very effective for new lifters.',
    routines: [['5×5 A', 'full', [['Back Squat', 5, '5'], ['Bench Press', 5, '5'], ['Barbell Row', 5, '5']]], ['5×5 B', 'full', [['Back Squat', 5, '5'], ['Overhead Press', 5, '5'], ['Deadlift', 1, '5']]]] },
  { id: 'lp-amrap', name: 'Linear + AMRAP (3 days)', level: 'beginner', goal: ['strength', 'hypertrophy'], days: 3, equip: 'gym', prog: 'linear', minutes: 55, sched: { 1: 0, 3: 1, 5: 0 },
    desc: 'Linear progression where the last set of each main lift is as-many-reps-as-possible. Big AMRAPs mean you can jump weight faster. Includes arm and back accessories.',
    routines: [['LP Day A', 'full', [['Bench Press', 3, '5', 'amrap'], ['Back Squat', 3, '5', 'amrap'], ['Chin-Up', 3, '6-10'], ['Triceps Pushdown', 3, '10-15']]], ['LP Day B', 'full', [['Overhead Press', 3, '5', 'amrap'], ['Deadlift', 1, '5', 'amrap'], ['Barbell Row', 3, '8-10'], ['Barbell Curl', 3, '10-12']]]] },
  { id: 'ul4', name: 'Upper / Lower', level: 'intermediate', goal: ['hypertrophy', 'strength'], days: 4, equip: 'gym', prog: 'double', minutes: 65, sched: { 1: 0, 2: 1, 4: 2, 5: 3 },
    desc: 'Each muscle twice a week with balanced volume. A great default for intermediate lifters who want size and strength.',
    routines: [
      ['Upper 1', 'upper', [['Bench Press', 4, '5-8'], ['Barbell Row', 4, '6-10'], ['Seated Dumbbell Press', 3, '8-12'], ['Lat Pulldown', 3, '8-12'], ['Triceps Pushdown', 3, '10-15', 'drop'], ['Dumbbell Curl', 3, '10-15']]],
      ['Lower 1', 'lower', [['Back Squat', 4, '5-8'], ['Romanian Deadlift', 3, '8-10'], ['Leg Press', 3, '10-15'], ['Lying Leg Curl', 3, '10-15', 'myo'], ['Standing Calf Raise', 4, '10-15']]],
      ['Upper 2', 'upper', [['Overhead Press', 4, '5-8'], ['Weighted Pull-Up', 4, '5-8'], ['Incline Dumbbell Press', 3, '8-12'], ['Chest-Supported Row', 3, '8-12'], ['Lateral Raise', 3, '12-20', 'drop'], ['Face Pull', 3, '12-20']]],
      ['Lower 2', 'lower', [['Deadlift', 3, '3-5'], ['Front Squat', 3, '6-8'], ['Bulgarian Split Squat', 3, '8-12'], ['Hip Thrust', 3, '8-12'], ['Hanging Leg Raise', 3, '8-15']]]] },
  { id: 'phul', name: 'Power & Hypertrophy Upper/Lower', level: 'intermediate', goal: ['strength', 'hypertrophy'], days: 4, equip: 'gym', prog: 'double', minutes: 70, sched: { 1: 0, 2: 1, 4: 2, 5: 3 },
    desc: 'Two heavy "power" days and two higher-rep "hypertrophy" days per week, in the style of the popular PHUL split. Strength and size together.',
    routines: [
      ['Upper Power', 'upper', [['Bench Press', 4, '3-5'], ['Incline Dumbbell Press', 3, '6-10'], ['Barbell Row', 4, '3-5'], ['Lat Pulldown', 3, '6-10'], ['Overhead Press', 3, '5-8'], ['Barbell Curl', 2, '6-10'], ['Skull Crusher', 2, '6-10']]],
      ['Lower Power', 'lower', [['Back Squat', 4, '3-5'], ['Deadlift', 3, '3-5'], ['Leg Press', 4, '10-15'], ['Lying Leg Curl', 4, '6-10'], ['Standing Calf Raise', 4, '6-10']]],
      ['Upper Hypertrophy', 'upper', [['Incline Bench Press', 4, '8-12'], ['Dumbbell Fly', 3, '8-12', 'drop'], ['Seated Cable Row', 4, '8-12'], ['One-Arm Dumbbell Row', 3, '8-12'], ['Lateral Raise', 4, '10-15', 'myo'], ['Incline Dumbbell Curl', 4, '8-12'], ['Rope Pushdown', 4, '8-12', 'drop']]],
      ['Lower Hypertrophy', 'lower', [['Front Squat', 4, '8-12'], ['Bulgarian Split Squat', 3, '8-12'], ['Leg Extension', 3, '10-15', 'drop'], ['Seated Leg Curl', 3, '10-15', 'partials'], ['Seated Calf Raise', 4, '8-12'], ['Cable Crunch', 3, '10-15']]]] },
  { id: 'ppl6', name: 'Push / Pull / Legs ×2', level: 'intermediate', goal: ['hypertrophy'], days: 6, equip: 'gym', prog: 'double', minutes: 60, sched: { 1: 0, 2: 1, 3: 2, 4: 0, 5: 1, 6: 2 },
    desc: 'High-frequency bodybuilding split: each day twice a week. Lots of volume for maximum muscle growth if you can recover from 6 days.',
    routines: [
      ['Push', 'upper', [['Bench Press', 4, '6-10'], ['Incline Dumbbell Press', 3, '8-12'], ['Seated Dumbbell Press', 3, '8-12'], ['Lateral Raise', 4, '12-20', 'drop'], ['Rope Pushdown', 3, '10-15'], ['Overhead Cable Extension', 3, '10-15', 'myo']]],
      ['Pull', 'upper', [['Pull-Up', 4, '6-10'], ['Barbell Row', 3, '6-10'], ['Seated Cable Row', 3, '10-12'], ['Face Pull', 3, '12-20'], ['Hammer Curl', 3, '10-15'], ['Incline Dumbbell Curl', 3, '10-15', 'drop']]],
      ['Legs', 'lower', [['Back Squat', 4, '5-8'], ['Romanian Deadlift', 3, '8-10'], ['Leg Press', 3, '10-15', 'rp'], ['Seated Leg Curl', 3, '10-15'], ['Standing Calf Raise', 4, '10-15', 'partials'], ['Plank', 3, '45s']]]] },
  { id: 'ppl3', name: 'Push / Pull / Legs (3 days)', level: 'beginner', goal: ['hypertrophy', 'general'], days: 3, equip: 'gym', prog: 'double', minutes: 60, sched: { 1: 0, 3: 1, 5: 2 },
    desc: 'The classic split once per week — easy to recover from and simple to follow.',
    routines: [
      ['Push Day', 'upper', [['Bench Press', 3, '6-10'], ['Seated Dumbbell Press', 3, '8-12'], ['Incline Dumbbell Fly', 3, '10-15'], ['Lateral Raise', 3, '12-20'], ['Triceps Pushdown', 3, '10-15']]],
      ['Pull Day', 'upper', [['Lat Pulldown', 3, '8-12'], ['One-Arm Dumbbell Row', 3, '8-12'], ['Face Pull', 3, '12-20'], ['Dumbbell Curl', 3, '10-15'], ['Hammer Curl', 2, '10-15']]],
      ['Leg Day', 'lower', [['Goblet Squat', 3, '8-12'], ['Romanian Deadlift', 3, '8-12'], ['Leg Press', 3, '10-15'], ['Lying Leg Curl', 3, '10-15'], ['Seated Calf Raise', 3, '12-15']]]] },
  { id: 'arnold', name: 'Chest & Back / Shoulders & Arms / Legs', level: 'advanced', goal: ['hypertrophy'], days: 6, equip: 'gym', prog: 'double', minutes: 75, sched: { 1: 0, 2: 1, 3: 2, 4: 0, 5: 1, 6: 2 },
    desc: 'A classic golden-era style split pairing opposing muscles (chest with back). High volume for experienced lifters.',
    routines: [
      ['Chest & Back', 'upper', [['Bench Press', 4, '6-10'], ['Weighted Pull-Up', 4, '6-10'], ['Incline Dumbbell Press', 3, '8-12'], ['T-Bar Row', 3, '8-12'], ['Cable Crossover', 3, '12-15', 'drop'], ['Straight-Arm Pulldown', 3, '12-15']]],
      ['Shoulders & Arms', 'upper', [['Overhead Press', 4, '6-10'], ['Lateral Raise', 4, '12-20', 'myo'], ['Rear Delt Fly', 3, '12-20'], ['EZ-Bar Curl', 3, '8-12'], ['Skull Crusher', 3, '8-12'], ['Spider Curl', 3, '10-15', 'drop'], ['Rope Pushdown', 3, '10-15', 'drop']]],
      ['Legs & Core', 'lower', [['Back Squat', 4, '6-10'], ['Stiff-Leg Deadlift', 3, '8-10'], ['Hack Squat', 3, '10-12'], ['Seated Leg Curl', 3, '10-15', 'rp'], ['Standing Calf Raise', 5, '10-15'], ['Hanging Leg Raise', 3, '10-15']]]] },
  { id: 'bro5', name: '5-Day Body-Part Split', level: 'intermediate', goal: ['hypertrophy'], days: 5, equip: 'gym', prog: 'double', minutes: 55, sched: { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4 },
    desc: 'One muscle group per day with lots of variety and intensity techniques. Fun and pumpy; best with good nutrition and sleep.',
    routines: [
      ['Chest', 'upper', [['Incline Bench Press', 4, '6-10'], ['Dumbbell Bench Press', 3, '8-12'], ['Low-to-High Cable Fly', 3, '12-15'], ['Pec Deck', 3, '12-15', 'drop'], ['Push-Up', 2, '10-20']]],
      ['Back', 'upper', [['Deadlift', 3, '3-5'], ['Lat Pulldown', 4, '8-12'], ['Chest-Supported Row', 3, '8-12'], ['Seated Cable Row', 3, '10-12', 'rp'], ['Dumbbell Shrug', 3, '10-15']]],
      ['Shoulders', 'upper', [['Seated Dumbbell Press', 4, '6-10'], ['Lateral Raise', 4, '12-20', 'drop'], ['Cable Lateral Raise', 3, '12-15'], ['Reverse Pec Deck', 3, '12-20'], ['Face Pull', 3, '15-20']]],
      ['Legs', 'lower', [['Back Squat', 4, '6-10'], ['Leg Press', 3, '10-15'], ['Walking Lunge', 3, '10-12'], ['Lying Leg Curl', 4, '10-15', 'myo'], ['Leg Extension', 3, '12-15', 'drop'], ['Seated Calf Raise', 4, '10-15']]],
      ['Arms', 'upper', [['Close-Grip Bench Press', 3, '6-10'], ['Barbell Curl', 3, '8-12'], ['Overhead Cable Extension', 3, '10-15'], ['Preacher Curl', 3, '10-12', 'drop'], ['Rope Pushdown', 3, '12-15', 'drop'], ['Hammer Curl', 3, '10-15']]]] },
  { id: 'str4', name: 'Strength 4-Day (big lifts + accessories)', level: 'advanced', goal: ['strength'], days: 4, equip: 'gym', prog: 'linear', minutes: 70, sched: { 1: 0, 2: 1, 4: 2, 5: 3 },
    desc: 'One main lift per day, heavy, followed by targeted accessories, in the style of popular powerlifting templates. Last set AMRAP drives progress.',
    routines: [
      ['Squat Day', 'lower', [['Back Squat', 3, '5', 'amrap'], ['Paused Squat', 3, '3'], ['Romanian Deadlift', 3, '8'], ['Walking Lunge', 3, '10'], ['Ab Wheel Rollout', 3, '8-12']]],
      ['Bench Day', 'upper', [['Bench Press', 3, '5', 'amrap'], ['Close-Grip Bench Press', 3, '6-8'], ['Chest-Supported Row', 4, '8-10'], ['Face Pull', 3, '15-20'], ['Dumbbell Kickback', 3, '12-15']]],
      ['Deadlift Day', 'lower', [['Deadlift', 3, '5', 'amrap'], ['Front Squat', 3, '6'], ['Good Morning', 3, '8'], ['Hanging Leg Raise', 3, '10-15'], ["Farmer's Carry", 3, '40s']]],
      ['Press Day', 'upper', [['Overhead Press', 3, '5', 'amrap'], ['Incline Dumbbell Press', 3, '8-10'], ['Weighted Chin-Up', 4, '5-8'], ['Lateral Raise', 3, '12-15'], ['Barbell Curl', 3, '8-12']]]] },
  { id: 'db3', name: 'Dumbbell-Only Full Body', level: 'beginner', goal: ['hypertrophy', 'general'], days: 3, equip: 'dumbbell', prog: 'double', minutes: 45, sched: { 1: 0, 3: 1, 5: 0 },
    desc: 'Everything with a pair of dumbbells and a bench — perfect for home or hotel gyms.',
    routines: [['DB Full Body A', 'full', [['Goblet Squat', 3, '8-15'], ['Dumbbell Bench Press', 3, '8-12'], ['One-Arm Dumbbell Row', 3, '8-12'], ['Seated Dumbbell Press', 3, '8-12'], ['Dumbbell Curl', 2, '10-15', 'drop'], ['Plank', 3, '40s']]],
      ['DB Full Body B', 'full', [['Dumbbell Romanian Deadlift', 3, '8-12'], ['Bulgarian Split Squat', 3, '8-12'], ['Incline Dumbbell Press', 3, '8-12'], ['Chest-Supported Row', 3, '10-12'], ['Lateral Raise', 3, '12-20', 'myo'], ['Overhead Dumbbell Extension', 2, '10-15']]]] },
  { id: 'cal3', name: 'Calisthenics / Body Weight', level: 'beginner', goal: ['general', 'hypertrophy'], days: 3, equip: 'bodyweight', prog: 'double', minutes: 40, sched: { 1: 0, 3: 0, 5: 0 },
    desc: 'No gym needed — just a pull-up bar (or a sturdy table for rows). Progress reps, then harder variations.',
    routines: [['Body Weight', 'full', [['Push-Up', 3, '8-20'], ['Pull-Up', 3, '4-10'], ['Bulgarian Split Squat', 3, '8-15'], ['Inverted Row', 3, '8-15'], ['Glute Bridge', 3, '12-25'], ['Hollow Hold', 3, '30s'], ['Dead Bug', 3, '8-15']]]] },
  { id: 'core', name: 'Core Crusher (Landmine + Body Weight)', level: 'intermediate', goal: ['general', 'fatloss'], days: 2, equip: 'landmine', prog: 'double', minutes: 35, sched: { 2: 0, 4: 1 },
    desc: 'Brutal anti-rotation and rotation work with the landmine, plus the hardest body-weight core moves. Add it after a lifting session or on its own.',
    routines: [['Core Crusher A', 'core', [['Landmine Rotation', 4, '8-12'], ['Landmine Anti-Rotation Press', 3, '8-10'], ['Hanging Leg Raise', 3, '8-15'], ['Ab Wheel Rollout', 3, '8-12'], ['Side Plank Hip Dip', 3, '10-15'], ['Hollow Hold', 3, '30s']]],
      ['Core Crusher B', 'core', [['Landmine Thruster', 3, '8-10'], ['Pallof Press', 3, '10-12'], ['Toes-to-Bar', 3, '6-12'], ['Dragon Flag', 3, '4-8'], ['Plank Shoulder Tap', 3, '20-30'], ['Suitcase Carry', 3, '40s'], ['Mountain Climber', 3, '30s']]]] },
  { id: 'landmine', name: 'Landmine Full Body', level: 'intermediate', goal: ['general', 'hypertrophy'], days: 3, equip: 'landmine', prog: 'double', minutes: 45, sched: { 1: 0, 3: 1, 5: 0 },
    desc: 'Joint-friendly full-body training with just a barbell in a corner or landmine attachment. Great for shoulders and lower backs that don’t like straight bars.',
    routines: [['Landmine A', 'full', [['Landmine Squat', 4, '8-12'], ['Landmine Press', 3, '8-12'], ['Landmine Row', 3, '8-12'], ['Landmine Romanian Deadlift', 3, '8-12'], ['Landmine Rotation', 3, '8-12']]],
      ['Landmine B', 'full', [['Landmine Reverse Lunge', 3, '8-12'], ['Landmine Thruster', 3, '8-10'], ['T-Bar Row', 3, '8-12'], ['Landmine Anti-Rotation Press', 3, '8-10'], ['Push-Up', 3, '10-20']]]] },
  { id: 'hiit', name: 'Body-Weight HIIT & Core', level: 'beginner', goal: ['fatloss', 'general'], days: 3, equip: 'bodyweight', prog: 'double', minutes: 30, sched: { 2: 0, 4: 0, 6: 0 },
    desc: 'Short, sweaty circuits. Move between exercises with minimal rest; rest 60–90 s after each round.',
    routines: [['HIIT Circuit', 'full', [['Burpee', 3, '10-15'], ['Squat Jump', 3, '12-20'], ['Mountain Climber', 3, '40s'], ['Push-Up', 3, '10-20'], ['Skater Jumps', 3, '40s'], ['High Knees', 3, '30s'], ['Plank', 3, '40s']], { circuit: true }]] },
  { id: 'cardio', name: 'Cardio: Zone 2 + Intervals', level: 'beginner', goal: ['fatloss', 'general'], days: 3, equip: 'cardio', prog: 'none', minutes: 40, sched: { 2: 0, 4: 1, 6: 0 },
    desc: 'Mostly easy "zone 2" cardio for your heart and recovery, plus one hard interval day. Pairs well with any lifting program.',
    routines: [['Zone 2 Cardio', 'cardio', [['Incline Treadmill Walk', 1, '30m'], ['Stationary Bike', 1, '15m']]], ['Intervals', 'cardio', [['Rowing Machine', 1, '10m'], ['Sprint Intervals', 1, '15m'], ['Battle Ropes', 4, '30s']]]] },
  { id: 'express', name: '30-Minute Express', level: 'beginner', goal: ['general', 'hypertrophy'], days: 3, equip: 'gym', prog: 'double', minutes: 30, sched: { 1: 0, 3: 1, 5: 0 },
    desc: 'Busy week? Supersets of opposing muscles get a full-body session done in 30 minutes.',
    routines: [['Express A', 'full', [['Goblet Squat', 3, '8-12', null, true], ['One-Arm Dumbbell Row', 3, '8-12'], ['Dumbbell Bench Press', 3, '8-12', null, true], ['Lying Leg Curl', 3, '10-15']]], ['Express B', 'full', [['Leg Press', 3, '10-15', null, true], ['Seated Dumbbell Press', 3, '8-12'], ['Lat Pulldown', 3, '8-12', null, true], ['Hip Thrust', 3, '8-12']]]] },
  { id: 'glutes', name: 'Glutes & Legs Focus', level: 'intermediate', goal: ['hypertrophy'], days: 2, equip: 'gym', prog: 'double', minutes: 55, sched: { 2: 0, 5: 1 },
    desc: 'Two lower-body days built around hip thrusts, split squats and hamstrings — add to an upper-body plan.',
    routines: [['Glutes A', 'lower', [['Hip Thrust', 4, '6-10'], ['Romanian Deadlift', 3, '8-10'], ['Bulgarian Split Squat', 3, '8-12'], ['Hip Abduction Machine', 3, '12-20', 'drop'], ['Cable Pull-Through', 3, '12-15']]],
      ['Glutes B', 'lower', [['Sumo Deadlift', 3, '5-8'], ['Reverse Lunge', 3, '8-12'], ['Leg Press', 3, '10-15'], ['Seated Leg Curl', 3, '10-15', 'myo'], ['Glute Bridge', 2, '15-25']]]] }
];
const EQUIP_LABEL = { gym: 'Full gym', dumbbell: 'Dumbbells', bodyweight: 'No equipment', landmine: 'Landmine / barbell', cardio: 'Cardio machines' };
function parseReps(str) {
  str = String(str || '');
  if (/s$/.test(str)) return { time: +str.slice(0, -1) };
  if (/m$/.test(str)) return { time: +str.slice(0, -1) * 60 };
  const [a, b] = str.split('-').map(Number);
  return { repMin: a || null, repMax: b || a || null };
}
function mobilityItems(list, phase) {
  return list.map(([n, t]) => { const ex = exByName(n); if (!ex) return null; return { exId: ex.id, sets: 1, time: parseReps(t).time || 30, phase }; }).filter(Boolean);
}
function buildRoutine(name, focus, items, prog, opts = {}) {
  const r = { id: uid(), name, prog, items: [], created: Date.now(), focus, block: { start: Date.now(), n: 1, scheme: 'hyp' } };
  r.items.push(...mobilityItems(WARM[focus] || WARM.full, 'warmup'));
  items.forEach(([n, sets, reps, tech, ss]) => {
    const ex = exByName(n); if (!ex) return;
    const it = { exId: ex.id, sets, phase: 'main', ...parseReps(reps) };
    if (tech) it.tech = tech;
    if (ss || opts.circuit) it.ss = true;
    if (opts.circuit) it.rest = 20;
    r.items.push(it);
  });
  if (opts.circuit) { const mains = r.items.filter((i) => i.phase === 'main'); mains[mains.length - 1].ss = false; mains[mains.length - 1].rest = 90; }
  r.items.push(...mobilityItems(COOL[focus] || COOL.full, 'cooldown'));
  return r;
}
function addWarmCool(r) {
  const focus = r.focus || guessFocus(r);
  const hasW = r.items.some((i) => i.phase === 'warmup'), hasC = r.items.some((i) => i.phase === 'cooldown');
  if (!hasW) r.items.unshift(...mobilityItems(WARM[focus], 'warmup'));
  if (!hasC) r.items.push(...mobilityItems(COOL[focus], 'cooldown'));
  r.focus = focus;
}
function guessFocus(r) {
  const ms = r.items.map((i) => getEx(i.exId)).filter((e) => e.type !== 'mobility');
  const lower = ms.filter((e) => ['quads', 'hamstrings', 'glutes', 'calves', 'adductors'].includes(e.muscle)).length;
  const core = ms.filter((e) => ['abs', 'obliques'].includes(e.muscle)).length;
  const cardio = ms.filter((e) => e.type === 'cardio').length;
  if (cardio && cardio >= ms.length / 2) return 'cardio';
  if (core >= ms.length / 2) return 'core';
  if (lower >= ms.length * 0.6) return 'lower';
  if (lower <= ms.length * 0.2) return 'upper';
  return 'full';
}
function programScore(p) {
  const d = details(); let s = 0;
  if (p.goal.includes(d.goal)) s += 3;
  if (p.level === d.level) s += 2; else if (d.level === 'beginner' && p.level === 'advanced') s -= 3;
  if (p.days === +d.sessionsPerWeek) s += 3; else s -= Math.abs(p.days - d.sessionsPerWeek);
  if (S.settings.owned.length && p.equip === 'gym' && !S.settings.owned.includes('barbell')) s -= 2;
  const conds = activeConditions();
  if (p.id === 'hiit' && (lowImpact() || conds.includes('knee') || conds.includes('ankle') || conds.includes('heart'))) s -= 5;
  if ((p.id === 'str4' || p.id === '5x5') && (conds.includes('heart') || conds.includes('lowerback') || recentSurgery())) s -= 4;
  if (p.id === 'landmine' && (conds.includes('shoulder') || conds.includes('lowerback'))) s += 2;
  return s;
}
function programsSheet() {
  const st = { goal: '', days: '', equip: '' };
  openSheet({
    title: 'Program library', st,
    render: () => {
      const recs = [...PROGRAMS].sort((a, b) => programScore(b) - programScore(a));
      const top = recs.slice(0, 2).map((p) => p.id);
      const list = recs.filter((p) => (!st.goal || p.goal.includes(st.goal)) && (!st.days || p.days === +st.days) && (!st.equip || p.equip === st.equip));
      const chip = (k, v, l) => `<button class="chip ${st[k] === v ? 'on' : ''}" data-act="progFilter" data-k="${k}" data-v="${v}">${l}</button>`;
      return `<p class="small muted">Proven routines, each with a warm-up and a cool-down. Recommended picks are based on your profile (${esc(GOALS[details().goal])}, ${details().sessionsPerWeek} days/week, ${details().level}).</p>
        <div class="chips">${chip('goal', '', 'Any goal')}${Object.entries({ strength: 'Strength', hypertrophy: 'Muscle', fatloss: 'Fat loss', general: 'General' }).map(([k, v]) => chip('goal', k, v)).join('')}</div>
        <div class="chips">${chip('days', '', 'Any days')}${[2, 3, 4, 5, 6].map((n) => chip('days', String(n), `${n} days`)).join('')}</div>
        <div class="chips">${chip('equip', '', 'Any equipment')}${Object.entries(EQUIP_LABEL).map(([k, v]) => chip('equip', k, v)).join('')}</div>
        ${list.map((p) => `<button class="card" style="width:100%;border:0;text-align:left;display:block" data-act="progPreview" data-id="${p.id}"><div class="row between"><b>${esc(p.name)}</b>${top.includes(p.id) ? `<span class="tag accent">${ico('star', 'xs')} For you</span>` : ''}</div><div class="small muted mt">${esc(p.desc)}</div><div class="row wrap mt" style="gap:4px"><span class="tag">${p.days}×/week</span><span class="tag">~${p.minutes} min</span><span class="tag">${p.level}</span><span class="tag">${EQUIP_LABEL[p.equip]}</span><span class="tag">${PROG[p.prog] || 'Free'}</span></div></button>`).join('') || '<div class="empty">No programs match those filters.</div>'}`;
    }
  });
}
function programPreview(id) {
  const p = PROGRAMS.find((x) => x.id === id);
  openSheet({
    title: p.name,
    render: () => {
      const days = Object.entries(p.sched).map(([d, i]) => `${DOW[d]}: ${p.routines[i][0]}`).join(' · ');
      return `<p class="small">${esc(p.desc)}</p><div class="small muted">${days}</div>
        ${p.routines.map(([name, focus, items, opts]) => `<div class="card"><b>${esc(name)}</b>${opts && opts.circuit ? ' <span class="tag accent">circuit</span>' : ''}<div class="tiny faint mt">Warm-up: ${(WARM[focus] || []).map((w) => w[0]).filter((n) => exByName(n)).join(', ')}</div>${items.map(([n, sets, reps, tech, ss]) => { const ex = exByName(n); return ex ? `<div class="row" style="margin-top:8px">${thumb(ex, 'sm')}<div class="grow"><div>${esc(n)} ${ss ? '<span class="tag accent">superset ↓</span>' : ''}</div><div class="sub small muted">${sets} × ${reps}${tech ? ` · last set: <span class="accent">${TECH[tech].name}</span>` : ''}</div></div></div>` : ''; }).join('')}<div class="tiny faint mt">Cool-down: ${(COOL[focus] || []).map((w) => w[0]).join(', ')}</div></div>`).join('')}
        ${(() => { const ch = []; for (const [name, focus, items, opts] of p.routines) { const r = buildRoutine(name, focus, items, p.prog, opts); ch.push(...adaptRoutine(r)); } return ch.length ? `<div class="card" style="background:color-mix(in srgb,#64d2ff 12%,var(--card))"><b>${ico('shield', 'xs')} Adjusted for you</b>${ch.map((c) => `<div class="small mt">${c.from === c.to ? `<s>${esc(getEx(c.from).name)}</s>` : `${esc(getEx(c.from).name)} → <b>${esc(getEx(c.to).name)}</b>`} <span class="muted">(${esc(c.why)})</span></div>`).join('')}</div>` : ''; })()}
        <button class="btn primary block" data-act="progApply" data-id="${p.id}">Add program & set my week</button><p class="tiny faint">Adds ${p.routines.length} routine${p.routines.length > 1 ? 's' : ''} and fills the matching days of your weekly plan. Everything stays editable.</p>`;
    }
  });
}
function applyProgram(id, silent) {
  const p = PROGRAMS.find((x) => x.id === id), ids = [];
  let adj = 0;
  for (const [name, focus, items, opts] of p.routines) { const r = buildRoutine(name, focus, items, p.prog === 'none' ? 'none' : p.prog, opts); adj += adaptRoutine(r).length; S.routines.push(r); ids.push(r.id); }
  for (const d in p.sched) S.plan.days[d] = ids[p.sched[d]];
  save('routines', 'plan');
  if (!silent) { closeAllSheets(); toast(`Added ${p.name}${adj ? ` — ${adj} exercise${adj > 1 ? 's' : ''} swapped for your injuries` : ''}`, 3500); go('plan'); }
}

/* ======================= Exercise rotation (training blocks) ======================= */
const SCHEMES = [
  { id: 'hyp', name: 'Hypertrophy', comp: [3, 8, 12], iso: [3, 10, 15], tech: null, note: 'Moderate weights, 8–15 reps: the classic muscle-building zone.' },
  { id: 'str', name: 'Strength', comp: [4, 4, 6], iso: [3, 8, 10], tech: null, note: 'Heavier weights and fewer reps on the big lifts to build raw strength.' },
  { id: 'met', name: 'Metabolic', comp: [3, 10, 15], iso: [3, 15, 20], tech: 'drop', note: 'Lighter weights, higher reps and drop sets on isolation moves: a different stimulus and a joint-friendly break.' }
];
function routineBlock(r) { if (!r.block) r.block = { start: r.created || (S.workouts.filter((w) => w.routineId === r.id).pop()?.start) || Date.now(), n: 1, scheme: 'hyp' }; return r.block; }
function rotationDue(r) {
  const d = details(); if (!d.rotate || r.noRotate) return false;
  const b = routineBlock(r); if (b.snooze && b.snooze > Date.now()) return false;
  const done = S.workouts.filter((w) => w.routineId === r.id && w.start >= b.start).length;
  return Date.now() - b.start >= d.rotateWeeks * 7 * DAY && done >= 3;
}
function planRotation(r) {
  const b = routineBlock(r), idx = SCHEMES.findIndex((x) => x.id === b.scheme);
  let next = SCHEMES[(idx + 1) % SCHEMES.length];
  if (next.id === 'str' && activeConditions().some((k) => CONDS[k].noHeavy)) next = SCHEMES[(idx + 2) % SCHEMES.length];
  const used = new Set(r.items.map((i) => i.exId)), prevUsed = new Set(b.prev || []), owned = S.settings.owned;
  const anchor = r.items.findIndex((i) => (i.phase || 'main') === 'main' && ['barbell', 'trapbar'].includes(getEx(i.exId).equipment) && COMPOUND.has(PATTERN_OF[i.exId]) && !riskOf(i.exId));
  const changes = r.items.map((it, i) => {
    const ex = getEx(it.exId);
    if ((it.phase || 'main') !== 'main' || ['mobility', 'cardio'].includes(ex.type)) return { i, from: it.exId, to: it.exId, skip: true };
    const pat = PATTERN_OF[it.exId]; let to = it.exId;
    if (pat && i !== anchor) {
      const sameEq = (e) => (ex.equipment === 'landmine' ? e.equipment === 'landmine' : true);
      const cands = PATTERNS[pat].map(exByName).filter((e) => e && e.id !== it.exId && e.type === ex.type && !used.has(e.id) && sameEq(e) && riskOf(e.id)?.level !== 'avoid' && (!owned.length || ['bodyweight', 'other'].includes(e.equipment) || owned.includes(e.equipment)));
      const safe = cands.filter((e) => !riskOf(e.id)), base = safe.length ? safe : cands;
      const fresh = base.filter((e) => !prevUsed.has(e.id)), pool = fresh.length ? fresh : base;
      if (pool.length) { to = pool[(b.n * 7 + i) % pool.length].id; used.add(to); }
    }
    return { i, from: it.exId, to, anchor: i === anchor };
  });
  return { next, changes };
}
function applyRotation(r, plan) {
  const b = routineBlock(r);
  r.history = (r.history || []).concat([{ date: Date.now(), items: clone(r.items), block: clone(b) }]).slice(-6);
  plan.changes.forEach((c) => {
    if (c.skip) return;
    const it = r.items[c.i], ex = getEx(c.to);
    if (c.to !== it.exId) { it.exId = c.to; it.inc = undefined; }
    if (ex.type === 'weight' || ex.type === 'assisted') {
      const comp = COMPOUND.has(PATTERN_OF[c.to]), [sets, lo, hi] = comp ? plan.next.comp : plan.next.iso;
      it.sets = Math.max(sets, Math.min(it.sets || sets, sets + 1)); it.repMin = lo; it.repMax = hi;
      if (!comp) it.tech = plan.next.tech || (it.tech === 'drop' ? undefined : it.tech);
    }
  });
  r.block = { start: Date.now(), n: b.n + 1, scheme: plan.next.id, prev: plan.changes.filter((c) => !c.skip).map((c) => c.from) };
  save('routines');
}
function rotationSheet(id, startAfter) {
  const r = S.routines.find((x) => x.id === id); const plan = planRotation(r); const b = routineBlock(r);
  const weeks = Math.max(1, Math.round((Date.now() - b.start) / (7 * DAY)));
  openSheet({
    title: 'New training block',
    render: () => {
      const swaps = plan.changes.filter((c) => !c.skip);
      return `<div class="card block-card"><div class="small muted">${esc(r.name)} · block ${b.n} → ${b.n + 1}</div><div class="big">Time to mix it up</div><p class="small mb0">You've run these exercises for ${weeks} week${weeks > 1 ? 's' : ''}. Your muscles adapt to the same movements, so progress slows. New angles and a new rep range restart progress and spread the stress on your joints.</p></div>
        <div class="card"><b>Next focus: ${plan.next.name}</b><div class="small muted">${plan.next.note}</div></div>
        <div class="card">${swaps.map((c) => { const a = getEx(c.from), z = getEx(c.to); return `<div class="swap">${thumb(z, 'sm')}<div class="grow">${c.from === c.to ? `<b>${esc(a.name)}</b><div class="tiny muted">${c.anchor ? 'Main lift kept — new rep range' : 'No better alternative — new rep range'}</div>` : `<span class="muted">${esc(a.name)}</span> <span class="arrow">→</span> <b>${esc(z.name)}</b>`}</div></div>`; }).join('')}</div>
        <button class="btn primary block" data-act="rotApply" data-id="${id}" data-s="${startAfter ? 1 : ''}">Start block ${b.n + 1}</button>
        <div class="grid2 mt"><button class="btn" data-act="rotSnooze" data-id="${id}" data-s="${startAfter ? 1 : ''}">Remind me in 2 weeks</button><button class="btn" data-act="rotNever" data-id="${id}" data-s="${startAfter ? 1 : ''}">Never for this routine</button></div>
        <p class="tiny faint">Warm-up and cool-down stay the same. You can undo a rotation from the routine editor.</p>`;
    },
    _plan: plan
  });
}

/* ======================= Monthly challenges & nudges ======================= */
function challenges() {
  const now = new Date(), mStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const W = S.workouts.filter((w) => w.start >= mStart);
  const target = Math.round(details().sessionsPerWeek * 4.3);
  let prs = 0; W.forEach((w) => { prs += workoutPRs(w).length; });
  const before = new Set(S.workouts.filter((w) => w.start < mStart).flatMap((w) => w.entries.map((e) => e.exId)));
  const newEx = new Set(W.flatMap((w) => w.entries.map((e) => e.exId)).filter((id) => !before.has(id) && !isMob(id))).size;
  const warmed = W.filter((w) => w.entries.some((e) => isMob(e.exId))).length;
  const weighIns = S.body.filter((b) => b.date >= mStart).length;
  return { month: now.toLocaleDateString(undefined, { month: 'long' }), list: [
    ['lift', `${target} workouts this month`, W.length, target],
    ['trophy', 'Hit 6 personal records', prs, 6],
    ['compass', 'Try 2 exercises you’ve never done', newEx, 2],
    ['stretch', 'Warm up or stretch in 8 sessions', warmed, 8],
    ['scale', 'Weigh in 8 times', weighIns, 8]
  ] };
}
function neglected() {
  const st = muscleStrength(), out = [];
  for (const m of ['chest', 'lats', 'upperback', 'frontdelts', 'quads', 'hamstrings', 'glutes', 'biceps', 'triceps', 'abs']) {
    const last = st[m].last; if (last && Date.now() - last > 9 * DAY) out.push([m, Math.floor((Date.now() - last) / DAY)]);
  }
  return out.sort((a, b) => b[1] - a[1]);
}

/* ======================= Profile PIN (privacy lock for shared phones) ======================= */
async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(salt + ':' + pin);
  if (crypto.subtle) { const h = await crypto.subtle.digest('SHA-256', data); return b64url(new Uint8Array(h)); }
  let x = 0; for (const c of data) x = (x * 31 + c) >>> 0; return 'w' + x; // non-HTTPS fallback (dev only)
}
function pinSheet(p, onOk) {
  const st = { v: '', err: '' };
  openSheet({
    title: `${p.name}'s PIN`, st, cancel: 'Cancel',
    render: () => `<div class="center">${avatar(p, 'lg')}<p class="muted small">Enter PIN to open this profile</p></div><input class="input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" data-oninput="pinV" style="font-size:1.6rem;text-align:center;letter-spacing:8px" id="pinbox">${st.err ? `<p class="small bad center">${st.err}</p>` : ''}<button class="btn primary block mt" data-act="pinCheck">Unlock</button>`,
    after: () => setTimeout(() => $('#pinbox')?.focus(), 50),
    check: async () => {
      const h = await hashPin(st.v, p.pin.salt);
      if (h === p.pin.hash) { closeSheet(); onOk(); } else { st.err = 'Wrong PIN'; st.v = ''; refreshSheet(); }
    }
  });
}
function openProfile(id) {
  const p = PROFILES.find((x) => x.id === id); if (!p) return;
  if (p.pin && p.pin.hash && id !== PID) pinSheet(p, () => loadProfile(id)); else loadProfile(id);
}

/* ======================= Data safety ======================= */
const SCHEMA = 2;
/* Keeps imported/old data well-formed so a bad file can never break the app. */
function sanitizeData(o) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
  const n = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const out = {};
  out.workouts = arr(o.workouts).filter((w) => w && typeof w === 'object' && n(w.start)).map((w) => ({
    id: str(w.id, 80) || uid(), start: n(w.start), end: n(w.end) || n(w.start), routineId: str(w.routineId, 80) || null, name: str(w.name) || 'Workout', notes: str(w.notes, 4000),
    entries: arr(w.entries).filter((e) => e && typeof e.exId === 'string').map((e) => ({ id: str(e.id, 80) || uid(), exId: str(e.exId, 120), ss: str(e.ss, 80) || null, note: str(e.note, 1000), phase: ['warmup', 'main', 'cooldown'].includes(e.phase) ? e.phase : undefined, dbMode: DB_MODES[e.dbMode] ? e.dbMode : undefined,
      sets: arr(e.sets).filter((s) => s && typeof s === 'object').map((s) => ({ id: str(s.id, 80) || uid(), w: n(s.w), r: n(s.r), t: n(s.t), d: n(s.d), eff: s.eff && n(s.eff.v) != null ? { v: n(s.eff.v), scale: s.eff.scale === 'rir' ? 'rir' : 'rpe' } : null, warm: !!s.warm, done: s.done !== false, tech: TECH[s.tech] ? s.tech : undefined })) }))
  }));
  out.routines = arr(o.routines).filter((r) => r && r.id && Array.isArray(r.items)).map((r) => ({ ...r, id: str(r.id, 80), name: str(r.name) || 'Routine', prog: PROG[r.prog] ? r.prog : 'double', items: r.items.filter((i) => i && typeof i.exId === 'string') }));
  out.custom = arr(o.custom).filter((c) => c && typeof c.id === 'string' && c.id.startsWith('c:')).map((c) => ({ id: c.id.slice(0, 80), name: str(c.name) || 'Custom', muscle: MUSCLES[c.muscle] ? c.muscle : 'abs', secondary: arr(c.secondary).filter((m) => MUSCLES[m]), equipment: EQUIPMENT[c.equipment] ? c.equipment : 'other', type: TYPES[c.type] ? c.type : 'weight', notes: str(c.notes, 2000), link: /^https?:\/\//i.test(c.link || '') ? str(c.link, 500) : '' }));
  out.body = arr(o.body).filter((b) => b && n(b.date) && n(b.kg)).map((b) => ({ id: str(b.id, 80) || uid(), date: b.date, kg: b.kg }));
  out.measures = arr(o.measures).filter((m) => m && n(m.date)).map((m) => { const x = { id: str(m.id, 80) || uid(), date: m.date }; ['waist', 'chest', 'hips', 'arm', 'thigh', 'calf', 'neck', 'bodyfat'].forEach((k) => { x[k] = n(m[k]); }); return x; });
  out.scans = arr(o.scans).filter((x) => x && n(x.date)).map((x) => { const y = { id: str(x.id, 80) || uid(), date: x.date, device: str(x.device, 60), photo: typeof x.photo === 'string' && x.photo.startsWith('data:image/') && x.photo.length < 3e6 ? x.photo : null }; SCAN_FIELDS.forEach(([k]) => { y[k] = n(x[k]); }); return y; });
  if (o.plan && typeof o.plan === 'object') out.plan = { days: { ...(o.plan.days || {}) }, overrides: { ...(o.plan.overrides || {}) } };
  if (o.settings && typeof o.settings === 'object') { out.settings = {}; for (const k in DEFAULTS) if (k in o.settings && typeof o.settings[k] === typeof DEFAULTS[k] || (k === 'bwGoal' && n(o.settings[k]))) out.settings[k] = o.settings[k]; }
  if (o.profile && typeof o.profile === 'object') out.profile = { name: str(o.profile.name, 40) || 'Imported', color: /^#[0-9a-f]{6}$/i.test(o.profile.color || '') ? o.profile.color : '#888888', details: { ...DEFAULT_DETAILS, ...(typeof o.profile.details === 'object' ? o.profile.details : {}) } };
  return out;
}
/* Before any data-format upgrade, keep an untouched copy of everything. */
async function snapshotBeforeUpgrade(fromVersion) {
  const keys = ['profiles', 'lastProfile', ...KEYS];
  const snap = { at: Date.now(), fromVersion };
  for (const k of keys) snap[k] = await Store.get(k);
  for (const p of PROFILES) for (const k of KEYS) snap[`${p.id}:${k}`] = await Store.get(`${p.id}:${k}`);
  await Store.set(`snapshot:v${fromVersion}`, snap);
}


/* ======================= Health: injuries, conditions, body composition ======================= */
const CONDS = window.CONDITIONS || {};
function activeConditions() {
  const d = details(), set = new Set((d.injuries || []).filter((k) => CONDS[k]));
  for (const s of d.surgeries || []) if (s.area && CONDS[s.area] && (!s.date || Date.now() - parseKey(s.date).getTime() < 26 * 7 * DAY)) set.add(s.area);
  return [...set];
}
function recentSurgery() { return (details().surgeries || []).find((s) => s.date && Date.now() - parseKey(s.date).getTime() < 12 * 7 * DAY); }
function bmiNow() { const bw = latestBW(), h = details().heightCm; return bw && h ? bw / ((h / 100) ** 2) : null; }
function ageNow() { const y = details().birthYear; return y ? new Date().getFullYear() - y : null; }
function lowImpact() { const b = bmiNow(), a = ageNow(); return (b && b >= 32) || (a && a >= 55); }
let _riskCache = { key: '', map: {} };
function riskMap() {
  const conds = activeConditions(), li = lowImpact(), key = conds.join(',') + '|' + li;
  if (_riskCache.key === key) return _riskCache.map;
  const map = {};
  const add = (name, level, label, tip) => {
    const ex = exByName(name); if (!ex) return;
    const cur = map[ex.id] || (map[ex.id] = { level, reasons: [], tips: [] });
    if (level === 'avoid') cur.level = 'avoid';
    if (!cur.reasons.includes(label)) cur.reasons.push(label);
    if (tip && !cur.tips.includes(tip)) cur.tips.push(tip);
  };
  for (const k of conds) { const c = CONDS[k]; c.avoid.forEach((n) => add(n, 'avoid', c.label, c.tip)); c.caution.forEach((n) => add(n, 'caution', c.label, c.tip)); }
  if (li) (window.LOW_IMPACT_AVOID || []).forEach((n) => add(n, 'avoid', 'low-impact', 'High-impact jumping is swapped for joint-friendly options.'));
  _riskCache = { key, map };
  return map;
}
const riskOf = (exId) => riskMap()[exId] || null;
const preferred = () => new Set(activeConditions().flatMap((k) => CONDS[k].prefer.map((n) => exByName(n)?.id).filter(Boolean)));
function safeAlternative(exId, used = new Set()) {
  const ex = getEx(exId), pat = PATTERN_OF[exId], pref = preferred(), owned = S.settings.owned;
  const ok = (e) => e && e.id !== exId && !used.has(e.id) && riskOf(e.id)?.level !== 'avoid' && (!owned.length || ['bodyweight', 'other'].includes(e.equipment) || owned.includes(e.equipment));
  let c = pat ? PATTERNS[pat].map(exByName).filter((e) => ok(e) && e.type === ex.type) : [];
  if (!c.length) c = EX_LIST.filter((e) => ok(e) && e.type === ex.type && e.muscle === ex.muscle && !e.custom);
  if (!c.length && ex.type !== 'mobility') c = EX_LIST.filter((e) => ok(e) && e.muscle === ex.muscle && e.type !== 'mobility' && !e.custom);
  if (!c.length && ex.type === 'mobility') c = EX_LIST.filter((e) => ok(e) && e.type === 'mobility' && (e.muscle === ex.muscle || ex.secondary.includes(e.muscle)));
  c.sort((a, b) => (pref.has(b.id) ? 1 : 0) - (pref.has(a.id) ? 1 : 0) || (riskOf(a.id) ? 1 : 0) - (riskOf(b.id) ? 1 : 0));
  return c[0] || null;
}
function noTechs() { return new Set(activeConditions().flatMap((k) => CONDS[k].noTech || [])); }
/* Make a routine safe for this person's injuries/conditions. Returns a list of changes. */
function adaptRoutine(r) {
  const changes = [], used = new Set(r.items.map((i) => i.exId)), nt = noTechs(), heavy = activeConditions().some((k) => CONDS[k].noHeavy);
  const drop = [];
  r.items.forEach((it, idx) => {
    const rk = riskOf(it.exId);
    if (rk && rk.level === 'avoid') {
      const alt = safeAlternative(it.exId, used);
      if (alt) { changes.push({ from: it.exId, to: alt.id, why: rk.reasons.join(', ') }); used.add(alt.id); it.exId = alt.id; it.inc = undefined; }
      else if (isMob(it.exId)) { changes.push({ from: it.exId, to: it.exId, why: rk.reasons.join(', ') + ' — removed' }); drop.push(idx); }
    }
    if (it.tech && nt.has(it.tech)) { it.tech = 'tempo'; }
    if (heavy && it.repMin && it.repMin < 6) { it.repMin = 6; it.repMax = Math.max(it.repMax || 8, 8); }
  });
  drop.reverse().forEach((i) => r.items.splice(i, 1));
  if (recentSurgery()) r.items.forEach((it) => { if (it.sets > 2 && (it.phase || 'main') === 'main') it.sets -= 1; });
  if (changes.length) r.adjusted = (r.adjusted || []).concat(changes.map((c) => ({ ...c, date: Date.now() })));
  return changes;
}
function healthBanner() {
  const conds = activeConditions(), srg = recentSurgery();
  const notes = details().healthNotes;
  if (!conds.length && !srg && !lowImpact()) return notes ? `<div class="banner" style="background:color-mix(in srgb,#64d2ff 13%,var(--card))">${ico('shield', 'xs')} ${esc(notes)}</div>` : '';
  const names = conds.map((k) => ico('body', 'xs', k) + ' ' + CONDS[k].label.toLowerCase());
  return `<div class="banner" style="background:color-mix(in srgb,#64d2ff 13%,var(--card))">${ico('shield', 'xs')} Training adapted for ${names.length ? names.join(', ') : ''}${names.length && lowImpact() ? ' and ' : ''}${lowImpact() ? 'low impact' : ''}.${srg ? ` <b>Recent surgery (${esc(CONDS[srg.area]?.label || srg.area)}):</b> follow your surgeon's or physio's plan first and get clearance before lifting.` : ''} ${notes ? ' ' + esc(notes) + '.' : ''} <span class="muted">Forge isn't medical advice: if something hurts, stop.</span></div>`;
}
function riskNote(exId, ei) {
  const rk = riskOf(exId); if (!rk) return '';
  const alt = rk.level === 'avoid' ? safeAlternative(exId, new Set(S.active ? S.active.entries.map((e) => e.exId) : [])) : null;
  return `<div class="coach" style="background:color-mix(in srgb,${rk.level === 'avoid' ? 'var(--bad)' : '#64d2ff'} 14%,var(--card2))">${rk.level === 'avoid' ? ico('stop', 'xs bad') : ico('warning', 'xs warn')} <b style="color:inherit">${rk.level === 'avoid' ? 'Not recommended' : 'Take care'}</b> with your ${esc(rk.reasons.join(', '))}. <span class="small">${esc(rk.tips[0] || '')}</span>${alt && ei != null ? `<div class="row"><button class="btn sm primary" data-act="swapSafe" data-e="${ei}" data-id="${alt.id}">Swap to ${esc(alt.name)}</button></div>` : ''}</div>`;
}

/* ---------- Body-composition scans (smart scale / InBody-style printouts) ---------- */
const SCAN_FIELDS = [
  ['kg', 'Weight', 'w'], ['bmi', 'BMI', ''], ['fat', 'Body fat', '%'], ['muscle', 'Muscle mass', 'w'], ['smm', 'Skeletal muscle', 'w'],
  ['visceral', 'Visceral fat', 'lvl'], ['water', 'Body water', '%'], ['bone', 'Bone mass', 'w'], ['protein', 'Protein', '%'], ['bmr', 'BMR', 'kcal'], ['metAge', 'Metabolic age', 'yrs']
];
const LOWER_IS_BETTER = new Set(['fat', 'visceral', 'metAge']);
const HIGHER_IS_BETTER = new Set(['muscle', 'smm', 'water', 'protein', 'bone']);
const scanVal = (f, v) => (v == null ? '–' : f[2] === 'w' ? `${num(toU(v), 1)} ${U()}` : `${num(v, 1)}${f[2] && f[2] !== 'lvl' ? (f[2] === '%' ? '%' : ' ' + f[2]) : ''}`);
function bmiCategory(b) { return b < 18.5 ? 'Underweight' : b < 25 ? 'Healthy range' : b < 30 ? 'Overweight' : 'Obese range'; }
function scanSheet(id) {
  const ex = id ? S.scans.find((x) => x.id === id) : null;
  const st = { d: dkey(ex ? ex.date : Date.now()), v: {}, photo: ex ? ex.photo || null : null, device: ex ? ex.device || '' : '' };
  SCAN_FIELDS.forEach(([k, , u]) => { const v = ex ? ex[k] : null; st.v[k] = v == null ? '' : u === 'w' ? num(toU(v), 1) : num(v, 1); });
  if (!ex && latestBW()) st.v.kg = num(toU(latestBW()), 1);
  openSheet({
    title: ex ? 'Body scan' : 'New body scan', st,
    right: { label: 'Save', fn: () => {
      const s = ex || { id: uid() }; s.date = parseKey(st.d).getTime() + 9 * 3600e3; s.photo = st.photo; s.device = st.device.slice(0, 60);
      SCAN_FIELDS.forEach(([k, , u]) => { const v = pnum(st.v[k]); s[k] = v == null ? null : u === 'w' ? fromU(v) : v; });
      if (s.bmi == null && s.kg && details().heightCm) s.bmi = +(s.kg / ((details().heightCm / 100) ** 2)).toFixed(1);
      if (!ex) S.scans.push(s);
      if (s.kg && !S.body.some((b) => dkey(b.date) === st.d)) S.body.push({ id: uid(), date: s.date, kg: s.kg });
      save('scans', 'body'); closeSheet(); render(); toast('Scan saved');
    } },
    render: () => `<p class="small muted">Type the numbers from your smart scale or body-composition printout (InBody, Tanita, Omron…). Leave blank whatever your device doesn't show. Attach a photo of the printout to keep it with the reading.</p>
      <div class="grid2"><div class="field"><label>Date</label><input class="input" type="date" data-oninput="std" value="${st.d}"></div><div class="field"><label>Device (optional)</label><input class="input" data-oninput="scanDev" value="${esc(st.device)}" placeholder="e.g. InBody 270"></div></div>
      <div class="grid2">${SCAN_FIELDS.map(([k, l, u]) => `<div class="field"><label>${l}${u ? ` (${u === 'w' ? U() : u})` : ''}</label><input class="input" inputmode="decimal" data-oninput="scanV" data-k="${k}" value="${esc(st.v[k])}" ${k === 'bmi' ? `placeholder="${details().heightCm ? 'auto from height' : ''}"` : ''}></div>`).join('')}</div>
      <div class="field"><label>Printout photo</label>${st.photo ? `<img src="${st.photo}" alt="Scan printout" style="width:100%;border-radius:12px;margin-bottom:8px">` : ''}<div class="row"><label class="btn sm" style="position:relative;overflow:hidden">${st.photo ? 'Replace photo' : `${ico('camera', 'xs')} Add photo`}<input type="file" accept="image/*" data-on="scanPhoto" style="position:absolute;inset:0;opacity:0"></label>${st.photo ? '<button class="btn sm danger" data-act="scanPhotoDel">Remove</button>' : ''}</div><div class="tiny faint">Photos are shrunk and stored only on this phone.</div></div>
      ${ex ? `<button class="btn danger block" data-act="delScan" data-id="${ex.id}">Delete reading</button>` : ''}`
  });
}
function shrinkImage(file, max = 1100) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.72)); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read image')); };
    img.src = url;
  });
}
function scansHTML() {
  const sc = [...S.scans].sort((a, b) => a.date - b.date);
  const b = bmiNow();
  let h = `<div class="row between mt"><h3 style="margin:0">Body composition</h3><button class="btn sm primary" data-act="addScan">+ Scan</button></div>`;
  if (b) h += `<div class="card mt"><div class="row between"><div><div class="small muted">BMI (from your latest weight & height)</div><div class="big">${num(b, 1)}</div></div><span class="tag ${b >= 18.5 && b < 25 ? '' : 'accent'}">${bmiCategory(b)}</span></div><div class="tiny faint">BMI can't tell muscle from fat, so for lifters body-fat % and waist are better guides.</div></div>`;
  else h += `<div class="card mt small muted">Add your height in <a href="#" data-act="editProfile" class="accent">My details</a> to see your BMI.</div>`;
  if (!sc.length) return h + `<div class="card small muted">Log readings from a smart scale or a body-composition scan (body fat, muscle mass, visceral fat…) to see how they change over time.</div>`;
  const last = sc[sc.length - 1], prev = sc[sc.length - 2], first = sc[0];
  const key = UI.scanKey || 'fat';
  h += `<div class="card mt"><div class="small muted">Latest · ${fmtDate(last.date)}${last.device ? ' · ' + esc(last.device) : ''}${prev ? ` · vs ${fmtDate(prev.date, { day: 'numeric', month: 'short' })}` : ''}</div><div class="bars">${SCAN_FIELDS.filter(([k]) => last[k] != null).map((f) => {
    const [k, l] = f; const d = prev && prev[k] != null ? last[k] - prev[k] : null;
    const good = d == null || Math.abs(d) < 1e-9 ? 'muted' : LOWER_IS_BETTER.has(k) ? (d < 0 ? 'good' : 'bad') : HIGHER_IS_BETTER.has(k) ? (d > 0 ? 'good' : 'bad') : 'muted';
    return `<div class="b"><div class="n">${l}</div><div class="grow">${scanVal(f, last[k])}</div><div class="v small ${good}" style="width:70px">${d == null ? '' : (d > 0 ? '+' : '') + (f[2] === 'w' ? num(toU(d), 1) : num(d, 1))}</div></div>`;
  }).join('')}</div>${first !== last ? `<div class="tiny faint">Since first scan (${fmtDate(first.date, { day: 'numeric', month: 'short', year: 'numeric' })}): ${SCAN_FIELDS.filter(([k]) => first[k] != null && last[k] != null && ['fat', 'muscle', 'visceral', 'kg'].includes(k)).map((f) => { const d = last[f[0]] - first[f[0]]; return `${f[1]} ${d > 0 ? '+' : ''}${f[2] === 'w' ? num(toU(d), 1) : num(d, 1)}`; }).join(' · ')}</div>` : ''}</div>`;
  const avail = SCAN_FIELDS.filter(([k]) => sc.filter((s) => s[k] != null).length >= 1);
  h += `<div class="chips">${avail.map(([k, l]) => `<button class="chip ${key === k ? 'on' : ''}" data-act="scanKey" data-v="${k}">${l}</button>`).join('')}</div>`;
  const f = SCAN_FIELDS.find((x) => x[0] === key) || avail[0];
  if (f) h += `<div class="card">${lineChart(sc.filter((s) => s[f[0]] != null).map((s) => ({ x: s.date, y: f[2] === 'w' ? toU(s[f[0]]) : s[f[0]] })))}</div>`;
  h += `<div class="list">${[...sc].reverse().slice(0, 12).map((s) => `<button class="list-item" data-act="editScan" data-id="${s.id}">${s.photo ? `<img class="thumb sm" src="${s.photo}" alt="">` : `<div class="thumb sm" style="display:flex;align-items:center;justify-content:center">${ico('chart', 'sm accent')}</div>`}<div class="grow"><div>${fmtDate(s.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div><div class="sub">${[s.kg != null ? fmtW(s.kg) : '', s.fat != null ? num(s.fat, 1) + '% fat' : '', s.muscle != null ? fmtW(s.muscle) + ' muscle' : ''].filter(Boolean).join(' · ')}</div></div><span class="chev">›</span></button>`).join('')}</div>`;
  return h;
}

/* ======================= Actions (click) ======================= */
const A = {};
A.sheetClose = () => closeSheet();
A.sheetRight = () => { const d = sheets[sheets.length - 1]; if (d && d.right) d.right.fn(); };
A.confirmYes = () => { const d = sheets[sheets.length - 1]; if (d && d.yes) d.yes(); };
A.openSettings = () => settingsSheet();
A.goWorkout = () => go('workout');
A.goMuscles = () => { UI.statsTab = 'muscles'; UI.muscleMode = 'fatigue'; go('stats'); };
A.startRoutine = (d) => startWorkout(d.id);
A.startEmpty = () => startWorkout(null);
A.pickRoutineToStart = () => openSheet({ title: 'Start a routine', render: () => `<div class="list">${S.routines.map((r) => `<button class="list-item" data-act="startRoutine" data-id="${r.id}"><div class="grow">${esc(r.name)}<div class="sub">${r.items.length} exercises</div></div><span class="accent small">Start</span></button>`).join('')}</div>` });
A.logPast = () => {
  const st = { d: dkey(Date.now() - DAY), t: '18:00', r: '' };
  openSheet({
    title: 'Log a past workout', st,
    right: { label: 'Next', fn: () => { const [hh, mm] = st.t.split(':').map(Number); const start = parseKey(st.d).getTime() + (hh * 60 + mm) * 6e4; closeSheet(); startWorkout(st.r || null, { past: true, start }); } },
    render: () => `<div class="grid2"><div class="field"><label>Date</label><input class="input" type="date" data-oninput="lpD" value="${st.d}"></div><div class="field"><label>Start time</label><input class="input" type="time" data-oninput="lpT" value="${st.t}"></div></div><div class="field"><label>Based on routine</label><select class="input" data-oninput="lpR"><option value="">Empty</option>${S.routines.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div><p class="tiny faint">Sets will be pre-marked as done. Adjust them, then tap Save.</p>`
  });
};
A.moreHistory = () => { UI.histLimit += 40; render(); };
A.workoutMenu = () => openSheet({
  title: 'Workout',
  render: () => `<div class="list"><button class="list-item" data-act="startRestManual"><div class="grow">Start rest timer</div></button><button class="list-item" data-act="plateCalc"><div class="grow">Plate calculator</div></button><button class="list-item" data-act="oneRmCalc"><div class="grow">1RM calculator</div></button><button class="list-item" data-act="reorderMode"><div class="grow">Reorder exercises</div></button></div><button class="btn danger block" data-act="discardWorkout">${S.active?.editing ? 'Discard changes' : 'Discard workout'}</button>`
});
A.startRestManual = () => { S.active.rest = { end: Date.now() + S.settings.rest * 1000, total: S.settings.rest, label: '' }; save('active'); closeSheet(); renderRest(); };
A.reorderMode = () => { closeSheet(); openSheet({ title: 'Reorder', onClose: () => render(), render: () => `<div class="list">${S.active.entries.map((e, i) => `<div class="list-item"><div class="grow">${esc(getEx(e.exId).name)}</div><div class="reorder" style="flex-direction:row;gap:6px"><button data-act="moveEntry" data-e="${i}" data-d="-1">▲</button><button data-act="moveEntry" data-e="${i}" data-d="1">▼</button></div></div>`).join('')}</div>` }); };
A.moveEntry = (d) => { const i = +d.e, j = i + +d.d, E = S.active.entries; if (j < 0 || j >= E.length) return; [E[i], E[j]] = [E[j], E[i]]; save('active'); refreshSheet(); render(); };
A.discardWorkout = () => confirmSheet(S.active.editing ? 'Discard changes?' : 'Discard workout?', S.active.editing ? 'The saved workout stays as it was.' : 'All sets from this session will be lost.', 'Discard', () => { S.active = null; holdTimer = null; save('active'); releaseWake(); closeAllSheets(); render(); });
A.finishWorkout = () => {
  const a = S.active, done = wSets(a), undone = a.entries.reduce((n, e) => n + e.sets.filter((s) => !s.done).length, 0);
  if (!done && !a.entries.some((e) => e.sets.some((s) => s.done))) return toast('Tick at least one set first');
  if (undone && !a.editing) {
    return confirmSheet('Finish workout?', `${undone} unticked set${undone > 1 ? 's' : ''} will be dropped.`, 'Finish & save', () => summarySheet(commitWorkout()), false);
  }
  const w = commitWorkout();
  if (a.editing) { toast('Saved'); render(); } else summarySheet(w);
};
A.toggleDone = (d) => {
  unlockAudio();
  const e = S.active.entries[+d.e], s = e.sets[+d.s], ex = getEx(e.exId);
  if (!s.done) {
    const row = document.querySelector(`tr[data-e="${d.e}"][data-s="${d.s}"]`);
    // Fill empty cells from their placeholders (previous session)
    if (row) row.querySelectorAll('input.cell').forEach((inp) => { if (inp.value === '' && inp.placeholder && !isNaN(pnum(inp.placeholder))) { inp.value = inp.placeholder; setCell(inp); } });
    if (ex.type === 'weight' && !(s.r > 0)) return toast('Enter reps first');
    if ((ex.type === 'timed' || ex.type === 'mobility') && !(s.t > 0)) return toast('Enter seconds or use ▶');
    s.done = true; s.ts = Date.now(); UI.justDone = s.id;
    if (!S.active.editing) {
      const tags = prTags(e.exId, s, records(e.exId, { exclude: S.active.origId || S.active.id }));
      if (tags) { toast(`New ${tags.join(' & ')} PR — ${ex.name}!`, 3200, 'trophy'); beep(2, 1180); confetti(); }
      else if (ex.type === 'weight' && !s.warm && s.tech !== 'drop') {
        const wi = e.sets.filter((x) => !x.warm && x.tech !== 'drop').indexOf(s), p = e.prev[wi];
        if (p && p.w && s.w && (s.w > p.w + 0.01 || (Math.abs(s.w - p.w) < 0.01 && s.r > p.r))) toast(s.w > p.w + 0.01 ? `+${fmtW(s.w - p.w)} vs last time — progress!` : `+${s.r - p.r} rep${s.r - p.r > 1 ? 's' : ''} vs last time — that's progress!`, 2400, 'flame');
      }
      startRest(+d.e, +d.s);
    }
  } else s.done = false;
  save('active'); render();
};
A.addSet = (d) => {
  const e = S.active.entries[+d.e], last = [...e.sets].reverse().find((s) => !s.warm) || e.sets[e.sets.length - 1];
  e.sets.push({ id: uid(), w: last ? last.w : e.sg?.w ?? null, r: last ? last.r : e.sg?.r ?? null, t: last ? last.t : e.sg?.t ?? null, d: last ? last.d : null, eff: null, warm: false, done: !!S.active.editing });
  save('active'); render();
};
A.addWarmups = (d) => warmups(S.active.entries[+d.e]);
A.setMenu = (d) => {
  const e = S.active.entries[+d.e], s = e.sets[+d.s], ex = getEx(e.exId);
  const techs = ex.type === 'weight' || ex.type === 'bodyweight' || ex.type === 'assisted' ? Object.entries(TECH) : [];
  openSheet({ title: 'Set', render: () => `<div class="list"><button class="list-item" data-act="toggleWarm" data-e="${d.e}" data-s="${d.s}"><div class="grow">${s.warm ? 'Mark as working set' : 'Mark as warm-up set'}</div></button><button class="list-item" data-act="dupSet" data-e="${d.e}" data-s="${d.s}"><div class="grow">Duplicate set</div></button>${ex.type === 'weight' ? `<button class="list-item" data-act="addDrop" data-e="${d.e}" data-s="${d.s}"><div class="grow">Add a drop set after this one</div></button>` : ''}<button class="list-item" data-act="delSet" data-e="${d.e}" data-s="${d.s}"><div class="grow bad">Delete set</div></button></div>
    ${techs.length ? `<h3>Intensity technique</h3><div class="list"><button class="list-item" data-act="setTech" data-e="${d.e}" data-s="${d.s}" data-v=""><div class="grow">Normal set</div>${!s.tech ? '<span class="accent">✓</span>' : ''}</button>${techs.map(([k, t]) => `<button class="list-item" data-act="setTech" data-e="${d.e}" data-s="${d.s}" data-v="${k}"><span class="tech">${t.short}</span><div class="grow"><div>${t.name}</div><div class="sub">${esc(t.how.split('. ')[0])}.</div></div>${s.tech === k ? '<span class="accent">✓</span>' : ''}</button>`).join('')}</div><button class="btn ghost block" data-act="techGuide">How and when to use these</button>` : ''}` });
};
A.setTech = (d) => { const s = S.active.entries[+d.e].sets[+d.s]; s.tech = d.v || undefined; save('active'); closeSheet(); render(); if (d.v) toast(`${TECH[d.v].name}: ${TECH[d.v].how.split('. ')[0]}.`, 3500); };
A.addDrop = (d) => {
  const e = S.active.entries[+d.e], ex = getEx(e.exId);
  const idx = d.s != null ? +d.s : e.sets.length - 1, base = e.sets[idx] || e.sets[e.sets.length - 1];
  if (!base) return;
  let j = idx + 1; while (e.sets[j] && e.sets[j].tech === 'drop') j++;
  const ref = e.sets[j - 1];
  e.sets.splice(j, 0, { id: uid(), w: ref.w ? roundPlate(ref.w * 0.8, ex.equipment) : null, r: null, t: null, d: null, eff: null, warm: false, done: !!S.active.editing, tech: 'drop' });
  save('active'); if (sheets.length) closeSheet(); render(); toast('Drop set added: ~20% lighter, no rest');
};
A.addTechLast = (d) => {
  const e = S.active.entries[+d.e]; const work = e.sets.filter((s) => !s.warm && s.tech !== 'drop'); const last = work[work.length - 1]; if (!last) return;
  if (d.v === 'drop') return A.addDrop({ e: d.e, s: e.sets.indexOf(last) });
  last.tech = d.v; save('active'); render(); toast(`Last set → ${TECH[d.v].name}`);
};
A.bumpWeight = (d) => {
  const e = S.active.entries[+d.e], ex = getEx(e.exId), inc = e.item?.inc ?? defaultInc(ex);
  e.sets.forEach((s) => { if (!s.warm && !s.done && s.tech !== 'drop' && s.w) s.w = roundPlate(s.w + inc, ex.equipment); });
  save('active'); render(); toast(`Loaded +${fmtW(inc)}. You've got this!`, 2400, 'lift');
};
A.deloadEntry = (d) => {
  const e = S.active.entries[+d.e], ex = getEx(e.exId);
  e.sets.forEach((s) => { if (!s.warm && !s.done && s.w) s.w = roundPlate(s.w * 0.9, ex.equipment); });
  save('active'); render(); toast('Deload: −10%. Focus on perfect reps, then build back up.');
};
A.techGuide = (d) => techGuideSheet(d && d.v);
A.toggleWarm = (d) => { const s = S.active.entries[+d.e].sets[+d.s]; s.warm = !s.warm; save('active'); closeSheet(); render(); };
A.dupSet = (d) => { const e = S.active.entries[+d.e]; e.sets.splice(+d.s + 1, 0, { ...e.sets[+d.s], id: uid(), done: !!S.active.editing }); save('active'); closeSheet(); render(); };
A.delSet = (d) => { S.active.entries[+d.e].sets.splice(+d.s, 1); save('active'); closeSheet(); render(); };
A.exMenu = (d) => {
  const i = +d.e, e = S.active.entries[i], ex = getEx(e.exId), n = S.active.entries.length;
  const linked = e.ss && S.active.entries[i + 1] && S.active.entries[i + 1].ss === e.ss;
  openSheet({
    title: ex.name,
    render: () => `<div class="list"><button class="list-item" data-act="exDetail" data-id="${e.exId}"><div class="grow">How-to guide, history & records</div><span class="chev">›</span></button>${ex.type === 'weight' ? `<button class="list-item" data-act="addWarmupsM" data-e="${i}"><div class="grow">Auto warm-up sets</div></button><button class="list-item" data-act="addDrop" data-e="${i}"><div class="grow">Add drop set to the last set</div></button>` : ''}<button class="list-item" data-act="plateCalcM" data-e="${i}"><div class="grow">Plate calculator</div></button><button class="list-item" data-act="exNote" data-e="${i}"><div class="grow">${e.note ? 'Edit note' : 'Add note'}</div></button>${i < n - 1 ? `<button class="list-item" data-act="toggleSS" data-e="${i}"><div class="grow">${linked ? 'Unlink superset' : 'Superset with next exercise'}</div></button>` : ''}<button class="list-item" data-act="replaceEx" data-e="${i}"><div class="grow"><div>Replace / swap variation</div>${altsFor(ex).length ? `<div class="sub">e.g. ${altsFor(ex).slice(0, 3).map((x) => esc(x.name)).join(', ')}</div>` : ''}</div></button>${i > 0 ? `<button class="list-item" data-act="moveEntryM" data-e="${i}" data-d="-1"><div class="grow">Move up</div></button>` : ''}${i < n - 1 ? `<button class="list-item" data-act="moveEntryM" data-e="${i}" data-d="1"><div class="grow">Move down</div></button>` : ''}<button class="list-item" data-act="removeEntry" data-e="${i}"><div class="grow bad">Remove exercise</div></button></div>`
  });
};
A.addWarmupsM = (d) => { closeSheet(); warmups(S.active.entries[+d.e]); };
A.plateCalcM = (d) => { closeSheet(); A.plateCalc(d); };
A.moveEntryM = (d) => { closeSheet(); A.moveEntry(d); };
A.exNote = (d) => {
  const e = S.active.entries[+d.e]; closeSheet();
  const st = { v: e.note || '' };
  openSheet({ title: 'Note', st, right: { label: 'Save', fn: () => { e.note = st.v.trim(); save('active'); closeSheet(); render(); } }, render: () => `<textarea class="input" data-oninput="stv" placeholder="Seat height 4, grip width…" style="min-height:120px">${esc(st.v)}</textarea>` });
};
A.toggleSS = (d) => {
  const E = S.active.entries, i = +d.e, e = E[i], nx = E[i + 1];
  if (e.ss && nx.ss === e.ss) { const g = e.ss; const left = E.slice(0, i + 1).filter((x) => x.ss === g), right = E.slice(i + 1).filter((x) => x.ss === g); if (left.length === 1) left[0].ss = null; if (right.length === 1) right[0].ss = null; else { const ng = uid(); right.forEach((x) => { x.ss = ng; }); } }
  else { const g = e.ss || nx.ss || uid(); e.ss = g; if (nx.ss && nx.ss !== g) { const old = nx.ss; E.forEach((x) => { if (x.ss === old) x.ss = g; }); } nx.ss = g; }
  save('active'); closeSheet(); render();
};
A.replaceEx = (d) => { if (sheets.length) closeSheet(); const cur = getEx(S.active.entries[+d.e].exId); pickerSheet((ids) => { const e = S.active.entries[+d.e]; const ne = makeEntry(ids[0], e.item ? { ...e.item, exId: ids[0] } : null, e.prog, e.ss, S.active.editing); S.active.entries[+d.e] = ne; save('active'); render(); }, { single: true, alts: altsFor(cur), muscle: cur.muscle }); };
A.removeEntry = (d) => { closeSheet(); confirmSheet('Remove exercise?', 'Its sets in this session will be deleted.', 'Remove', () => { S.active.entries.splice(+d.e, 1); save('active'); render(); }); };
A.addExercise = () => pickerSheet((ids) => addExercisesToActive(ids));
A.addExToActive = (d) => { closeAllSheets(); addExercisesToActive([d.id]); go('workout'); };
A.plateCalc = (d) => { const e = d && d.e != null ? S.active.entries[+d.e] : null; const s = e && (e.sets.find((x) => !x.warm && !x.done) || e.sets.find((x) => !x.warm)); plateSheet(s ? s.w : null); };
A.oneRmCalc = () => oneRmSheet();
A.holdTimer = (d) => { unlockAudio(); holdTimerSheet(+d.e, +d.s); };
A.holdStop = () => {
  if (!holdTimer) return closeSheet();
  const { ei, si, start } = holdTimer;
  const t = start ? Math.round((Date.now() - start) / 1000) : 0;
  const s = S.active.entries[ei].sets[si];
  if (t > 0) { s.t = t; s.done = true; s.ts = Date.now(); startRest(ei, si); }
  holdTimer = null; save('active'); closeSheet(); render();
};
A.restAdj = (d) => { const r = S.active.rest; if (!r) return; r.end += +d.v * 1000; r.total = Math.max(r.total, (r.end - Date.now()) / 1000); r.beeped = false; r.warned = false; save('active'); renderRest(); };
A.restSkip = () => { S.active.rest = null; save('active'); renderRest(); };

A.viewWorkout = (d) => viewWorkoutSheet(d.id);
A.editWorkout = (d) => {
  if (S.active) return toast('Finish the current workout first');
  const w = S.workouts.find((x) => x.id === d.id); if (!w) return;
  const a = clone(w); a.origId = w.id; a.id = uid(); a.editing = true;
  a.entries = a.entries.map((e) => { const prev = entriesFor(e.exId, { exclude: w.id, before: w.start })[0]?.e.sets.filter(isWork) || []; return { ...e, item: null, prog: null, sg: null, prev: prev.map((s) => ({ w: s.w, r: s.r, t: s.t, d: s.d })) }; });
  S.active = a; save('active'); closeAllSheets(); go('workout');
};
A.repeatWorkout = (d) => { const w = S.workouts.find((x) => x.id === d.id); if (w) startWorkout(null, { from: w, name: w.name }); };
A.saveAsRoutine = (d) => {
  const w = S.workouts.find((x) => x.id === d.id); if (!w) return;
  const r = { id: uid(), name: w.name, prog: 'double', items: w.entries.map((e, i, E) => { const ws = e.sets.filter((s) => !s.warm); const reps = ws.map((s) => s.r || 0); return { exId: e.exId, sets: ws.length || 3, repMin: Math.min(...reps) || 8, repMax: Math.max(...reps) || 12, time: getEx(e.exId).type === 'timed' ? Math.max(...ws.map((s) => s.t || 0)) || 30 : undefined, ss: !!(e.ss && E[i + 1] && E[i + 1].ss === e.ss) }; }) };
  S.routines.push(r); save('routines'); closeAllSheets(); toast('Routine created'); go('plan'); routineSheet(r.id);
};
A.shareWorkout = (d) => {
  const w = S.workouts.find((x) => x.id === d.id); if (!w) return;
  const text = workoutText(w);
  if (navigator.share) navigator.share({ text }).catch(() => {});
  else navigator.clipboard?.writeText(text).then(() => toast('Copied to clipboard'));
};
A.deleteWorkout = (d) => confirmSheet('Delete workout?', 'This cannot be undone.', 'Delete', () => { S.workouts = S.workouts.filter((w) => w.id !== d.id); save('workouts'); closeAllSheets(); render(); toast('Deleted'); });

A.dayMenu = (d) => {
  const date = parseKey(d.d).getTime() + 12 * 3600e3, r = routineFor(date), ww = workoutsOn(date);
  openSheet({
    title: fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' }),
    render: () => {
      let h = ww.length ? `<h3>Logged</h3><div class="list">${ww.map((w) => `<button class="list-item" data-act="viewWorkout" data-id="${w.id}"><div class="grow">${esc(w.name)}<div class="sub">${fmtDur(wDur(w))} · ${fmtVol(wVolume(w))}</div></div><span class="chev">›</span></button>`).join('')}</div>` : '';
      h += `<h3>Planned: ${r ? esc(r.name) : 'Rest'}</h3><div class="small muted" style="margin:0 4px 8px">Move a session on this day only — the weekly plan stays the same.</div><div class="list"><button class="list-item" data-act="setOverride" data-d="${d.d}" data-id=""><div class="grow">Rest</div>${d.d in S.plan.overrides && !S.plan.overrides[d.d] ? '<span class="accent">✓</span>' : ''}</button>${S.routines.map((x) => `<button class="list-item" data-act="setOverride" data-d="${d.d}" data-id="${x.id}"><div class="grow">${esc(x.name)}</div>${r && r.id === x.id ? '<span class="accent">✓</span>' : ''}</button>`).join('')}</div>${d.d in S.plan.overrides ? `<button class="btn block" data-act="clearOverride" data-d="${d.d}">Reset to weekly plan</button>` : ''}`;
      if (sod(date) === sod(Date.now()) && r && !S.active) h += `<button class="btn primary block mt" data-act="startRoutine" data-id="${r.id}">Start ${esc(r.name)}</button>`;
      return h;
    }
  });
};
A.setOverride = (d) => { S.plan.overrides[d.d] = d.id || null; save('plan'); closeSheet(); render(); };
A.clearOverride = (d) => { delete S.plan.overrides[d.d]; save('plan'); if (sheets.length) closeSheet(); render(); };

A.newRoutine = () => { const r = { id: uid(), name: `Routine ${S.routines.length + 1}`, prog: 'double', items: [], created: Date.now(), block: { start: Date.now(), n: 1, scheme: 'hyp' } }; S.routines.push(r); save('routines'); if (route() !== 'plan') go('plan'); routineSheet(r.id); };
A.editRoutine = (d) => routineSheet(d.id);
A.rProg = (d) => { const r = S.routines.find((x) => x.id === d.id); r.prog = d.v; save('routines'); refreshSheet(); };
A.rMove = (d) => { const r = S.routines.find((x) => x.id === d.id), i = +d.i, j = i + +d.d; if (j < 0 || j >= r.items.length) return; [r.items[i], r.items[j]] = [r.items[j], r.items[i]]; save('routines'); refreshSheet(); };
A.rRemove = (d) => { const r = S.routines.find((x) => x.id === d.id); r.items.splice(+d.i, 1); save('routines'); refreshSheet(); };
A.rAddEx = (d) => pickerSheet((ids) => { const r = S.routines.find((x) => x.id === d.id); ids.forEach((id) => { const ex = getEx(id); if (ex.type === 'mobility') { const it = { exId: id, sets: 1, time: 30, phase: 'cooldown' }; r.items.push(it); return; } const it = { exId: id, sets: ex.type === 'cardio' ? 1 : 3, repMin: ['timed', 'cardio'].includes(ex.type) ? null : 8, repMax: ['timed', 'cardio'].includes(ex.type) ? null : 12, time: ex.type === 'timed' ? 30 : undefined, phase: 'main' }; const ci = r.items.findIndex((x) => x.phase === 'cooldown'); r.items.splice(ci < 0 ? r.items.length : ci, 0, it); }); save('routines'); refreshSheet(); });
A.rWarmCool = (d) => { const r = S.routines.find((x) => x.id === d.id); addWarmCool(r); save('routines'); refreshSheet(); toast('Warm-up & cool-down added'); };
A.rotNow = (d) => rotationSheet(d.id, false);
A.rotUndo = (d) => { const r = S.routines.find((x) => x.id === d.id); const h = (r.history || []).pop(); if (!h) return; r.items = h.items; r.block = h.block; save('routines'); refreshSheet(); toast('Rotation undone'); };
A.rotEnable = (d) => { const r = S.routines.find((x) => x.id === d.id); delete r.noRotate; save('routines'); refreshSheet(); };
A.rotApply = (d) => { const r = S.routines.find((x) => x.id === d.id); const plan = sheets[sheets.length - 1]._plan || planRotation(r); applyRotation(r, plan); closeSheet(); toast(`Block ${r.block.n} started — new exercises loaded`, 3000, 'cycle'); refreshSheet(); render(); if (d.s) startWorkout(r.id, { noRotateCheck: true }); };
A.rotSnooze = (d) => { const r = S.routines.find((x) => x.id === d.id); routineBlock(r).snooze = Date.now() + 14 * DAY; save('routines'); closeSheet(); render(); if (d.s) startWorkout(r.id, { noRotateCheck: true }); };
A.rotNever = (d) => { const r = S.routines.find((x) => x.id === d.id); r.noRotate = true; save('routines'); closeSheet(); render(); if (d.s) startWorkout(r.id, { noRotateCheck: true }); };
A.rDay = (d) => { S.plan.days[d.d] = S.plan.days[d.d] === d.id ? null : d.id; save('plan'); refreshSheet(); };
A.dupRoutine = (d) => { const r = clone(S.routines.find((x) => x.id === d.id)); r.id = uid(); r.name += ' (copy)'; S.routines.push(r); save('routines'); closeSheet(); routineSheet(r.id); };
A.delRoutine = (d) => confirmSheet('Delete routine?', 'Past workouts are kept.', 'Delete', () => { S.routines = S.routines.filter((r) => r.id !== d.id); for (const k in S.plan.days) if (S.plan.days[k] === d.id) S.plan.days[k] = null; save('routines', 'plan'); closeAllSheets(); render(); });
A.openTemplates = () => programsSheet();
A.progFilter = (d) => { const st = topSt(); st[d.k] = st[d.k] === d.v ? '' : d.v; refreshSheet(); };
A.progPreview = (d) => programPreview(d.id);
A.progApply = (d) => applyProgram(d.id);

A.statsTab = (d) => { UI.statsTab = d.v; render(); };
A.muscleMode = (d) => { UI.muscleMode = d.v; render(); };
A.exDetail = (d) => exDetailSheet(d.id);
A.exTab = (d) => { topSt().tab = d.v; refreshSheet(); };
A.galleryTap = (d, el) => { el.classList.toggle('paused'); if (el.classList.contains('paused')) el.classList.toggle('show-b', !el.classList.contains('show-b')); };
A.addBW = () => bwSheet();
A.editBW = (d) => bwSheet(d.id);
A.delBW = (d) => { S.body = S.body.filter((b) => b.id !== d.id); save('body'); closeSheet(); render(); };
A.setGoal = () => { const st = { v: S.settings.bwGoal != null ? num(toU(S.settings.bwGoal), 1) : '' }; openSheet({ title: 'Body-weight goal', st, right: { label: 'Save', fn: () => { const v = pnum(st.v); S.settings.bwGoal = v ? fromU(v) : null; save('settings'); closeSheet(); render(); } }, render: () => `<div class="field"><label>Goal (${U()}) — leave empty to clear</label><input class="input" inputmode="decimal" data-oninput="stv" value="${st.v}"></div>` }); };
A.addMeasure = () => measureSheet();
A.editMeasure = (d) => measureSheet(d.id);
A.delMeasure = (d) => { S.measures = S.measures.filter((m) => m.id !== d.id); save('measures'); closeSheet(); render(); };

A.libMuscle = (d) => { UI.libMuscle = d.v; render(); };
A.libOwned = () => { UI.libOwned = !UI.libOwned; render(); };
A.newCustomEx = (d) => customExSheet(null, d && d.q ? d.q : '');
A.cxSec = (d) => { const st = sheets[sheets.length - 1].st, s = st.ex.secondary; const i = s.indexOf(d.v); if (i >= 0) s.splice(i, 1); else s.push(d.v); refreshSheet(); };
A.delCustom = (d) => {
  const used = S.workouts.some((w) => w.entries.some((e) => e.exId === d.id));
  confirmSheet('Delete exercise?', used ? 'It appears in past workouts — they will show it as “Deleted exercise”.' : 'This cannot be undone.', 'Delete', () => { S.custom = S.custom.filter((c) => c.id !== d.id); S.routines.forEach((r) => { r.items = r.items.filter((i) => i.exId !== d.id); }); save('custom', 'routines'); buildEx(); closeAllSheets(); render(); });
};
A.pickToggle = (d) => {
  const def = sheets[sheets.length - 1], st = def.picker;
  if (def.single) { closeSheet(); def.onPick([d.id]); return; }
  const i = st.sel.indexOf(d.id); if (i >= 0) st.sel.splice(i, 1); else st.sel.push(d.id);
  def.right.label = st.sel.length ? `Add (${st.sel.length})` : 'Add';
  refreshSheet();
};
A.pickMuscle = (d) => { const def = sheets[sheets.length - 1]; def.picker.muscle = d.v; refreshSheet(); };

A.setOpt = (d) => {
  const s = S.settings, k = d.k; let v = d.v;
  if (k === 'weekStart') v = +v;
  if (k === 'unit' && v !== s.unit) { s.plates = v === 'lb' ? [45, 35, 25, 10, 5, 2.5] : [25, 20, 15, 10, 5, 2.5, 1.25]; s.bar = v === 'lb' ? 45 : 20; }
  s[k] = v; save('settings'); applyTheme(); refreshSheet();
};
A.toggleOwned = (d) => { const o = S.settings.owned, i = o.indexOf(d.v); if (i >= 0) o.splice(i, 1); else o.push(d.v); save('settings'); refreshSheet(); };
A.exportJSON = async () => { const ok = await download(`forge-backup-${dkey(Date.now())}.json`, exportData(), 'application/json'); if (ok) { S.meta.lastBackup = Date.now(); save('meta'); refreshSheet(); render(); toast('Backup ready'); } };
A.importJSON = async () => { const t = await pickFile('.json,application/json'); if (!t) return; try { const n = mergeData(JSON.parse(t)); toast(`Imported ${n} new workouts`); closeAllSheets(); render(); } catch (e) { toast('Import failed: ' + e.message, 4000); } };
A.exportCSV = () => download(`forge-workouts-${dkey(Date.now())}.csv`, exportCSV(), 'text/csv');
A.importCSV = async () => { const t = await pickFile('.csv,text/csv,text/plain'); if (!t) return; try { const r = importCSV(t); toast(`Imported ${r.n} workouts from ${r.fmt}${r.created ? ` (+${r.created} new exercises)` : ''}`, 4000); closeAllSheets(); render(); } catch (e) { toast('Import failed: ' + e.message, 4000); } };
A.persist = async () => { try { const ok = navigator.storage?.persist ? await navigator.storage.persist() : false; toast(ok ? 'Storage is protected ✓' : 'The browser declined — installing to your Home Screen helps'); refreshSheet(); } catch (e) { toast('Not supported here'); } };
A.loadDemo = () => confirmSheet('Load demo data?', 'Adds ~10 weeks of sample workouts, weigh-ins and an Upper/Lower plan to your existing data. You can erase it later with “Erase all data”.', 'Load demo', () => { loadDemo(); closeAllSheets(); go('home'); toast('Demo data loaded'); }, false);
A.eraseAll = () => confirmSheet(`Erase ${esc(me().name)}'s data?`, 'All of this profile’s workouts, routines, body data and settings on this device will be permanently deleted. Other profiles are not affected. Back up first!', 'Erase all data', () => {
  confirmSheet('Are you absolutely sure?', 'There is no undo.', 'Yes, erase', async () => {
    Object.assign(S, { settings: { ...DEFAULTS }, custom: [], routines: [], plan: { days: {}, overrides: {} }, workouts: [], active: null, body: [], measures: [], meta: {} });
    KEYS.forEach((k) => dirty.add(k)); flush(); buildEx(); applyTheme(); closeAllSheets(); go('home'); toast('All data erased');
  });
});


/* ---------- Profile actions ---------- */
A.profileMenu = () => profileMenuSheet();
A.editProfile = () => profileDetailsSheet(false);
A.addPerson = () => showPicker();
A.pickProfile = (d) => openProfile(d.id);
A.enterName = () => { const p = PROFILES.find((x) => x.name.trim().toLowerCase() === ($('#pname')?.value || '').trim().toLowerCase()); if (p && p.pin && p.pin.hash) openProfile(p.id); else enterName($('#pname')?.value); };
A.pdSeg = (d) => { const st = topSt(); st.d[d.k] = d.k === 'sessionsPerWeek' || d.k === 'rotateWeeks' ? +d.v : d.v; refreshSheet(); };
A.pdColor = (d) => { topSt().color = d.v; refreshSheet(); };
A.setPin = () => {
  const st = { a: '', b: '' };
  openSheet({ title: 'Profile PIN', st, right: { label: 'Save', fn: async () => {
    if (!/^\d{4,8}$/.test(st.a)) return toast('Use 4–8 digits'); if (st.a !== st.b) return toast('PINs don’t match');
    const p = me(), salt = uid(); p.pin = { salt, hash: await hashPin(st.a, salt) }; await saveProfiles(); closeSheet(); refreshSheet(); toast('PIN set', 2200, 'lock');
  } }, render: () => `<p class="small muted">Asked when someone opens or switches to your profile on this phone. It keeps other people who use this phone out of your log. It's a privacy lock, not encryption.</p><div class="field"><label>New PIN (4–8 digits)</label><input class="input" type="password" inputmode="numeric" maxlength="8" data-oninput="pinA"></div><div class="field"><label>Repeat PIN</label><input class="input" type="password" inputmode="numeric" maxlength="8" data-oninput="pinB"></div>${me().pin ? '<button class="btn danger block" data-act="clearPin">Remove PIN</button>' : ''}` });
};
A.clearPin = () => { delete me().pin; saveProfiles(); closeSheet(); refreshSheet(); toast('PIN removed'); };
A.pinCheck = () => { const d = sheets[sheets.length - 1]; if (d.check) d.check(); };
A.deleteProfile = () => confirmSheet(`Delete ${esc(me().name)}?`, `All of ${esc(me().name)}'s workouts, routines and body data on this phone will be permanently deleted. Send a copy or back up first if you might need it.`, 'Delete profile', async () => {
  const id = PID; await Promise.all(KEYS.map((k) => Store.del(`${id}:${k}`)));
  PROFILES = PROFILES.filter((p) => p.id !== id); await saveProfiles(); await Store.del('lastProfile'); showPicker(); toast('Profile deleted');
});
A.sendProfile = () => sendProfileSheet();
A.pdInjury = (d) => { const st = topSt(), a = st.d.injuries || (st.d.injuries = []); const i = a.indexOf(d.v); if (i >= 0) a.splice(i, 1); else a.push(d.v); refreshSheet(); };
A.addSurgery = () => { const st = topSt(); (st.d.surgeries || (st.d.surgeries = [])).push({ area: st.srgArea || 'knee', date: st.srgDate || '', note: (st.srgNote || '').slice(0, 80) }); st.srgNote = ''; st.srgDate = ''; refreshSheet(); };
A.rmSurgery = (d) => { topSt().d.surgeries.splice(+d.i, 1); refreshSheet(); };
A.swapSafe = (d) => { const e = S.active.entries[+d.e]; const ne = makeEntry(d.id, e.item ? { ...e.item, exId: d.id, inc: undefined } : null, e.prog, e.ss, S.active.editing); S.active.entries[+d.e] = ne; save('active'); render(); toast(`Swapped to ${getEx(d.id).name}`); };
A.dbMode = (d) => { const e = S.active.entries[+d.e]; e.dbMode = d.v; if (e.item) e.item.dbMode = d.v; const r = S.routines.find((x) => x.id === S.active.routineId); const it = r && r.items.find((i) => i.exId === e.exId); if (it) { it.dbMode = d.v; save('routines'); } save('active'); render(); toast(DB_MODES[d.v].label + ' — remembered for next time'); };
A.addScan = () => scanSheet();
A.editScan = (d) => scanSheet(d.id);
A.delScan = (d) => { S.scans = S.scans.filter((x) => x.id !== d.id); save('scans'); closeSheet(); render(); };
A.scanKey = (d) => { UI.scanKey = d.v; render(); };
A.scanPhotoDel = () => { topSt().photo = null; refreshSheet(); };
A.receiveProfile = () => receiveSheet();
A.copyXfer = async () => { const st = topSt(); const link = `${location.origin}${location.pathname}#import=${st.code}`; try { await navigator.clipboard.writeText(link); toast('Copied — paste it on the other device'); } catch (e) { toast('Copy failed — use Share instead'); } };
A.shareXfer = async () => { const st = topSt(); const link = `${location.origin}${location.pathname}#import=${st.code}`; if (navigator.share) navigator.share({ title: `Forge profile: ${me().name}`, text: `Forge transfer for ${me().name}. In Forge: Profiles → Receive a profile → paste this.`, url: link }).catch(() => {}); else A.copyXfer(); };
A.xferRead = async () => { const st = topSt(); st.err = ''; try { st.data = sanitizeData(await unpackProfile(st.text)); } catch (e) { st.err = e.message || 'Could not read that code'; } refreshSheet(); };
A.xferFile = async () => { const t = await pickFile('.json,application/json'); if (!t) return; const st = topSt(); try { st.data = sanitizeData(JSON.parse(t)); st.err = ''; } catch (e) { st.err = 'That file is not a Forge backup'; } refreshSheet(); };
A.importNew = async () => { const st = topSt(); await importAsNewProfile(st.data); };
A.importMerge = async (d) => { const st = topSt(); const o = st.data; closeAllSheets(); const go2 = async () => { await loadProfile(d.id); const n = mergeData(o); toast(`Merged: ${n} new workouts`, 3000); render(); }; const p = PROFILES.find((x) => x.id === d.id); if (p.pin && p.pin.hash && d.id !== PID) pinSheet(p, go2); else go2(); };
A.cacheImages = async () => {
  const files = Object.values(GUIDE).flatMap((g) => Array.from({ length: g.n || 0 }, (_, i) => `img/${g.img}-${i}.jpg`));
  toast(`Downloading ${files.length} photos…`, 2000); let ok = 0;
  for (let i = 0; i < files.length; i += 8) { const res = await Promise.all(files.slice(i, i + 8).map((f) => fetch(f).then((r) => r.ok).catch(() => false))); ok += res.filter(Boolean).length; }
  toast(`${ok} photos saved for offline use ✓`, 3000);
};

/* ======================= Input handlers ======================= */
const ON = {}; // on 'change'
const IN = {}; // on 'input'
function setCell(inp) {
  const tr = inp.closest('tr'); if (!tr || !S.active) return;
  const e = S.active.entries[+tr.dataset.e], s = e && e.sets[+tr.dataset.s]; if (!s) return;
  const v = pnum(inp.value), f = inp.dataset.cell;
  if (f === 'w') s.w = v == null ? null : fromU(v);
  else if (f === 'r') s.r = v == null ? null : Math.round(v);
  else if (f === 't') s.t = v == null ? null : Math.round(v);
  else if (f === 'tm') s.t = v == null ? null : Math.round(v * 60);
  else if (f === 'd') s.d = v == null ? null : fromD(v);
  else if (f === 'eff') s.eff = v == null ? null : { v: Math.max(0, Math.min(10, v)), scale: S.settings.effort };
}
ON.wName = (v) => { S.active.name = v; save('active'); };
ON.wNotes = (v) => { S.active.notes = v; save('active'); };
ON.wStart = (v) => { const t = new Date(v).getTime(); if (!isNaN(t)) { const dur = wDur(S.active); S.active.start = t; S.active.end = t + dur; save('active'); } };
ON.wDurMin = (v) => { const m = pnum(v); if (m > 0) { S.active.end = S.active.start + m * 6e4; save('active'); } };
ON.planDay = (v, d) => { S.plan.days[d.d] = v || null; save('plan'); };
ON.rName = (v, d) => { S.routines.find((x) => x.id === d.id).name = v.trim() || 'Routine'; save('routines'); };
ON.rItem = (v, d) => {
  const it = S.routines.find((x) => x.id === d.id).items[+d.i], k = d.k;
  if (k === 'prog') it.prog = v === 'routine' ? undefined : v;
  else if (k === 'tech') it.tech = TECH[v] ? v : undefined;
  else if (k === 'dbMode') it.dbMode = DB_MODES[v] ? v : undefined;
  else if (k === 'phase') { it.phase = v; save('routines'); refreshSheet(); return; }
  else if (k === 'inc') it.inc = pnum(v) == null ? undefined : fromU(pnum(v));
  else { const n = pnum(v); it[k] = n == null ? undefined : Math.round(n); }
  if (it.repMin && it.repMax && it.repMax < it.repMin) it.repMax = it.repMin;
  save('routines');
};
ON.rSS = (v, d, el) => { S.routines.find((x) => x.id === d.id).items[+d.i].ss = el.checked; save('routines'); refreshSheet(); };
ON.libEq = (v) => { UI.libEq = v; render(); };
ON.setNum = (v, d) => { const n = pnum(v); if (n != null && n >= 0) { S.settings[d.k] = n; save('settings'); } const o = $('#plate-out'); if (o) { const p = sheets[sheets.length - 1]; o.innerHTML = plateOut(p.st.w, [...S.settings.plates].sort((a, b) => b - a), p.plates); } };
ON.setPlates = (v) => { const p = v.split(/[,\s]+/).map(pnum).filter((x) => x > 0); if (p.length) { S.settings.plates = [...new Set(p)].sort((a, b) => b - a); save('settings'); } };
ON.setBool = (v, d, el) => { S.settings[d.k] = el.checked; save('settings'); if (d.k === 'keepAwake') { if (el.checked) requestWake(); else releaseWake(); } };
ON.setAccent = (v) => { S.settings.accent = v; save('settings'); applyTheme(); refreshSheet(); };
ON.pdRotate = (v, d, el) => { topSt().d.rotate = el.checked; };
ON.scanPhoto = async (v, d, el) => { const f = el.files && el.files[0]; if (!f) return; try { topSt().photo = await shrinkImage(f); refreshSheet(); } catch (e) { toast(e.message); } };
ON.cx = (v, d) => { const st = sheets[sheets.length - 1].st; st.ex[d.k] = v; if (d.k === 'muscle') { st.ex.secondary = st.ex.secondary.filter((m) => m !== v); refreshSheet(); } };

const topSt = () => sheets[sheets.length - 1].st;
IN.libQ = (v) => { UI.libQ = v; const el = $('#liblist'); if (el) el.innerHTML = libList(filterEx(UI.libQ, UI.libMuscle, UI.libEq, UI.libOwned)); };
IN.pickQ = (v) => { const def = sheets[sheets.length - 1]; def.picker.q = v; $('#picklist').innerHTML = def.rows(); };
IN.plateW = (v) => { const p = sheets[sheets.length - 1]; p.st.w = pnum(v); $('#plate-out').innerHTML = plateOut(p.st.w, [...S.settings.plates].sort((a, b) => b - a), p.plates); };
IN.ormW = (v) => { const st = topSt(); st.w = pnum(v); $('#orm-out').innerHTML = ormOut(st); };
IN.ormR = (v) => { const st = topSt(); st.r = pnum(v); $('#orm-out').innerHTML = ormOut(st); };
IN.stv = (v) => { topSt().v = v; };
IN.std = (v) => { topSt().d = v; };
IN.msd = (v) => { topSt().d = v; };
IN.msv = (v, d) => { topSt().v[d.k] = v; };
IN.lpD = (v) => { topSt().d = v; };
IN.lpT = (v) => { topSt().t = v; };
IN.lpR = (v) => { topSt().r = v; };
IN.pdName = (v) => { topSt().name = v; };
IN.pdWeight = (v) => { topSt().weight = v; };
IN.pdNotes = (v) => { topSt().d.healthNotes = v.slice(0, 500); };
IN.srgArea = (v) => { topSt().srgArea = v; };
IN.srgDate = (v) => { topSt().srgDate = v; };
IN.srgNote = (v) => { topSt().srgNote = v; };
IN.scanV = (v, d) => { topSt().v[d.k] = v; };
IN.scanDev = (v) => { topSt().device = v; };
IN.pdSel = (v, d) => { topSt().d[d.k] = v; };
IN.pdNum = (v, d) => { const n = pnum(v); topSt().d[d.k] = n ? Math.round(n) : null; };
IN.xferText = (v) => { topSt().text = v; };
IN.pinV = (v) => { topSt().v = v; if (v.length >= 4) { const d = sheets[sheets.length - 1]; clearTimeout(IN._pt); IN._pt = setTimeout(() => { if (topSt().v === v) d.check(); }, 450); } };
IN.pinA = (v) => { topSt().a = v; };
IN.pinB = (v) => { topSt().b = v; };

/* ======================= Theme & boot ======================= */
function applyTheme() {
  const s = S.settings, light = s.theme === 'light' || (s.theme === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.classList.toggle('light', light);
  document.documentElement.style.setProperty('--accent', s.accent);
  document.documentElement.style.setProperty('--fs', { m: '16px', l: '17.5px', xl: '19px', xxl: '20.5px' }[s.textSize] || '17.5px');
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = light ? '#f2f2f7' : '#000000';
}

function bindEvents() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const fn = A[el.dataset.act]; if (!fn) return;
    e.preventDefault(); fn(el.dataset, el, e);
  });
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.cell) { setCell(el); return; }
    if (el.dataset.oninput && IN[el.dataset.oninput]) IN[el.dataset.oninput](el.value, el.dataset, el);
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.cell) { setCell(el); save('active'); return; }
    if (el.dataset.on && ON[el.dataset.on]) ON[el.dataset.on](el.value, el.dataset, el);
    // Selects/date pickers on iOS may only fire 'change'; text inputs are already handled on 'input'.
    if (el.dataset.oninput && IN[el.dataset.oninput] && (el.tagName === 'SELECT' || /^(date|time|datetime-local)$/.test(el.type))) IN[el.dataset.oninput](el.value, el.dataset, el);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'pname') { e.preventDefault(); A.enterName(); } });
  document.addEventListener('focusin', (e) => { if (e.target.classList && e.target.classList.contains('cell')) setTimeout(() => e.target.select && e.target.select(), 0); });
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  $('#sheet-backdrop').addEventListener('click', () => closeSheet());
  window.addEventListener('hashchange', () => render());
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); else { requestWake(); render(); } });
  window.addEventListener('pagehide', flush);
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);
}

async function loadProfile(id) {
  flush();
  const p = PROFILES.find((x) => x.id === id); if (!p) return showPicker();
  PID = id; p.lastUsed = Date.now(); saveProfiles(); await Store.set('lastProfile', id);
  const vals = await Promise.all(KEYS.map((k) => Store.get(PK(k))));
  Object.assign(S, freshState());
  KEYS.forEach((k, i) => { if (vals[i] != null) S[k] = vals[i]; });
  S.settings = { ...DEFAULTS, ...S.settings };
  S.plan = { days: {}, overrides: {}, ...S.plan };
  if (!S.meta.created) { S.meta.created = Date.now(); save('meta'); }
  ver++; _rec.clear(); holdTimer = null;
  document.body.classList.remove('noprofile');
  sortW(); buildEx(); applyTheme(); closeAllSheets();
  if (location.hash !== '#home') location.hash = 'home'; else render();
  if (S.active) requestWake(); else releaseWake();
}
function showPicker() {
  flush(); PID = null; Object.assign(S, freshState()); buildEx(); applyTheme(); releaseWake();
  document.body.classList.add('noprofile'); closeAllSheets(); render();
}

async function boot() {
  await Store.open();
  PROFILES = (await Store.get('profiles')) || [];
  const schema = await Store.get('schema');
  if (schema !== SCHEMA) {
    // Data-format upgrade: keep an untouched copy first, so an update can never lose anything.
    try { await snapshotBeforeUpgrade(schema || 1); } catch (e) { /* storage full: continue, data itself is untouched */ }
    await Store.set('schema', SCHEMA);
  }
  if (!PROFILES.length) {
    // Upgrade from v1 (single user): move existing data into a first profile.
    const vals = await Promise.all(KEYS.map((k) => Store.get(k)));
    if (vals.some((v) => v != null && !(Array.isArray(v) && !v.length))) {
      const p = newProfile('Me'); p.migrated = true; PROFILES.push(p);
      await Promise.all(KEYS.map((k, i) => (vals[i] != null ? Store.set(`${p.id}:${k}`, vals[i]) : null)));
      await saveProfiles(); await Store.set('lastProfile', p.id);
    }
  }
  const TAB_ICONS = { home: 'home', workout: 'dumbbell', plan: 'calendar', stats: 'chart', library: 'book' };
  document.querySelectorAll('#tabbar a').forEach((a) => { const svg = a.querySelector('svg'); if (svg) svg.outerHTML = ico(TAB_ICONS[a.dataset.tab]); });
  bindEvents(); startTick();
  let importCode = null;
  if (location.hash.startsWith('#import=')) { importCode = location.hash.slice(8); history.replaceState(null, '', location.pathname + '#home'); }
  const last = await Store.get('lastProfile');
  const lastP = PROFILES.find((p) => p.id === last);
  if (lastP && !(lastP.pin && lastP.pin.hash)) await loadProfile(last);
  else { showPicker(); if (lastP) pinSheet(lastP, () => loadProfile(lastP.id)); }
  if (importCode) receiveSheet(importCode);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  // Ask for persistent storage once installed (iOS grants it to Home Screen apps).
  if (standalone() && navigator.storage?.persist) navigator.storage.persisted().then((p) => { if (!p) navigator.storage.persist(); }).catch(() => {});
}
window.__forge = { S, A, render, loadDemo, get PID() { return PID; }, get PROFILES() { return PROFILES; }, loadProfile, showPicker };
boot();
})();
