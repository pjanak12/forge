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
  }
};

const KEYS = ['settings', 'custom', 'routines', 'plan', 'workouts', 'active', 'body', 'measures', 'meta'];
const DEFAULTS = {
  unit: 'kg', theme: 'dark', accent: '#ff5a1f', weekStart: 1, bar: 20, plates: [25, 20, 15, 10, 5, 2.5, 1.25],
  rest: 120, effort: 'rpe', sound: true, keepAwake: true, owned: [], bwGoal: null, distUnit: 'km'
};
const S = { settings: { ...DEFAULTS }, custom: [], routines: [], plan: { days: {}, overrides: {} }, workouts: [], active: null, body: [], measures: [], meta: {} };
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
  ks.forEach((k) => Store.set(k, S[k] == null ? null : clone(S[k])));
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
const TYPES = { weight: 'Weight × reps', bodyweight: 'Body weight (+ optional load)', assisted: 'Assisted (− load)', timed: 'Timed hold', cardio: 'Cardio (time + distance)' };

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
const wVolume = (w) => {
  let v = 0;
  for (const e of w.entries) {
    const t = getEx(e.exId).type;
    if (t === 'weight' || t === 'bodyweight') for (const s of e.sets) if (isWork(s) && s.w > 0 && s.r > 0) v += s.w * s.r;
  }
  return v;
};
const wSets = (w) => w.entries.reduce((n, e) => n + e.sets.filter(isWork).length, 0);
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
  const out = { sets, w: null, r: prog === 'double' ? lo : hi, t: ex.type === 'timed' ? (item.time || 30) : null, d: null, src: '', prog };
  const hist = entriesFor(exId, { exclude });
  if (!hist.length) { out.src = 'First time — pick a starting point'; return out; }
  const ws = hist[0].e.sets.filter(isWork);
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
    const ex = getEx(e.exId); if (!e.sets.some(isWork)) continue;
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

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
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

/* ---------- Sheets (modal stack) ---------- */
const sheets = [];
function openSheet(def) { sheets.push(def); renderSheet(true); }
function closeSheet() { const d = sheets.pop(); if (d && d.onClose) d.onClose(); renderSheet(true); }
function closeAllSheets() { while (sheets.length) closeSheet(); }
function renderSheet(fresh) {
  const el = $('#sheet'), bd = $('#sheet-backdrop');
  if (!sheets.length) { el.hidden = true; bd.hidden = true; el.innerHTML = ''; return; }
  const d = sheets[sheets.length - 1];
  const prevScroll = !fresh && el.querySelector('.sheet-body') ? el.querySelector('.sheet-body').scrollTop : 0;
  const right = d.right ? `<button class="iconbtn" data-act="sheetRight">${esc(d.right.label)}</button>` : '';
  el.innerHTML = `<div class="sheet-head"><div><button class="iconbtn" data-act="sheetClose">${sheets.length > 1 ? '‹ Back' : esc(d.cancel || 'Close')}</button></div><h4>${esc(d.title || '')}</h4><div class="r">${right}</div></div><div class="sheet-body">${d.render()}</div>`;
  el.hidden = false; bd.hidden = false;
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
const GEAR = '<svg viewBox="0 0 24 24"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.6h4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>';

function render() {
  const t = route(), v = $('#view');
  const keep = render._last === t ? v.scrollTop : 0;
  render._last = t;
  document.querySelectorAll('#tabbar a').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === t);
    a.querySelector('.dot')?.remove();
    if (a.dataset.tab === 'workout' && S.active && t !== 'workout') a.insertAdjacentHTML('beforeend', '<i class="dot"></i>');
  });
  v.innerHTML = VIEWS[t]();
  v.scrollTop = keep;
  const heat = $('#heat'); if (heat) heat.scrollLeft = heat.scrollWidth;
  renderRest();
}
const renderView = render;

/* ======================= Views ======================= */
const VIEWS = {};

/* ---------- Home ---------- */
VIEWS.home = () => {
  setTop('Forge', '', `<button class="iconbtn" data-act="openSettings" aria-label="Settings">${GEAR}</button>`);
  const now = Date.now(), h = new Date().getHours();
  const greet = h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  let html = `<h2>${greet}</h2>`;

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
      html += `<div class="card hero"><div class="small muted">Today · ${DOW_LONG[new Date().getDay()]}</div><div class="big">${esc(r.name)}</div><div class="muted small">${r.items.length} exercises · ${PROG[r.prog] || ''}</div><div class="small mt">${r.items.slice(0, 6).map((i) => esc(getEx(i.exId).name)).join(' · ')}${r.items.length > 6 ? ' …' : ''}</div><button class="btn primary block mt" data-act="startRoutine" data-id="${r.id}">Start workout</button></div>`;
    } else if (!S.routines.length) {
      html += `<div class="card hero"><div class="big">Welcome 👋</div><p class="muted">Everything you log stays on this phone — no account, no cloud. Start with a ready-made program or build your own.</p><button class="btn primary block" data-act="openTemplates">Choose a starter program</button><button class="btn block mt" data-act="newRoutine">Build my own routine</button><button class="btn ghost block mt" data-act="startEmpty">Just start an empty workout</button></div>`;
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
  html += `<div class="grid3 mt"><div class="stat"><div class="v">${doneCount}<span class="muted small">/${planned || '–'}</span></div><div class="l">Sessions</div></div><div class="stat"><div class="v">${st.cur}🔥</div><div class="l">Week streak</div></div><div class="stat"><div class="v" style="font-size:18px;padding:2px 0">${fmtVol(weekVol)}</div><div class="l">Volume</div></div></div>`;

  // Recovery
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
  let html = `<div class="card"><input class="input" data-on="wName" value="${esc(a.name)}" style="font-weight:650;font-size:18px;border:0;background:transparent;padding:4px 0">`;
  if (a.editing) {
    const dt = new Date(a.start); const local = `${dkey(dt)}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    html += `<div class="grid2 mt"><div class="field mb0"><label>Started</label><input class="input" type="datetime-local" data-on="wStart" value="${local}"></div><div class="field mb0"><label>Duration (min)</label><input class="input" inputmode="numeric" data-on="wDurMin" value="${Math.round(wDur(a) / 6e4) || ''}"></div></div>`;
  } else {
    html += `<div class="small muted">${fmtDate(a.start, { weekday: 'long', day: 'numeric', month: 'long' })} · ${wSets(a)} sets · ${fmtVol(wVolume(a))}</div>`;
  }
  html += `</div>`;
  if (!a.entries.length) html += `<div class="empty"><div class="ico">🏋️</div>Add your first exercise to get going.</div>`;

  a.entries.forEach((e, ei) => {
    const ex = getEx(e.exId), t = ex.type;
    const rec = records(e.exId, { exclude: a.origId || a.id });
    const ssPrev = ei > 0 && e.ss && a.entries[ei - 1].ss === e.ss, ssNext = a.entries[ei + 1] && e.ss && a.entries[ei + 1].ss === e.ss;
    const ssLabel = e.ss ? `<span class="tag accent">Superset ${ssPrev ? '' : '↓'}</span>` : '';
    let target = '';
    if (e.item) {
      if (t === 'timed') target = `${e.item.sets || 3}× ${e.sg?.t || e.item.time || 30}s`;
      else if (t !== 'cardio') target = `${e.item.sets || 3}×${e.item.repMin || 8}${e.item.repMax && e.item.repMax !== e.item.repMin ? '–' + e.item.repMax : ''}`;
    }
    const hint = e.sg && e.sg.src ? `<div class="ex-hint">${target ? `Target ${target}${e.sg.w ? ' @ ' + fmtW(e.sg.w) : ''} · ` : ''}<span class="src">${esc(e.sg.src)}</span>${rec.e1rm ? ` · best e1RM ${fmtW(rec.e1rm)}` : ''}</div>` : '';
    const wLabel = t === 'bodyweight' ? `+${U()}` : t === 'assisted' ? `−${U()}` : t === 'cardio' ? 'Min' : U();
    const rLabel = t === 'timed' ? 'Sec' : t === 'cardio' ? distU() : 'Reps';
    html += `<div class="ex ${e.ss ? 'superset' : ''}" ${ssNext ? 'style="margin-bottom:3px"' : ''}><div class="ex-head"><div class="grow"><div class="name">${esc(ex.name)} ${ssLabel}</div><div class="tiny muted">${MUSCLES[ex.muscle] || ''} · ${EQUIPMENT[ex.equipment] || ''}${e.note ? ' · 📝 ' + esc(e.note) : ''}</div></div><button class="iconbtn" data-act="exMenu" data-e="${ei}">•••</button></div>${hint}`;
    html += `<table class="sets"><thead><tr><th>Set</th><th>Prev</th><th>${wLabel}</th><th>${rLabel}</th>${eff !== 'off' && t !== 'cardio' ? `<th>${eff.toUpperCase()}</th>` : ''}<th>✓</th></tr></thead><tbody>`;
    let wn = 0;
    e.sets.forEach((s, si) => {
      const p = s.warm ? null : e.prev[wn];
      const label = s.warm ? 'W' : ++wn;
      const prs = !s.warm && s.done ? prTags(e.exId, s, rec) : null;
      let prevTxt = '–';
      if (p) {
        if (t === 'timed') prevTxt = `${p.t || 0}s`;
        else if (t === 'cardio') prevTxt = `${Math.round((p.t || 0) / 60)}′ ${num(toD(p.d), 1)}`;
        else if (t === 'bodyweight' && !p.w) prevTxt = `${p.r || 0}`;
        else prevTxt = `${num(toU(p.w), 1)}×${p.r || 0}`;
      }
      const ph = (v) => (v == null || v === '' ? '' : esc(v));
      let c1, c2;
      if (t === 'cardio') {
        c1 = `<input class="cell" inputmode="decimal" data-cell="tm" value="${s.t != null ? num(s.t / 60, 1) : ''}" placeholder="${p ? num((p.t || 0) / 60, 1) : 'min'}">`;
        c2 = `<input class="cell" inputmode="decimal" data-cell="d" value="${s.d != null ? num(toD(s.d), 2) : ''}" placeholder="${p ? num(toD(p.d), 2) : distU()}">`;
      } else {
        c1 = `<input class="cell" inputmode="decimal" data-cell="w" value="${s.w != null ? num(toU(s.w), 2) : ''}" placeholder="${p && p.w ? num(toU(p.w), 1) : (t === 'weight' ? U() : '0')}">`;
        c2 = t === 'timed'
          ? `<div class="row" style="gap:3px;justify-content:center"><input class="cell" style="max-width:52px" inputmode="numeric" data-cell="t" value="${ph(s.t)}" placeholder="${p ? p.t : 's'}"><button class="check" style="width:30px" data-act="holdTimer" data-e="${ei}" data-s="${si}">▶</button></div>`
          : `<input class="cell" inputmode="numeric" data-cell="r" value="${ph(s.r)}" placeholder="${p ? p.r : (e.sg?.r || '')}">`;
      }
      const c3 = eff !== 'off' && t !== 'cardio' ? `<td><input class="cell rpe" inputmode="decimal" data-cell="eff" value="${s.eff && s.eff.v != null ? num(s.eff.v, 1) : ''}" placeholder="${s.eff && s.eff.scale !== eff ? s.eff.scale : '–'}"></td>` : '';
      html += `<tr class="${s.done ? 'done' : ''} ${s.warm ? 'warm' : ''}" data-e="${ei}" data-s="${si}"><td><button class="setno" data-act="setMenu" data-e="${ei}" data-s="${si}">${label}</button></td><td class="prev">${prs ? '<span class="prflag">🏆</span> ' : ''}${prevTxt}</td><td>${c1}</td><td>${c2}</td>${c3}<td><button class="check" data-act="toggleDone" data-e="${ei}" data-s="${si}">✓</button></td></tr>`;
    });
    html += `</tbody></table><div class="ex-foot"><button class="btn sm" data-act="addSet" data-e="${ei}">+ Set</button>${t === 'weight' ? `<button class="btn sm" data-act="addWarmups" data-e="${ei}">+ Warm-ups</button>` : ''}${ex.equipment === 'barbell' || ex.equipment === 'trapbar' || ex.equipment === 'ezbar' ? `<button class="btn sm" data-act="plateCalc" data-e="${ei}">Plates</button>` : ''}</div></div>`;
  });
  html += `<button class="btn block primary" data-act="addExercise">+ Add exercise</button>`;
  html += `<div class="grid2 mt"><button class="btn" data-act="plateCalc">Plate calculator</button><button class="btn" data-act="oneRmCalc">1RM calculator</button></div>`;
  html += `<div class="field mt"><label>Workout notes</label><textarea class="input" data-on="wNotes" placeholder="How did it feel?">${esc(a.notes || '')}</textarea></div>`;
  html += `<p class="tiny faint center">Tap a set number to mark it as a warm-up or delete it. Warm-ups don't count toward records or progression.</p>`;
  return html;
};

function workoutStart() {
  setTop('Workout', '', `<button class="iconbtn" data-act="logPast">Log past</button>`);
  const r = routineFor(Date.now());
  let html = '';
  if (r) html += `<div class="card hero"><div class="small muted">Planned for today</div><div class="big">${esc(r.name)}</div><button class="btn primary block mt" data-act="startRoutine" data-id="${r.id}">Start ${esc(r.name)}</button></div>`;
  html += `<button class="btn block ${r ? '' : 'primary'}" data-act="startEmpty">Start empty workout</button>`;
  if (S.routines.length) {
    html += `<h3>Routines</h3><div class="list">${S.routines.map((x) => `<button class="list-item" data-act="startRoutine" data-id="${x.id}"><div class="grow"><div>${esc(x.name)}</div><div class="sub ellipsis">${x.items.map((i) => esc(getEx(i.exId).name)).join(', ') || 'No exercises'}</div></div><span class="accent small">Start</span></button>`).join('')}</div>`;
  }
  html += `<h3>History</h3>`;
  if (!S.workouts.length) return html + `<div class="empty"><div class="ico">📓</div>No workouts yet. Your history will appear here.</div>`;
  let month = '';
  html += `<div>`;
  S.workouts.slice(0, UI.histLimit).forEach((w) => {
    const m = fmtDate(w.start, { month: 'long', year: 'numeric' });
    if (m !== month) { if (month) html += `</div>`; html += `<h3 style="margin-top:14px">${m}</h3><div class="list">`; month = m; }
    const prs = workoutPRs(w).length;
    html += `<button class="list-item" data-act="viewWorkout" data-id="${w.id}"><div class="grow"><div>${esc(w.name)} ${prs ? `<span class="tag pr">🏆 ${prs}</span>` : ''}</div><div class="sub">${fmtDate(w.start)} · ${fmtDur(wDur(w))} · ${wSets(w)} sets · ${fmtVol(wVolume(w))}</div></div><span class="chev">›</span></button>`;
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
  if (!S.routines.length) html += `<div class="empty"><div class="ico">🗓️</div>No routines yet.</div>`;
  else html += `<div class="list">${S.routines.map((r) => `<button class="list-item" data-act="editRoutine" data-id="${r.id}"><div class="grow"><div>${esc(r.name)}</div><div class="sub ellipsis">${r.items.length} exercises · ${PROG[r.prog]}</div></div><span class="chev">›</span></button>`).join('')}</div>`;
  html += `<div class="grid2"><button class="btn" data-act="newRoutine">+ New routine</button><button class="btn" data-act="openTemplates">Starter programs</button></div>`;
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
  if (!W.length) return `<div class="empty"><div class="ico">📈</div>Log a workout to see your stats.</div>`;
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
    ['🏁', 'First workout', W.length >= 1], ['🔟', '10 workouts', W.length >= 10], ['💪', '50 workouts', W.length >= 50], ['🏛️', '100 workouts', W.length >= 100],
    ['🔥', '4-week streak', st.best >= 4], ['⚡', '12-week streak', st.best >= 12], ['🏆', '10 PRs', prs >= 10], ['👑', '50 PRs', prs >= 50],
    ['🏋️', '10 t lifted', totalVol >= 1e4], ['🦍', '100 t lifted', totalVol >= 1e5], ['🌅', 'Early bird', hasEarly], ['🦉', 'Night owl', hasLate],
    ['⏱️', '2-hour session', long], ['📅', '3 months logged', W.length && (Date.now() - W[W.length - 1].start) > 90 * DAY], ['⚖️', '10 weigh-ins', S.body.length >= 10], ['🧠', 'Used RPE/RIR', W.some((w) => w.entries.some((e) => e.sets.some((s) => s.eff && s.eff.v != null)))]
  ];
  html += `<h3>Badges</h3><div class="badge-grid">${B.map(([e, l, got]) => `<div class="badge ${got ? 'got' : ''}"><div class="e">${e}</div>${l}</div>`).join('')}</div>`;
  return html;
};
STATS.exercises = () => {
  const done = {};
  for (const w of S.workouts) for (const e of w.entries) if (e.sets.some(isWork)) { done[e.exId] = done[e.exId] || { n: 0, last: w.start }; done[e.exId].n++; }
  const ids = Object.keys(done);
  if (!ids.length) return `<div class="empty"><div class="ico">🏋️</div>No lifts logged yet.</div>`;
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
  setTop('Library', '', `<button class="iconbtn" data-act="newCustomEx">+ Custom</button>`);
  const list = filterEx(UI.libQ, UI.libMuscle, UI.libEq, UI.libOwned);
  let html = `<div class="search"><input class="input" type="search" placeholder="Search ${EX_LIST.length} exercises" data-oninput="libQ" value="${esc(UI.libQ)}" autocomplete="off"></div>`;
  html += muscleChips(UI.libMuscle, 'libMuscle');
  html += `<div class="row" style="margin-bottom:10px"><select class="input grow" data-on="libEq"><option value="">All equipment</option>${Object.entries(EQUIPMENT).map(([k, v]) => `<option value="${k}" ${UI.libEq === k ? 'selected' : ''}>${v}</option>`).join('')}</select>${S.settings.owned.length ? `<button class="chip ${UI.libOwned ? 'on' : ''}" data-act="libOwned">My gear</button>` : ''}</div>`;
  html += `<div id="liblist">${libList(list)}</div>`;
  return html;
};
const libList = (list) => list.length ? `<div class="list">${list.slice(0, 250).map((ex) => `<button class="list-item" data-act="exDetail" data-id="${ex.id}"><div class="grow"><div>${esc(ex.name)} ${ex.custom ? '<span class="tag accent">custom</span>' : ''}</div><div class="sub">${MUSCLES[ex.muscle] || ''} · ${EQUIPMENT[ex.equipment] || ''}</div></div><span class="chev">›</span></button>`).join('')}</div>` : `<div class="empty">No matches. <button class="btn ghost" data-act="newCustomEx">Create a custom exercise</button></div>`;

/* ======================= Sheets content ======================= */
function exDetailSheet(id) {
  openSheet({
    title: getEx(id).name,
    right: getEx(id).custom ? { label: 'Edit', fn: () => customExSheet(id) } : null,
    render: () => {
      const ex = getEx(id), rec = records(id), hist = entriesFor(id);
      let h = `<div class="row wrap" style="gap:6px;margin-bottom:10px"><span class="tag accent">${MUSCLES[ex.muscle] || ''}</span>${ex.secondary.map((m) => `<span class="tag">${MUSCLES[m] || m}</span>`).join('')}<span class="tag">${EQUIPMENT[ex.equipment] || ''}</span><span class="tag">${TYPES[ex.type]}</span></div>`;
      if (ex.notes) h += `<div class="card small">${esc(ex.notes)}</div>`;
      if (ex.link) h += `<a class="btn block" href="${esc(ex.link)}" target="_blank" rel="noopener">Open guide ↗</a>`;
      h += `<a class="btn ghost block" href="https://www.youtube.com/results?search_query=${encodeURIComponent(ex.name + ' exercise form')}" target="_blank" rel="noopener">Search form videos ↗</a>`;
      if (S.active) h += `<button class="btn primary block mt" data-act="addExToActive" data-id="${id}">Add to current workout</button>`;
      if (!hist.length) return h + `<div class="empty small">You haven't logged this yet.</div>`;
      if (ex.type === 'weight') {
        const pts = [...hist].reverse().map(({ w, e }) => ({ x: w.start, y: toU(Math.max(0, ...e.sets.map(e1rm))) })).filter((p) => p.y > 0);
        h += `<h3>Estimated 1RM (${U()})</h3><div class="card">${lineChart(pts)}</div>`;
        h += `<div class="grid2"><div class="stat"><div class="v">${fmtW(rec.e1rm)}</div><div class="l">Best e1RM${rec.e1rmSet ? ` · ${num(toU(rec.e1rmSet.w), 1)}×${rec.e1rmSet.r}` : ''}</div></div><div class="stat"><div class="v">${fmtW(rec.heavy)}</div><div class="l">Heaviest${rec.heavySet ? ` · ${relDay(rec.heavySet.date)}` : ''}</div></div><div class="stat"><div class="v">${rec.volSet ? `${num(toU(rec.volSet.w), 1)}×${rec.volSet.r}` : '–'}</div><div class="l">Best volume set</div></div><div class="stat"><div class="v">${rec.count}</div><div class="l">Sessions</div></div></div>`;
        if (rec.e1rm) h += `<h3>Rep maxes (estimated)</h3><div class="card"><div class="grid3">${[1, 2, 3, 5, 8, 10, 12, 15, 20].map((r) => `<div><div class="tiny muted">${r}RM</div><b>${num(toU(r === 1 ? rec.e1rm : rec.e1rm / (1 + r / 30)), 1)}</b></div>`).join('')}</div><div class="tiny faint mt">Percentages: ${[90, 80, 70, 60].map((p) => `${p}% = ${num(toU(roundPlate(rec.e1rm * p / 100)), 1)}`).join(' · ')}</div></div>`;
      } else {
        const metric = ex.type === 'timed' ? (s) => s.t || 0 : ex.type === 'cardio' ? (s) => toD(s.d || 0) : (s) => s.r || 0;
        const pts = [...hist].reverse().map(({ w, e }) => ({ x: w.start, y: Math.max(0, ...e.sets.filter(isWork).map(metric)) }));
        h += `<h3>Best ${ex.type === 'timed' ? 'hold (s)' : ex.type === 'cardio' ? 'distance (' + distU() + ')' : 'reps'}</h3><div class="card">${lineChart(pts, { fmt: (v) => num(v, ex.type === 'cardio' ? 1 : 0) })}</div>`;
      }
      h += `<h3>History</h3><div class="list">${hist.slice(0, 25).map(({ w, e }) => `<button class="list-item" data-act="viewWorkout" data-id="${w.id}"><div class="grow"><div class="small">${fmtDate(w.start, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div><div class="sub">${e.sets.filter(isWork).map((s) => setStr(ex, s)).join(', ')}</div></div></button>`).join('')}</div>`;
      return h;
    }
  });
}
function setStr(ex, s) {
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
      if (prs.length) h += `<div class="card mt"><b>🏆 ${prs.length} personal record${prs.length > 1 ? 's' : ''}</b>${prs.map((p) => `<div class="small mt">${esc(getEx(p.exId).name)} — ${setStr(getEx(p.exId), p.set)} <span class="tag pr">${p.tags.join(', ')}</span></div>`).join('')}</div>`;
      if (w.notes) h += `<div class="card small">${esc(w.notes)}</div>`;
      h += w.entries.map((e) => { const ex = getEx(e.exId); return `<div class="card"><div class="row between"><b>${esc(ex.name)}</b>${e.ss ? '<span class="tag accent">superset</span>' : ''}</div>${e.note ? `<div class="tiny muted">${esc(e.note)}</div>` : ''}<div class="small mt">${e.sets.map((s, i) => `<div class="row between" style="padding:3px 0;border-bottom:1px solid var(--line)"><span class="${s.warm ? '' : 'muted'}" style="${s.warm ? 'color:var(--warn)' : ''}">${s.warm ? 'Warm-up' : 'Set ' + (e.sets.slice(0, i + 1).filter((x) => !x.warm).length)}</span><span>${setStr(ex, s)}${ex.type === 'weight' && e1rm(s) ? ` <span class="faint tiny">e1RM ${num(toU(e1rm(s)), 0)}</span>` : ''}</span></div>`).join('')}</div></div>`; }).join('');
      h += `<div class="grid2"><button class="btn" data-act="editWorkout" data-id="${w.id}">Edit</button><button class="btn" data-act="repeatWorkout" data-id="${w.id}">Repeat</button><button class="btn" data-act="saveAsRoutine" data-id="${w.id}">Save as routine</button><button class="btn" data-act="shareWorkout" data-id="${w.id}">Share summary</button></div><button class="btn danger block mt" data-act="deleteWorkout" data-id="${w.id}">Delete workout</button>`;
      return h;
    }
  });
}

/* ---------- Exercise picker ---------- */
function pickerSheet(onPick, opts = {}) {
  const st = { q: '', muscle: '', sel: [] };
  const list = () => filterEx(st.q, st.muscle, '', UI.libOwned);
  const rows = () => {
    const l = list();
    const recent = !st.q && !st.muscle ? [...new Set(S.workouts.slice(0, 15).flatMap((w) => w.entries.map((e) => e.exId)))].filter((id) => EX[id]).slice(0, 8) : [];
    const item = (ex) => `<button class="list-item" data-act="pickToggle" data-id="${ex.id}"><div class="grow"><div>${esc(ex.name)}</div><div class="sub">${MUSCLES[ex.muscle] || ''} · ${EQUIPMENT[ex.equipment] || ''}</div></div><span class="${st.sel.includes(ex.id) ? 'accent' : 'faint'}" style="font-size:20px">${st.sel.includes(ex.id) ? '●' : '○'}</span></button>`;
    return (recent.length ? `<h3>Recent</h3><div class="list">${recent.map((id) => item(EX[id])).join('')}</div><h3>All</h3>` : '') + (l.length ? `<div class="list">${l.slice(0, 200).map(item).join('')}</div>` : `<div class="empty">No matches. <button class="btn ghost" data-act="newCustomEx" data-q="${esc(st.q)}">Create “${esc(st.q)}”</button></div>`);
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
      let h = `<div class="field"><label>Name</label><input class="input" data-on="rName" data-id="${id}" value="${esc(r.name)}"></div>`;
      h += `<div class="field"><label>Progression</label><div class="seg">${Object.entries(PROG).map(([k, v]) => `<button class="${r.prog === k ? 'on' : ''}" data-act="rProg" data-id="${id}" data-v="${k}">${v.replace(' progression', '')}</button>`).join('')}</div><div class="tiny muted">${PROG_HELP[r.prog]}</div></div>`;
      h += `<h3>Exercises</h3>`;
      r.items.forEach((it, i) => {
        const ex = getEx(it.exId), t = ex.type;
        h += `<div class="card" style="${it.ss ? 'border-left:3px solid var(--accent);margin-bottom:3px' : (i > 0 && r.items[i - 1].ss ? 'border-left:3px solid var(--accent)' : '')}"><div class="row"><div class="grow"><b>${esc(ex.name)}</b><div class="tiny muted">${MUSCLES[ex.muscle] || ''}</div></div><div class="reorder"><button data-act="rMove" data-id="${id}" data-i="${i}" data-d="-1">▲</button><button data-act="rMove" data-id="${id}" data-i="${i}" data-d="1">▼</button></div><button class="iconbtn" style="color:var(--bad)" data-act="rRemove" data-id="${id}" data-i="${i}">✕</button></div>`;
        h += `<div class="grid3 mt" style="grid-template-columns:repeat(${t === 'cardio' ? 2 : 4},1fr);gap:6px">`;
        const f = (k, l, v, mode = 'numeric') => `<div class="field mb0"><label class="tiny">${l}</label><input class="input" style="padding:8px" inputmode="${mode}" data-on="rItem" data-id="${id}" data-i="${i}" data-k="${k}" value="${v ?? ''}"></div>`;
        h += f('sets', 'Sets', it.sets);
        if (t === 'timed') h += f('time', 'Hold (s)', it.time);
        else if (t !== 'cardio') { h += f('repMin', 'Reps min', it.repMin); h += f('repMax', 'Reps max', it.repMax); }
        if (t === 'weight' || t === 'assisted') h += f('inc', `+${U()}`, it.inc != null ? num(toU(it.inc), 2) : num(toU(defaultInc(ex)), 2), 'decimal');
        else if (t !== 'cardio') h += f('rest', 'Rest (s)', it.rest);
        h += `</div><div class="grid2 mt" style="gap:6px">`;
        if (t === 'weight' || t === 'assisted') h += `<div class="field mb0"><label class="tiny">Rest (s)</label><input class="input" style="padding:8px" inputmode="numeric" data-on="rItem" data-id="${id}" data-i="${i}" data-k="rest" value="${it.rest ?? ''}" placeholder="${S.settings.rest}"></div>`;
        if (t === 'weight') h += `<div class="field mb0"><label class="tiny">Progression</label><select class="input" style="padding:8px" data-on="rItem" data-id="${id}" data-i="${i}" data-k="prog"><option value="routine">Routine default</option>${Object.entries(PROG).filter(([k]) => k !== 'time').map(([k, v]) => `<option value="${k}" ${it.prog === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`;
        h += `</div>`;
        if (i < r.items.length - 1) h += `<label class="row small mt" style="justify-content:space-between">Superset with next exercise<span class="switch"><input type="checkbox" data-on="rSS" data-id="${id}" data-i="${i}" ${it.ss ? 'checked' : ''}><span></span></span></label>`;
        h += `</div>`;
      });
      h += `<button class="btn primary block" data-act="rAddEx" data-id="${id}">+ Add exercises</button>`;
      h += `<h3>Schedule</h3><div class="chips">${[0, 1, 2, 3, 4, 5, 6].map((i) => (i + S.settings.weekStart) % 7).map((d) => `<button class="chip ${S.plan.days[d] === id ? 'on' : ''}" data-act="rDay" data-id="${id}" data-d="${d}">${DOW[d]}</button>`).join('')}</div>`;
      h += `<div class="grid2 mt"><button class="btn" data-act="startRoutine" data-id="${id}">Start now</button><button class="btn" data-act="dupRoutine" data-id="${id}">Duplicate</button></div><button class="btn danger block mt" data-act="delRoutine" data-id="${id}">Delete routine</button>`;
      return h;
    }
  });
}

/* ---------- Starter programs ---------- */
const TEMPLATES = [
  { name: 'Full Body A/B (3×/week)', desc: 'Classic beginner strength. Linear progression, alternate A and B.', prog: 'linear', days: { 1: 0, 3: 1, 5: 0 },
    routines: [['Full Body A', [['Back Squat', 3, 5], ['Bench Press', 3, 5], ['Barbell Row', 3, 8], ['Plank', 3, 0, 0, 0, 45]]], ['Full Body B', [['Deadlift', 1, 5], ['Overhead Press', 3, 5], ['Pull-Up', 3, 6, 0, 10], ['Hanging Knee Raise', 3, 10, 0, 15]]]] },
  { name: '5×5 Linear', desc: 'Squat every session, add weight every time. Simple and brutal.', prog: 'linear', days: { 1: 0, 3: 1, 5: 0 },
    routines: [['5×5 A', [['Back Squat', 5, 5], ['Bench Press', 5, 5], ['Barbell Row', 5, 5]]], ['5×5 B', [['Back Squat', 5, 5], ['Overhead Press', 5, 5], ['Deadlift', 1, 5]]]] },
  { name: 'Upper / Lower (4×/week)', desc: 'Balanced strength and size. Double progression in rep ranges.', prog: 'double', days: { 1: 0, 2: 1, 4: 2, 5: 3 },
    routines: [
      ['Upper 1', [['Bench Press', 4, 5, 0, 8], ['Barbell Row', 4, 6, 0, 10], ['Seated Dumbbell Press', 3, 8, 0, 12], ['Lat Pulldown', 3, 8, 0, 12], ['Triceps Pushdown', 3, 10, 0, 15], ['Dumbbell Curl', 3, 10, 0, 15]]],
      ['Lower 1', [['Back Squat', 4, 5, 0, 8], ['Romanian Deadlift', 3, 8, 0, 10], ['Leg Press', 3, 10, 0, 15], ['Lying Leg Curl', 3, 10, 0, 15], ['Standing Calf Raise', 4, 10, 0, 15]]],
      ['Upper 2', [['Overhead Press', 4, 5, 0, 8], ['Weighted Pull-Up', 4, 5, 0, 8], ['Incline Dumbbell Press', 3, 8, 0, 12], ['Chest-Supported Row', 3, 8, 0, 12], ['Lateral Raise', 3, 12, 0, 20], ['Face Pull', 3, 12, 0, 20]]],
      ['Lower 2', [['Deadlift', 3, 3, 0, 5], ['Front Squat', 3, 6, 0, 8], ['Bulgarian Split Squat', 3, 8, 0, 12], ['Hip Thrust', 3, 8, 0, 12], ['Hanging Leg Raise', 3, 8, 0, 15]]]] },
  { name: 'Push / Pull / Legs (6×/week)', desc: 'High-frequency hypertrophy split. Run each day twice a week.', prog: 'double', days: { 1: 0, 2: 1, 3: 2, 4: 0, 5: 1, 6: 2 },
    routines: [
      ['Push', [['Bench Press', 4, 6, 0, 10], ['Incline Dumbbell Press', 3, 8, 0, 12], ['Seated Dumbbell Press', 3, 8, 0, 12], ['Lateral Raise', 4, 12, 0, 20], ['Rope Pushdown', 3, 10, 0, 15], ['Overhead Cable Extension', 3, 10, 0, 15]]],
      ['Pull', [['Pull-Up', 4, 6, 0, 10], ['Barbell Row', 3, 6, 0, 10], ['Seated Cable Row', 3, 10, 0, 12], ['Face Pull', 3, 12, 0, 20], ['Hammer Curl', 3, 10, 0, 15], ['Incline Dumbbell Curl', 3, 10, 0, 15]]],
      ['Legs', [['Back Squat', 4, 5, 0, 8], ['Romanian Deadlift', 3, 8, 0, 10], ['Leg Press', 3, 10, 0, 15], ['Seated Leg Curl', 3, 10, 0, 15], ['Standing Calf Raise', 4, 10, 0, 15], ['Plank', 3, 0, 0, 0, 45]]]] },
  { name: 'Home / Body weight (3×/week)', desc: 'No gym needed. Progress by reps, then harder variations.', prog: 'double', days: { 1: 0, 3: 0, 5: 0 },
    routines: [['Body weight', [['Push-Up', 3, 8, 0, 20], ['Inverted Row', 3, 6, 0, 15], ['Bulgarian Split Squat', 3, 8, 0, 15], ['Glute Bridge', 3, 12, 0, 25], ['Plank', 3, 0, 0, 0, 30], ['Dead Bug', 3, 8, 0, 15]]]] }
];
function applyTemplate(i) {
  const t = TEMPLATES[i], ids = [];
  for (const [name, items] of t.routines) {
    const r = { id: uid(), name, prog: t.prog, items: [] };
    for (const [exName, sets, lo, , hi, time] of items) {
      const ex = exByName(exName); if (!ex || !sets) continue;
      const it = { exId: ex.id, sets, repMin: lo || null, repMax: hi || lo || null };
      if (ex.type === 'timed') it.time = time || 30;
      r.items.push(it);
    }
    S.routines.push(r); ids.push(r.id);
  }
  for (const d in t.days) S.plan.days[d] = ids[t.days[d]];
  save('routines', 'plan'); closeAllSheets(); toast(`Added ${t.name}`); go('plan');
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
      let h = `<h3>Units & equipment</h3><div class="card"><div class="field"><label>Weight unit</label>${seg('unit', [['kg', 'Kilograms'], ['lb', 'Pounds']])}</div><div class="grid2"><div class="field"><label>Bar weight (${U()})</label><input class="input" inputmode="decimal" data-on="setNum" data-k="bar" value="${s.bar}"></div><div class="field"><label>Default rest (s)</label><input class="input" inputmode="numeric" data-on="setNum" data-k="rest" value="${s.rest}"></div></div><div class="field mb0"><label>Plates you have (${U()}, comma separated)</label><input class="input" data-on="setPlates" value="${s.plates.join(', ')}"></div></div>`;
      h += `<div class="card"><div class="small muted" style="margin-bottom:8px">Equipment you own (used by the Library's “My gear” filter)</div><div class="row wrap" style="gap:6px">${Object.entries(EQUIPMENT).filter(([k]) => !['bodyweight', 'other'].includes(k)).map(([k, v]) => `<button class="chip ${s.owned.includes(k) ? 'on' : ''}" data-act="toggleOwned" data-v="${k}">${v}</button>`).join('')}</div></div>`;
      h += `<h3>Training</h3><div class="card"><div class="field"><label>Effort tracking per set</label>${seg('effort', [['off', 'Off'], ['rpe', 'RPE'], ['rir', 'RIR']])}<div class="tiny faint">RPE 10 = failure; RIR = reps left in the tank. Each set keeps the scale it was logged in.</div></div><div class="field mb0"><label>Week starts on</label>${seg('weekStart', [[1, 'Monday'], [0, 'Sunday']])}</div></div>`;
      h += `<div class="list">${sw('sound', 'Rest timer sound', 'Plays when the app is open. iPhone silent mode mutes it.')}${sw('keepAwake', 'Keep screen awake during workouts')}</div>`;
      h += `<h3>Appearance</h3><div class="card"><div class="field">${seg('theme', [['dark', 'Dark'], ['light', 'Light'], ['auto', 'Auto']])}</div><div class="swatches">${accents.map((c) => `<button class="swatch ${s.accent === c ? 'on' : ''}" style="background:${c}" data-act="setOpt" data-k="accent" data-v="${c}" aria-label="${c}"></button>`).join('')}<label class="swatch ${accents.includes(s.accent) ? '' : 'on'}" style="background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);position:relative;overflow:hidden"><input type="color" data-on="setAccent" value="${s.accent}" style="opacity:0;position:absolute;inset:0"></label></div></div>`;
      h += `<h3>Your data</h3><div class="card small"><div id="storage-info" class="muted">Checking storage…</div><div class="muted mt">Everything is stored only on this device, inside this app. Deleting the app from your Home Screen deletes the data — back up regularly.</div></div>`;
      h += `<div class="list"><button class="list-item" data-act="exportJSON"><div class="grow"><div>Back up (JSON)</div><div class="sub">${S.meta.lastBackup ? 'Last: ' + relDay(S.meta.lastBackup) : 'Never backed up'}</div></div><span class="chev">›</span></button><button class="list-item" data-act="importJSON"><div class="grow"><div>Restore / merge backup</div><div class="sub">Merges — never overwrites existing workouts</div></div><span class="chev">›</span></button><button class="list-item" data-act="exportCSV"><div class="grow">Export workouts (CSV)</div><span class="chev">›</span></button><button class="list-item" data-act="importCSV"><div class="grow"><div>Import from Strong, Hevy or FitNotes</div><div class="sub">CSV export from those apps</div></div><span class="chev">›</span></button><button class="list-item" data-act="persist"><div class="grow">Ask the browser to protect storage</div><span class="chev">›</span></button></div>`;
      h += `<div class="list"><button class="list-item" data-act="loadDemo"><div class="grow"><div>Load demo data</div><div class="sub">10 weeks of sample training to explore the app</div></div></button><button class="list-item" data-act="eraseAll"><div class="grow bad">Erase all data</div></button></div>`;
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
  const prev = entriesFor(exId, { exclude: S.active?.origId })[0]?.e.sets.filter(isWork) || [];
  const sets = [];
  for (let i = 0; i < sg.sets; i++) {
    const p = prev[i];
    sets.push({ id: uid(), w: sg.w, r: ex.type === 'timed' || ex.type === 'cardio' ? null : sg.r, t: ex.type === 'cardio' ? (p?.t ?? sg.t) : sg.t, d: ex.type === 'cardio' ? (p?.d ?? sg.d) : null, eff: null, warm: false, done: !!past });
  }
  return { id: uid(), exId, ss: ss || null, item: item ? { ...item } : null, prog, sg: { src: sg.src, w: sg.w, r: sg.r, t: sg.t }, prev: prev.map((s) => ({ w: s.w, r: s.r, t: s.t, d: s.d })), sets, note: '' };
}
function startWorkout(routineId, opts = {}) {
  if (S.active) { toast('Finish or discard the current workout first'); closeAllSheets(); go('workout'); return; }
  const r = S.routines.find((x) => x.id === routineId);
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
      const en = makeEntry(e.exId, { sets: e.sets.filter((s) => !s.warm).length || 1 }, 'none', e.ss, opts.past);
      a.entries.push(en);
    });
  }
  save('active'); closeAllSheets(); go('workout'); requestWake(); startTick();
}
function addExercisesToActive(ids) {
  for (const id of ids) {
    const routine = S.routines.find((r) => r.id === S.active.routineId);
    const ex = getEx(id);
    S.active.entries.push(makeEntry(id, { sets: ex.type === 'cardio' ? 1 : 3, repMin: 8, repMax: 12, time: 30 }, routine ? routine.prog : 'double', null, S.active.editing));
  }
  save('active'); render();
  setTimeout(() => { const v = $('#view'); v.scrollTop = v.scrollHeight; }, 30);
}
function startRest(ei, si) {
  const a = S.active, e = a.entries[ei], s = e.sets[si];
  const next = a.entries[ei + 1];
  if (e.ss && next && next.ss === e.ss) { toast(`Superset → ${getEx(next.exId).name}`); return; }
  let secs = s.warm ? 60 : (e.item?.rest || S.settings.rest);
  // Next set label
  let label = '';
  for (let i = ei; i < a.entries.length && !label; i++) {
    const en = a.entries[i]; const idx = en.sets.findIndex((x) => !x.done);
    if (idx >= 0) label = `${getEx(en.exId).name} · set ${idx + 1}`;
  }
  if (e.ss) { // end of superset round → go back to the first exercise of the group
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
  w.entries = a.entries.map((e) => ({ id: e.id, exId: e.exId, ss: e.ss, note: e.note || '', sets: e.sets.filter((s) => s.done).map((s) => { const c = { ...s }; delete c.ts; return c; }) })).filter((e) => e.sets.length);
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
    render: () => `<div class="center"><div style="font-size:54px">${prs.length ? '🏆' : '💪'}</div><div class="big">${esc(w.name)}</div><div class="muted">${fmtDate(w.start, { weekday: 'long', day: 'numeric', month: 'long' })}</div></div>
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
function exportData() { const o = { app: 'forge', version: 1, exported: Date.now() }; KEYS.forEach((k) => { if (k !== 'active') o[k] = S[k]; }); return JSON.stringify(o, null, 1); }
function mergeData(o) {
  if (!o || (o.app !== 'forge' && !o.workouts)) throw new Error('Not a Forge backup');
  const mergeArr = (key) => { if (!Array.isArray(o[key])) return 0; const ids = new Map(S[key].map((x, i) => [x.id, i])); let n = 0; for (const x of o[key]) { if (!x || !x.id) continue; if (ids.has(x.id)) S[key][ids.get(x.id)] = x; else { S[key].push(x); n++; } } return n; };
  const n = mergeArr('workouts'); mergeArr('routines'); mergeArr('custom'); mergeArr('body'); mergeArr('measures');
  if (o.plan) { S.plan.days = { ...o.plan.days, ...S.plan.days }; S.plan.overrides = { ...o.plan.overrides, ...S.plan.overrides }; }
  if (o.settings && !S.workouts.length) S.settings = { ...DEFAULTS, ...o.settings };
  sortW(); buildEx(); save('workouts', 'routines', 'custom', 'body', 'measures', 'plan', 'settings');
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
  if (!S.routines.length) applyTemplateSilent(2);
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
function applyTemplateSilent(i) {
  const t = TEMPLATES[i], ids = [];
  for (const [name, items] of t.routines) {
    const r = { id: uid(), name, prog: t.prog, items: [] };
    for (const [exName, sets, lo, , hi, time] of items) { const ex = exByName(exName); if (!ex || !sets) continue; const it = { exId: ex.id, sets, repMin: lo || null, repMax: hi || lo || null }; if (ex.type === 'timed') it.time = time || 30; r.items.push(it); }
    S.routines.push(r); ids.push(r.id);
  }
  for (const d in t.days) S.plan.days[d] = ids[t.days[d]];
  save('routines', 'plan');
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
    if (ex.type === 'timed' && !(s.t > 0)) return toast('Enter seconds or use ▶');
    s.done = true; s.ts = Date.now();
    if (!S.active.editing) {
      const tags = prTags(e.exId, s, records(e.exId, { exclude: S.active.origId || S.active.id }));
      if (tags) { toast(`🏆 New ${tags.join(' & ')} PR — ${ex.name}!`, 3000); beep(2, 1180); }
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
  const e = S.active.entries[+d.e], s = e.sets[+d.s];
  openSheet({ title: 'Set', render: () => `<div class="list"><button class="list-item" data-act="toggleWarm" data-e="${d.e}" data-s="${d.s}"><div class="grow">${s.warm ? 'Mark as working set' : 'Mark as warm-up'}</div></button><button class="list-item" data-act="dupSet" data-e="${d.e}" data-s="${d.s}"><div class="grow">Duplicate set</div></button><button class="list-item" data-act="delSet" data-e="${d.e}" data-s="${d.s}"><div class="grow bad">Delete set</div></button></div>` });
};
A.toggleWarm = (d) => { const s = S.active.entries[+d.e].sets[+d.s]; s.warm = !s.warm; save('active'); closeSheet(); render(); };
A.dupSet = (d) => { const e = S.active.entries[+d.e]; e.sets.splice(+d.s + 1, 0, { ...e.sets[+d.s], id: uid(), done: !!S.active.editing }); save('active'); closeSheet(); render(); };
A.delSet = (d) => { S.active.entries[+d.e].sets.splice(+d.s, 1); save('active'); closeSheet(); render(); };
A.exMenu = (d) => {
  const i = +d.e, e = S.active.entries[i], ex = getEx(e.exId), n = S.active.entries.length;
  const linked = e.ss && S.active.entries[i + 1] && S.active.entries[i + 1].ss === e.ss;
  openSheet({
    title: ex.name,
    render: () => `<div class="list"><button class="list-item" data-act="exDetail" data-id="${e.exId}"><div class="grow">History & records</div><span class="chev">›</span></button>${ex.type === 'weight' ? `<button class="list-item" data-act="addWarmupsM" data-e="${i}"><div class="grow">Auto warm-up sets</div></button>` : ''}<button class="list-item" data-act="plateCalcM" data-e="${i}"><div class="grow">Plate calculator</div></button><button class="list-item" data-act="exNote" data-e="${i}"><div class="grow">${e.note ? 'Edit note' : 'Add note'}</div></button>${i < n - 1 ? `<button class="list-item" data-act="toggleSS" data-e="${i}"><div class="grow">${linked ? 'Unlink superset' : 'Superset with next exercise'}</div></button>` : ''}<button class="list-item" data-act="replaceEx" data-e="${i}"><div class="grow">Replace exercise</div></button>${i > 0 ? `<button class="list-item" data-act="moveEntryM" data-e="${i}" data-d="-1"><div class="grow">Move up</div></button>` : ''}${i < n - 1 ? `<button class="list-item" data-act="moveEntryM" data-e="${i}" data-d="1"><div class="grow">Move down</div></button>` : ''}<button class="list-item" data-act="removeEntry" data-e="${i}"><div class="grow bad">Remove exercise</div></button></div>`
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
A.replaceEx = (d) => { closeSheet(); pickerSheet((ids) => { const e = S.active.entries[+d.e]; const ne = makeEntry(ids[0], e.item ? { ...e.item, exId: ids[0] } : null, e.prog, e.ss, S.active.editing); S.active.entries[+d.e] = ne; save('active'); render(); }, { single: true }); };
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

A.newRoutine = () => { const r = { id: uid(), name: `Routine ${S.routines.length + 1}`, prog: 'double', items: [] }; S.routines.push(r); save('routines'); if (route() !== 'plan') go('plan'); routineSheet(r.id); };
A.editRoutine = (d) => routineSheet(d.id);
A.rProg = (d) => { const r = S.routines.find((x) => x.id === d.id); r.prog = d.v; save('routines'); refreshSheet(); };
A.rMove = (d) => { const r = S.routines.find((x) => x.id === d.id), i = +d.i, j = i + +d.d; if (j < 0 || j >= r.items.length) return; [r.items[i], r.items[j]] = [r.items[j], r.items[i]]; save('routines'); refreshSheet(); };
A.rRemove = (d) => { const r = S.routines.find((x) => x.id === d.id); r.items.splice(+d.i, 1); save('routines'); refreshSheet(); };
A.rAddEx = (d) => pickerSheet((ids) => { const r = S.routines.find((x) => x.id === d.id); ids.forEach((id) => { const ex = getEx(id); r.items.push({ exId: id, sets: ex.type === 'cardio' ? 1 : 3, repMin: ex.type === 'timed' || ex.type === 'cardio' ? null : 8, repMax: ex.type === 'timed' || ex.type === 'cardio' ? null : 12, time: ex.type === 'timed' ? 30 : undefined }); }); save('routines'); refreshSheet(); });
A.rDay = (d) => { S.plan.days[d.d] = S.plan.days[d.d] === d.id ? null : d.id; save('plan'); refreshSheet(); };
A.dupRoutine = (d) => { const r = clone(S.routines.find((x) => x.id === d.id)); r.id = uid(); r.name += ' (copy)'; S.routines.push(r); save('routines'); closeSheet(); routineSheet(r.id); };
A.delRoutine = (d) => confirmSheet('Delete routine?', 'Past workouts are kept.', 'Delete', () => { S.routines = S.routines.filter((r) => r.id !== d.id); for (const k in S.plan.days) if (S.plan.days[k] === d.id) S.plan.days[k] = null; save('routines', 'plan'); closeAllSheets(); render(); });
A.openTemplates = () => openSheet({ title: 'Starter programs', render: () => TEMPLATES.map((t, i) => `<div class="card"><b>${esc(t.name)}</b><div class="small muted">${esc(t.desc)}</div><div class="tiny faint mt">${t.routines.map(([n, items]) => `${esc(n)}: ${items.filter((x) => x[1]).map((x) => x[0]).join(', ')}`).join('<br>')}</div><button class="btn primary sm mt" data-act="applyTemplate" data-i="${i}">Use this program</button></div>`).join('') + '<p class="tiny faint">Adds routines and fills your weekly plan. You can edit everything afterwards.</p>' });
A.applyTemplate = (d) => applyTemplate(+d.i);

A.statsTab = (d) => { UI.statsTab = d.v; render(); };
A.muscleMode = (d) => { UI.muscleMode = d.v; render(); };
A.exDetail = (d) => exDetailSheet(d.id);
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
A.eraseAll = () => confirmSheet('Erase everything?', 'All workouts, routines, body data and settings on this device will be permanently deleted. Back up first!', 'Erase all data', () => {
  confirmSheet('Are you absolutely sure?', 'There is no undo.', 'Yes, erase', async () => {
    Object.assign(S, { settings: { ...DEFAULTS }, custom: [], routines: [], plan: { days: {}, overrides: {} }, workouts: [], active: null, body: [], measures: [], meta: {} });
    KEYS.forEach((k) => dirty.add(k)); flush(); buildEx(); applyTheme(); closeAllSheets(); go('home'); toast('All data erased');
  });
});

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

/* ======================= Theme & boot ======================= */
function applyTheme() {
  const s = S.settings, light = s.theme === 'light' || (s.theme === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.classList.toggle('light', light);
  document.documentElement.style.setProperty('--accent', s.accent);
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
  document.addEventListener('focusin', (e) => { if (e.target.classList && e.target.classList.contains('cell')) setTimeout(() => e.target.select && e.target.select(), 0); });
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  $('#sheet-backdrop').addEventListener('click', () => closeSheet());
  window.addEventListener('hashchange', () => render());
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); else { requestWake(); render(); } });
  window.addEventListener('pagehide', flush);
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);
}

async function boot() {
  await Store.open();
  const vals = await Promise.all(KEYS.map((k) => Store.get(k)));
  KEYS.forEach((k, i) => { if (vals[i] != null) S[k] = vals[i]; });
  S.settings = { ...DEFAULTS, ...S.settings };
  S.plan = { days: {}, overrides: {}, ...S.plan };
  if (!S.meta.created) { S.meta.created = Date.now(); save('meta'); }
  sortW(); buildEx(); applyTheme(); bindEvents(); render(); startTick();
  if (S.active) requestWake();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  // Ask for persistent storage once installed (iOS grants it to Home Screen apps).
  if (standalone() && navigator.storage?.persist) navigator.storage.persisted().then((p) => { if (!p) navigator.storage.persist(); }).catch(() => {});
}
window.__forge = { S, A, render, loadDemo };
boot();
})();
