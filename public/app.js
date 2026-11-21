/* ══════════════════════════════════════════════════════════
   Tastings — count people, hours, km and parking for tasting
   shifts. Sibling of Hours and Pace: same Firebase project,
   its own collections (tastings_days, tastings_config).

   Local-first: every change is saved on this phone at once
   (store.js) and synced to Firestore in the background
   (remote-firebase.js). Nothing here may block counting.
   ══════════════════════════════════════════════════════════ */

import * as pay from "./pay.js";
import * as model from "./model.js";
import * as report from "./report.js";
import { HOLIDAYS_THROUGH, holidayMap } from "./holidays.js";
import { createStore } from "./store.js";

const BUILD = "2026-11-21 · v6";

const Q = new URLSearchParams(location.search);
/* Demo mode (?demo): no sign-in, no Firebase, its own storage. For trying the app out. */
const DEMO = Q.has("demo");
const PREFIX = DEMO ? "tastings-demo:" : "tastings:";

const KIND = {
  weekday: "Weekday", evening: "Weekday after 6 pm",
  saturday: "Saturday", sunday: "Sunday", holiday: "Public holiday"
};
const PROBLEM = {
  noEnd: "This tasting has no finish time.",
  endBeforeStart: "The finish time must be later than the start time. Change one.",
  tooLong: "This tasting is longer than 10 hours.",
  overlap: "Two tastings on this day have the same time. Change the times of one."
};
const TOLL_HINT = "Use roads with no tolls. Tolls are not paid back. If Google Maps shows a toll, turn on Avoid tolls in Maps.";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const t12 = model.time12;
const centsText = c => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

const CHEV_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
const CHEV_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';

/* ── storage and state ────────────────────────────────── */
let storage = null;
try { storage = window.localStorage; storage.getItem(PREFIX + "owner"); } catch (e) { storage = null; }

const ls = {
  get(k) { try { return storage ? storage.getItem(PREFIX + k) : null; } catch (e) { return null; } },
  set(k, v) { try { if (storage) storage.setItem(PREFIX + k, v); } catch (e) { /* full or blocked */ } },
  del(k) { try { if (storage) storage.removeItem(PREFIX + k); } catch (e) { /* ignore */ } }
};

const store = createStore({
  storage, prefix: PREFIX,
  fillConfig: model.withConfigDefaults,
  newDay: model.emptyDay
});

const ui = {
  tab: "today",
  viewDate: pay.todayISO(),
  payDate: pay.todayISO(),
  payView: "slip",               // the Pay tab: "slip" = the payslip only, "more" = days to fix, month, year
  seenToday: pay.todayISO(),     // the calendar day the screens were last lined up with (see rollDay)
  sheet: null,
  pending: false,
  // counter
  counter: false, covered: false, lastAct: Date.now(), tick: null,
  undone: [], backUntil: 0,          // counts just taken off with a minus, newest last, and how long "put back" stays on offer
  wake: null, wakeOn: false,
  // account
  fb: null, fbState: DEMO ? "demo" : "idle", user: null, userMsg: "", authKnown: false,
  // app update
  swReg: null, swWaiting: false, updateAsked: false
};

const cfg = () => store.getConfig();
const today = () => pay.todayISO();
const dayOf = date => store.getDay(date) || model.emptyDay(date);
const ownerFlag = () => ls.get("owner") === "1";
const placeOf = id => (cfg().places || []).find(p => p.id === id);
const activePlaces = () => (cfg().places || []).filter(p => !p.archived)
  .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
const addrOf = id => (id === "home" ? cfg().homeAddress || "" : (placeOf(id) || {}).address || "");
const rateSet = date => pay.rateSetFor(date, cfg().rateSets);
function latestRateIndex(c) {
  let idx = 0;
  c.rateSets.forEach((r, i) => { if (r.from >= c.rateSets[idx].from) idx = i; });
  return idx;
}
/* The set of rates in force today: the one the rate boxes show and change. */
function currentRateIndex(c) {
  const cur = pay.rateSetFor(pay.todayISO(), c.rateSets);
  return Math.max(0, c.rateSets.findIndex(r => r.from === cur.from));
}

let holCache = null, holStamp = null;
function hol() {
  const c = cfg();
  if (!holCache || holStamp !== c.updatedAt) { holCache = holidayMap(c); holStamp = c.updatedAt; }
  return holCache;
}

function saveUI() {
  ls.set("ui", JSON.stringify({ tab: ui.tab, viewDate: ui.viewDate, payView: ui.payView, at: Date.now() }));
}
/* Coming back from Google Maps can reload the app: return to the same tab and day. */
function restoreUI() {
  try {
    const s = JSON.parse(ls.get("ui") || "null");
    if (s && Date.now() - s.at < 10 * 60000) {
      if (["today", "pay", "settings"].includes(s.tab)) ui.tab = s.tab;
      if (/^\d{4}-\d{2}-\d{2}$/.test(s.viewDate || "")) ui.viewDate = s.viewDate;
      if (s.payView === "more") ui.payView = "more";
    }
  } catch (e) { /* start fresh */ }
}

/* An iPhone keeps a Home Screen app in memory overnight. When it comes back on a new calendar
   day, screens that were showing "today" move to the new today. A day picked on purpose, an
   open sheet and a running Counter are left alone (it is tried again on the next check). */
function rollDay() {
  const t = today();
  if (t === ui.seenToday) return false;
  if (ui.sheet || ui.counter) return false;
  // not under a field that is being typed in: what it saves belongs to the day on screen
  const f = document.activeElement;
  if (f && /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName)) return false;
  if (ui.viewDate === ui.seenToday) ui.viewDate = t;
  if (ui.payDate === ui.seenToday) ui.payDate = t;
  ui.calMonth = null;
  ui.seenToday = t;
  saveUI();
  return true;
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

async function copyText(text, done = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-999px;top:0;font-size:16px";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e2) { ok = false; }
    ta.remove();
    toast(ok ? done : "Could not copy. Press and hold the text to copy it.");
  }
}

/* Hand a piece of text to the phone's share sheet (Messages, WhatsApp, Mail …).
   Where sharing is not possible the text is copied instead. */
async function shareText(text, copied = "Copied") {
  if (navigator.share) {
    try { await navigator.share({ text }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }       // the share sheet was closed
  }
  copyText(text, copied);
}

/* How full this app's storage on the phone is, 0–100. A browser allows about 5 MB,
   and text takes two bytes a character. null when it cannot be read. */
function storageUsed() {
  if (!storage) return null;
  try {
    let chars = 0;
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k) chars += k.length + (storage.getItem(k) || "").length;
    }
    return Math.min(100, Math.round((chars * 2 * 100) / (5 * 1024 * 1024)));
  } catch (e) { return null; }
}

/* When did changes first start waiting to be backed up? 0 when nothing is waiting.
   Kept across restarts, so "only on this phone for more than a day" can be noticed. */
function waitingSince() {
  if (DEMO) return 0;
  const at = Number(ls.get("dirtySince")) || 0;
  if (!store.status().dirty) { if (at) ls.del("dirtySince"); return 0; }
  if (at) return at;
  ls.set("dirtySince", String(Date.now()));
  return Date.now();
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function syncLine() {
  const s = store.status();
  if (DEMO) return "Demo — nothing here is saved to your account";
  if (!ui.user) return ui.authKnown ? "Not signed in — saved on this phone only" : (ui.fbState === "offline" ? "Offline — saved on this phone" : "Connecting…");
  if (s.dirty) {
    return s.remote === "online"
      ? `Backing up ${plural(s.dirty, "change")}…`
      : `Saved on this phone. ${plural(s.dirty, "change")} will be backed up when you are online`;
  }
  if (s.lastSync) return `Backed up to your account ${ago(s.lastSync)}`;
  return navigator.onLine === false ? "Offline — saved on this phone" : "Connecting…";
}
/* For the Counter's one-line status ("Saved · … · Screen stays on"): a word or two, never more. */
function shortSync() {
  const s = store.status();
  if (DEMO) return "Demo";
  if (!ui.user) return ui.authKnown ? "Not signed in" : "Offline";
  if (s.dirty) return s.remote === "online" ? "Backing up…" : "Offline";
  return "Backed up";
}

/* ══════════════════════════════════════════════════════════
   RENDERING
   A view is redrawn whole. Two guards keep that safe:
   - never while a finger is down (the tap would lose its target);
   - never while someone is typing in that view (redrawn on blur).
   The Counter and the tasting sheet are only ever updated in place.
   ══════════════════════════════════════════════════════════ */
let ptrDown = false, queued = false;
let inChange = false, deferred = false;

function render() {
  if (ui.counter) { paintCounter(); return; }
  if (ptrDown) { queued = true; return; }
  // A field saves itself as it is left. On the iPhone that happens while the finger is already
  // up and the NEXT field has not received focus yet: redrawing now would destroy the field
  // just tapped and close the keyboard. Wait one tick; by then the new field has focus and the
  // typing guard in paint() holds the redraw until the fields are left.
  if (inChange) {
    if (!deferred) { deferred = true; setTimeout(() => { deferred = false; render(); }, 0); }
    return;
  }
  paint();
}

function typing(el) {
  const a = document.activeElement;
  return !!a && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}

function paint() {
  queued = false;
  paintChrome();
  const views = { today: "#viewToday", pay: "#viewPay", settings: "#viewSettings" };
  for (const k in views) $(views[k]).hidden = ui.tab !== k;
  const el = $(views[ui.tab]);
  if (typing(el)) { ui.pending = true; return; }
  ui.pending = false;
  if (ui.tab === "today") paintToday(el);
  else if (ui.tab === "pay") paintPay(el);
  else paintSettings(el);
}

function paintChrome() {
  $("#demoPill").hidden = !DEMO;
  $("#updateBar").hidden = !(ui.swWaiting && !store.runningVisit());
  const signOff = !DEMO && ui.authKnown && !ui.user && ownerFlag();
  $("#signBar").hidden = !signOff;
  $("#storeBar").hidden = store.status().storageOk;
  // Changes that have been waiting more than a day: the phone is the only copy. Say so.
  const since = waitingSince();
  $("#waitBar").hidden = !(since && Date.now() - since > 24 * 3600000 && !signOff);
  document.querySelectorAll("#tabs .tab").forEach(b => b.classList.toggle("on", b.dataset.tab === ui.tab));
}

/* ── Today ────────────────────────────────────────────── */
function chipFor(date, day) {
  const h = hol();
  const kind = pay.dayKind(date, h, day.paidAs);
  const rate = rateSet(date)[kind];
  const per = `${pay.money(rate)}/h`;
  if (day.paidAs) return { cls: "set", text: `${KIND[kind]} · ${per} · set by you` };
  if (kind === "holiday") return { cls: "hol", text: `Public holiday: ${h.get(date) || ""} · ${per}` };
  return { cls: "", text: `${KIND[kind]} · ${per}` };
}

/** " (63%)" — the share of interactions that were a sample given; "" when nothing was counted. */
const pctText = n => (n.talked ? ` (${Math.round((n.sampled * 100) / n.talked)}%)` : "");
/** The numbers of one tasting, or of several added up, in one line. `sold` = show the Sold part. */
const countsText = (n, sold) =>
  `${plural(n.talked, "interaction")} · ${plural(n.sampled, "sample")}${pctText(n)} · ${n.declined} rejected or ignored${sold ? ` · ${n.sold} sold` : ""}`;

const shiftText = v => (v.paidEnd ? `${t12(v.paidStart)} – ${t12(v.paidEnd)}` : `from ${t12(v.paidStart)}`);
/* A tasting still to be done: added, not started, nothing counted. (One whose counts were typed
   in by hand was done without the phone; it is not waiting for anything.) */
const isWaiting = v => model.isPlanned(v) && model.counts(v).talked === 0;
/* The day's tastings in clock order — the same rule the trips are built with (model.rebuildLegs). */
const byStart = (a, b) => {
  const x = pay.toMin(a.paidStart), y = pay.toMin(b.paidStart);
  return (x == null ? 1e9 : x) - (y == null ? 1e9 : y) || (a.startedAt || 0) - (b.startedAt || 0);
};

/* One tasting on Today. A running one opens the Counter; any other opens its sheet.
   (Starting is done from the big "next step" card at the top, or from the sheet.) */
function visitCard(day, v) {
  const c = cfg(), n = model.counts(v);
  const run = model.isRunning(v), planned = model.isPlanned(v);
  const probs = pay.visitProblems(day, v);
  const lines = probs.length ? [] : pay.visitLines(v, day.date, c, hol(), day.paidAs);
  const cents = lines.reduce((a, l) => a + l.cents, 0);
  const mins = lines.reduce((a, l) => a + l.minutes, 0);
  let when;
  if (probs.length) when = PROBLEM[probs[0]];
  else if (run) when = `${shiftText(v)} · counting now`;
  else when = `${shiftText(v)} · ${pay.hm(mins)}`;
  const countLine = planned && n.talked === 0 ? "Not started yet" : countsText(n, model.tracksSold(v));
  // with flavours: each one's samples and sold, so the favourite shows at a glance
  const flavLine = n.flav.length && n.talked > 0
    ? n.flav.map(f => `${f.name} ${f.sampled}${f.sold ? ` (${f.sold} sold)` : ""}`).join(" · ") : "";
  const what = [v.brand, !flavLine && n.flav.length ? n.flav.map(f => f.name).join(", ") : ""].filter(Boolean).join(" · ");
  return `<div class="vcard ${probs.length ? "bad" : ""} ${run ? "live" : ""}">
    <button class="vcard-open" data-act="${run ? "openCounter" : "visit"}" data-id="${esc(v.id)}">
      <div class="row-main">
        <p class="row-t">${esc(v.placeName)}</p>
        ${what ? `<p class="row-s">${esc(what)}</p>` : ""}
        <p class="row-s">${esc(when)}</p>
        <p class="row-s">${esc(countLine)}</p>
        ${flavLine ? `<p class="row-s">${esc(flavLine)}</p>` : ""}
      </div>
      <span class="row-v">${lines.length ? pay.money(cents) : ""}</span>
    </button>
  </div>`;
}

function legRow(day, leg, i) {
  const c = cfg();
  const key = `${leg.from}>${leg.to}`;
  const mem = (c.kmMemory || {})[key];
  const has = typeof leg.tenths === "number";
  const whole = model.hasDayKm(day);               // one figure covers the whole day: this trip is inside it
  let sub;
  if (leg.skip) sub = '<span class="leg-s">Not driven — no km paid</span>';
  else if (whole) sub = '<span class="leg-s">In the whole-day km below</span>';
  else if (has && leg.checkedOn) {
    sub = `<span class="leg-s">checked ${esc(model.dateText(leg.checkedOn, false))}${leg.checkedTime ? ", " + esc(t12(leg.checkedTime)) : ""}</span>`;
  } else if (has) sub = '<span class="leg-s">km entered</span>';
  else if (mem && mem.stale) sub = `<span class="leg-s warn">Address changed — check the km again (was ${pay.kmText(mem.tenths)} km)</span>`;
  else sub = null;

  const from = addrOf(leg.from), to = addrOf(leg.to);
  const url = model.mapsUrl(from, to, c.avoidTolls !== false);
  const missingAddr = !from ? leg.from : !to ? leg.to : null;
  if (sub == null) {
    sub = `<span class="leg-s warn">${url ? "Tap Maps, then type the km here" : "Tap Add address first, then type the km here"}</span>`;
  }
  const link = url
    ? `<a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener">Maps</a>`
    : `<button class="btn btn-sm" data-act="place" data-id="${esc(missingAddr)}">Add address</button>`;

  return `<div class="leg ${!has && !leg.skip && !whole ? "miss" : ""} ${leg.skip || whole ? "skip" : ""} ${whole ? "inwhole" : ""}">
    <span class="leg-t">${esc(leg.fromName)} → ${esc(leg.toName)}</span>
    ${sub}
    <input class="km" inputmode="decimal" autocomplete="off" placeholder="km" aria-label="Km for ${esc(leg.fromName)} to ${esc(leg.toName)}"
      value="${has ? pay.kmText(leg.tenths) : ""}" data-chg="km" data-i="${i}" ${leg.skip || whole ? "disabled" : ""}>
    ${link}
    <div class="leg-foot"><span></span><button class="linkish" data-act="skipLeg" data-i="${i}">${leg.skip ? "I drove this trip" : "I did not drive this trip"}</button></div>
  </div>`;
}

/* One km figure for the whole day: the route home → every store → home opens as ONE Google Maps
   route, and its total is typed once. Offered beside the per-trip boxes, never instead of them. */
function dayKmRow(day) {
  const legs = day.legs || [];
  if (legs.length < 2 || legs.some(l => l.skip)) return "";
  const has = model.hasDayKm(day);
  const stops = legs.map(l => l.from).concat(legs[legs.length - 1].to);
  const url = model.mapsDayUrl(stops.map(addrOf), cfg().avoidTolls !== false);
  return `<div class="leg daykm ${has ? "on" : ""}" id="dayKm">
    <span class="leg-t">Whole day: one km number</span>
    <span class="leg-s">${has
      ? `This is the day's km${day.kmDayOn ? ` · checked ${esc(model.dateText(day.kmDayOn, false))}` : ""}. Delete this number to type the km for each trip.`
      : url ? "Or tap Maps here, read the total km for the whole day, and type it once."
        : "Or type the total km for the whole day here. Add every address to get the Maps button."}</span>
    <input class="km" inputmode="decimal" autocomplete="off" placeholder="km" aria-label="Km for the whole day"
      value="${has ? pay.kmText(day.kmDay) : ""}" data-chg="kmDay">
    ${url ? `<a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener">Maps</a>` : "<span></span>"}
  </div>`;
}

function sumRows(t, hoursFmt) {
  const rows = t.lines.map(l =>
    `<div class="sum-row"><span>${KIND[l.kind]} <small>${hoursFmt(l.minutes)} × ${pay.money(l.rate)}</small></span><b>${pay.money(l.cents)}</b></div>`);
  if (!rows.length) rows.push('<div class="sum-row"><span>Hours</span><b>$0.00</b></div>');
  return rows.join("");
}

/* The first-time guide: four things to do once. It goes away by itself when all are done. */
function setupCard(c) {
  const s = c.setup || {};
  if (s.hidden) return "";
  const hasTasting = store.listDays().some(d => (d.visits || []).length);
  const steps = [
    { done: !!c.homeAddress, text: "Add your home address", attrs: 'data-act="place" data-id="home"', btn: "Add" },
    { done: !!s.ratesChecked, text: "Check your pay rates and pay period", attrs: 'data-act="setupRates"', btn: "Check" },
    { done: !!s.tollsDone, text: "Turn on Avoid tolls in Google Maps", attrs: 'data-act="setupTolls"', btn: "Show me" },
    { done: hasTasting, text: "Add your first tasting", attrs: 'data-act="addTasting"', btn: "Add" }
  ];
  if (steps.every(x => x.done)) return "";
  return `<div class="panel setup">
    <div class="panel-head"><h2>First steps</h2><button class="linkish" data-act="setupHide">Hide</button></div>
    <div class="rows">${steps.map((x, i) => `<div class="row ${x.done ? "done" : ""}">
        <span class="step-n">${x.done ? "✓" : i + 1}</span>
        <div class="row-main"><p class="row-t">${x.text}</p></div>
        ${x.done ? "" : `<button class="btn btn-sm" ${x.attrs}>${x.btn}</button>`}</div>`).join("")}</div>
  </div>`;
}

/* The pay week (or fortnight) that holds this day, in one line. Tap to open Pay on it. */
function periodLine(date) {
  const c = cfg();
  const { start, end } = pay.periodOf(date, c.payPeriod);
  const t = pay.periodTotals(store.listDays(), c, hol(), start, end);
  const word = c.payPeriod.days === 14 ? "fortnight" : "week";
  const here = today() >= start && today() <= end;
  return `<button class="weekline" data-act="openPay" data-date="${date}">
    <span>${here ? "This pay " + word : "Pay " + word + " of " + esc(model.dateText(start, false))}</span>
    <b>${pay.money(t.totalCents)}</b>
    <small>${pay.hm(t.hoursMin)} · ${pay.kmText(t.kmTenths)} km · see the payslip</small>
  </button>`;
}

/* The day from top to bottom, the way it is driven: home, the trip, the tasting, the next trip,
   the next tasting, the trip home. Each trip sits between the two places it joins. */
function dayRoute(day, visits) {
  const legs = day.legs || [];
  const home = '<div class="tl-home">Home</div>';
  const out = [home];
  let li = 0;
  visits.forEach((v, i) => {
    if ((i === 0 || visits[i - 1].placeId !== v.placeId) && legs[li]) { out.push(legRow(day, legs[li], li)); li++; }
    out.push(visitCard(day, v));
  });
  while (li < legs.length) { out.push(legRow(day, legs[li], li)); li++; }
  out.push(home);
  return out.join("");
}

/* The one thing to do next, as one big card at the top of today. It changes through the day:
   start the first tasting, go back to counting, start the next one, type the km, send the report. */
function nextCard(day, visits, t, run) {
  const c = cfg();
  if (run) {
    const v = run.visit;
    return `<div class="panel next live">
      <p class="next-k">Counting now</p>
      <p class="next-t">${esc(v.placeName)}</p>
      <p class="next-s">${esc(shiftText(v))}</p>
      <button class="btn btn-go btn-big" data-act="openCounter">Back to counting</button>
    </div>`;
  }
  if (!visits.length) return "";
  const i = visits.findIndex(isWaiting);
  if (i >= 0) {
    const v = visits[i];
    const from = i === 0 ? "home" : visits[i - 1].placeId;
    const url = from !== v.placeId ? model.mapsUrl(addrOf(from), addrOf(v.placeId), c.avoidTolls !== false) : null;
    return `<div class="panel next">
      <p class="next-k">${i === 0 ? "First tasting today" : "Next tasting"}</p>
      <p class="next-t">${esc(v.placeName)}</p>
      <p class="next-s">${esc(shiftText(v))}${v.brand ? " · " + esc(v.brand) : ""}</p>
      <div class="next-btns">
        ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Directions</a>` : ""}
        <button class="btn btn-go" data-act="startVisit" data-id="${esc(v.id)}">Start counting</button>
      </div>
    </div>`;
  }
  if (t.problems.length) return "";
  if (t.missingKm) {
    return `<div class="panel next">
      <p class="next-k">Last step for today</p>
      <p class="next-t">Type today's km</p>
      <p class="next-s">${plural(t.missingKm, "trip")} still ${t.missingKm === 1 ? "has" : "have"} no km.</p>
      <button class="btn btn-primary btn-big" data-act="toKm">Go to the km</button>
    </div>`;
  }
  return `<div class="panel next done">
    <p class="next-k">All done for today</p>
    <p class="next-t">Send your report</p>
    <p class="next-s">The counts, the km and the parking in one message.</p>
    <button class="btn btn-primary btn-big" data-act="dayReport">See the day report</button>
  </div>`;
}

function paintToday(el) {
  const date = ui.viewDate, isToday = date === today();
  const c = cfg(), h = hol(), day = dayOf(date);
  const t = pay.dayTotals(day, c, h);
  const chip = chipFor(date, day);
  const run = store.runningVisit();
  const visits = (day.visits || []).slice().sort(byStart);

  const parts = [];

  parts.push(`<div class="panel">
    <div class="dateline">
      <button class="nav-btn" data-act="prevDay" aria-label="Previous day">${CHEV_L}</button>
      <label class="datepick">${esc(model.dateText(date, false))}${isToday ? " · today" : ""}
        <input type="date" value="${date}" data-chg="viewDate" aria-label="Pick a day"></label>
      <button class="nav-btn" data-act="nextDay" aria-label="Next day">${CHEV_R}</button>
    </div>
    <div class="dateline-s">
      <button class="paidas ${chip.cls}" data-act="paidAs">${esc(chip.text)} · change</button>
      ${isToday ? "" : '<button class="linkish" data-act="goToday">Back to today</button>'}
    </div>
    ${date > HOLIDAYS_THROUGH ? `<p class="panel-foot">The public holiday list ends in ${esc(HOLIDAYS_THROUGH.slice(0, 4))}. If this day is a public holiday, tap the button above and choose Public holiday.</p>` : ""}
  </div>`);

  if (run && run.date !== date) {
    parts.push(`<button class="row live" data-act="openCounter">
      <div class="row-main"><p class="row-t">A tasting is running at ${esc(run.visit.placeName)}</p>
      <p class="row-s">Tap to go back to counting</p></div></button>`);
  }

  const guide = setupCard(c);
  if (guide) parts.push(guide);
  else if (!c.homeAddress) {
    parts.push(`<button class="warn-row" data-act="place" data-id="home">Tap here to add your home address. Every day's trips start and end at home.</button>`);
  }

  if (isToday) {
    const next = nextCard(day, visits, t, run && run.date === date ? run : null);
    if (next) parts.push(next);
    // Earlier days with something still to enter (km, counts, a tasting never finished).
    const fix = report.todoList(store.listDays(), c, h, date, 60).filter(d => d.date !== date);
    if (fix.length) {
      parts.push(`<button class="warn-row" data-act="openFix">${plural(fix.length, "earlier day")} still ${fix.length === 1 ? "needs" : "need"} something. Tap to see ${fix.length === 1 ? "it" : "them"}.</button>`);
    }
  }

  // The day's plan, read from top to bottom.
  parts.push(`<div class="panel lead">
    <div class="panel-head"><h2>${isToday ? "Today's plan" : "Plan for this day"}</h2>
      ${visits.length ? `<span class="row-v">${pay.kmText(t.kmTenths)} km</span>` : ""}</div>
    ${visits.length
      ? `<div class="tl">${dayRoute(day, visits)}</div>${dayKmRow(day)}`
      : `<p class="empty">${isToday
          ? "Add today's tastings. For each one: the store, its address and the shift times."
          : "Nothing on this day yet."}</p>`}
    <button class="btn ${visits.length ? "" : "btn-go"} btn-big" data-act="addTasting" style="margin-top:12px">${visits.length ? "Add another tasting" : "Add a tasting"}</button>
    ${visits.length ? `<p class="panel-foot">${TOLL_HINT}</p>` : ""}
  </div>`);

  parts.push(`<div class="panel">
    <div class="panel-head"><h2>Parking</h2><button class="btn btn-sm" data-act="addPark">Add parking</button></div>
    <div class="rows">${(day.parking || []).length ? day.parking.map(p => `<button class="row" data-act="park" data-id="${esc(p.id)}">
        <div class="row-main"><p class="row-t">${esc(p.note || "Parking")}</p></div><span class="row-v">${pay.money(p.cents)}</span></button>`).join("")
      : '<p class="empty">No parking on this day.</p>'}</div>
    ${(day.parking || []).length ? '<p class="panel-foot">Keep the receipt for each one.</p>' : ""}
  </div>`);

  // What still needs doing on this day, in plain words. Nothing left = the day is complete.
  const todo = [];
  if (t.missingKm) todo.push(`Type the km for ${plural(t.missingKm, "trip")} — not in the total yet`);
  if (t.running) {
    const rv = (day.visits || []).find(v => model.isRunning(v));
    todo.push(rv && rv.paidEnd
      ? "A tasting is still running — go back to counting, then tap Finish tasting"
      : "A tasting is still running — its hours are not in the total yet");
  }
  if (t.problems.length) todo.push("A tasting has wrong times — tap it to fix them");
  if (date < today()) {
    for (const v of visits) {
      if (!model.isRunning(v) && !v.zeroOk && model.counts(v).talked === 0) todo.push(`No counts entered for ${v.placeName} — tap it to type them`);
    }
  }
  const people = visits.reduce((a, v) => {
    const n = model.counts(v);
    a.talked += n.talked; a.sampled += n.sampled; a.declined += n.declined; a.sold += n.sold;
    return a;
  }, { talked: 0, sampled: 0, declined: 0, sold: 0 });
  const anySold = visits.some(model.tracksSold);
  const counted = visits.length > 0 && visits.every(v => !model.isRunning(v) && (model.counts(v).talked > 0 || v.zeroOk));

  parts.push(`<div class="panel">
    <div class="panel-head"><h2>Day total</h2></div>
    <div class="sum">
      ${sumRows(t, pay.hm)}
      <div class="sum-row"><span>Travel <small>${pay.kmText(t.kmTenths)} km × ${pay.money(t.kmRate)}</small></span><b>${pay.money(t.kmCents)}</b></div>
      <div class="sum-row"><span>Parking</span><b>${pay.money(t.parkingCents)}</b></div>
    </div>
    <div class="sum-total"><span>Total payout, before tax</span><b>${pay.money(t.totalCents)}</b></div>
    ${people.talked || people.sold ? `<p class="panel-foot">All tastings: ${esc(countsText(people, anySold))}</p>` : ""}
    ${todo.length ? `<div class="warns">${todo.map(w => `<div class="warn-row">${esc(w)}</div>`).join("")}</div>`
      : counted ? '<div class="ok-row">Day complete. Everything is entered.</div>' : ""}
    ${visits.length ? '<button class="btn btn-big" data-act="dayReport" style="margin-top:12px">See the day report</button>' : ""}
  </div>
  ${periodLine(date)}
  <p class="syncline">${esc(syncLine())}</p>`);

  el.innerHTML = parts.join("");
}

/* ── Pay ──────────────────────────────────────────────── */
/* The pay period on screen as a payslip. Worked out fresh every time (report.payslipData). */
function payData() {
  return report.payslipData(store.listDays(), cfg(), hol(), ui.payDate, today());
}
const payText = () => report.payslipText(payData());

/* Recent days that still need something: km not typed, a time problem, counts not entered. */
/* Days that still need something, newest first. Today is only listed once its tastings are
   over: until then its km is simply not typed yet. */
function fixList(lookbackDays) {
  const todayOpen = (dayOf(today()).visits || []).some(v => model.isRunning(v) || isWaiting(v));
  return report.todoList(store.listDays(), cfg(), hol(), today(), lookbackDays)
    .filter(d => d.date !== today() || !todayOpen);
}

function fixPanel() {
  const list = fixList(60);
  if (!list.length) return "";
  return `<div class="panel">
    <div class="panel-head"><h2>Days to fix</h2><span class="row-v">${list.length}</span></div>
    <div class="rows">${list.slice(0, 6).map(d => `<button class="row" data-act="goto" data-date="${d.date}">
        <div class="row-main"><p class="row-t">${esc(model.dateText(d.date, false))}</p>
        ${d.issues.map(i => `<p class="row-s warn">${esc(i)}</p>`).join("")}</div>
        <span class="row-v">Fix</span></button>`).join("")}</div>
    <p class="panel-foot">Tap a day to open it and enter what is missing.${list.length > 6 ? ` ${list.length - 6} more are orange in the calendar below.` : ""}</p>
  </div>`;
}

/* A month at a glance: what each day is worth, and which days still need something. */
function calendarPanel() {
  const g = report.monthGrid(ui.calMonth || today().slice(0, 7), store.listDays(), cfg(), hol());
  const toFix = new Set(fixList(400).map(d => d.date));      // the same days "Days to fix" lists
  const cell = c => {
    if (!c) return '<span class="cell pad"></span>';
    const fix = toFix.has(c.date);
    const cls = [c.tastings ? "has" : "", fix ? "fix" : "", c.date === today() ? "today" : "", c.kind === "holiday" ? "hol" : ""].join(" ");
    const label = `${model.dateText(c.date, false)}${c.holidayName ? ", " + c.holidayName : ""}${c.tastings ? ", " + pay.money(c.totalCents) : ""}`;
    return `<button class="cell ${cls}" data-act="goto" data-date="${c.date}" aria-label="${esc(label)}">
      <span class="cell-d">${c.dayNum}</span><span class="cell-v">${c.tastings ? "$" + Math.round(c.totalCents / 100) : ""}</span></button>`;
  };
  const t = g.totals;
  return `<div class="panel">
    <div class="panel-head">
      <button class="nav-btn" data-act="calMonth" data-ym="${g.prev}" aria-label="Previous month">${CHEV_L}</button>
      <h2 style="text-align:center">${esc(g.label)}</h2>
      <button class="nav-btn" data-act="calMonth" data-ym="${g.next}" aria-label="Next month">${CHEV_R}</button>
    </div>
    <div class="cal-head"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span></div>
    <div class="cal">${g.weeks.map(w => w.map(cell).join("")).join("")}</div>
    <div class="mo-stats">
      <div class="stat"><p class="stat-v">${pay.money(t.totalCents)}</p><p class="stat-l">Pay before tax</p></div>
      <div class="stat"><p class="stat-v">${pay.hoursDec(t.hoursMin)}</p><p class="stat-l">Hours</p></div>
      <div class="stat"><p class="stat-v">${pay.kmText(t.kmTenths)}</p><p class="stat-l">Km</p></div>
    </div>
    <p class="panel-foot">Tap a day to open it. Orange days still need something. ${t.tastings ? `${plural(t.tastings, "tasting")} this month: ${esc(countsText(t, t.sold > 0))}.` : ""}</p>
  </div>`;
}

/* Hand a file to the phone's share sheet (Files, Mail, Drive …); download it where that is not possible. */
async function shareFile(name, mime, text) {
  try {
    const file = new File([text], name, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return true;
    }
  } catch (e) {
    if (e && e.name === "AbortError") return false;        // the share sheet was closed
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast("File saved");
    return true;
  } catch (e) {
    copyText(text, "Copied instead. Paste it into a note.");
    return false;
  }
}

function paintPay(el) {
  const view = ui.payView === "more" ? "more" : "slip";
  el.innerHTML = `
  <div class="seg payseg">
    <button class="${view === "slip" ? "on" : ""}" data-act="payView" data-view="slip">Payslip</button>
    <button class="${view === "more" ? "on" : ""}" data-act="payView" data-view="more">Days and year</button>
  </div>
  ${view === "slip" ? payslipHtml() : payMoreHtml()}`;
}

/* Asked once, at the top of the payslip: how often the user is paid and which pay period they
   are in now. One or two taps settle both the length and the day a period starts on. */
function periodCard() {
  const c = cfg();
  if (c.payPeriod.confirmed) return "";
  // fortnights first (the two that can hold today when a fortnight starts on a Monday), then the
  // week; and the period the app is using now when it is none of those
  const options = [
    ...report.periodChoices(today(), 14).map(x => ({ ...x, days: 14 })),
    ...report.periodChoices(today(), 7).map(x => ({ ...x, days: 7 }))
  ];
  const curDays = c.payPeriod.days === 14 ? 14 : 7, cur = pay.periodOf(today(), c.payPeriod);
  if (!options.some(x => x.days === curDays && x.start === cur.start)) options.push({ ...cur, days: curDays });
  return `<div class="panel setup">
    <div class="panel-head"><h2>How are you paid?</h2></div>
    <p class="hint">Tap the pay period you are in now. Look at your last payslip: the next one starts the day after that one ends.</p>
    <div class="rows" style="margin-top:10px">${options.map(x => `<button class="row" data-act="periodPick" data-start="${x.start}" data-days="${x.days}">
        <div class="row-main"><p class="row-t">${esc(model.dateText(x.start, false))} – ${esc(model.dateText(x.end, false))}</p>
          <p class="row-s">${x.days === 14 ? "Paid every fortnight" : "Paid every week"}</p></div>
        <span class="row-v">This one</span></button>`).join("")}</div>
    <p class="panel-foot">None of these? <button class="linkish" data-act="setupRates">Choose another start day</button></p>
  </div>`;
}

/* The payslip: only the payout. Hours by pay type, total hours, pay for hours, travel and
   parking as their own lines, the total, then the days one by one. */
function payslipHtml() {
  const s = payData();
  const word = s.periodDays === 14 ? "fortnight" : "week";
  const hourRows = s.lines.length
    ? s.lines.map(l => `<div class="sum-row"><span>${KIND[l.kind]} <small>${pay.hoursDec(l.minutes)} h × ${pay.money(l.rate)}</small></span><b>${pay.money(l.cents)}</b></div>`).join("")
    : '<div class="sum-row"><span>No hours in this ' + word + ' yet</span><b>$0.00</b></div>';
  const kmRows = s.kmLines.length
    ? s.kmLines.map(k => `<div class="sum-row"><span>Travel <small>${pay.kmText(k.tenths)} km × ${pay.money(k.rate)}</small></span><b>${pay.money(k.cents)}</b></div>`).join("")
    : '<div class="sum-row"><span>Travel <small>0.0 km</small></span><b>$0.00</b></div>';

  // what makes the total "not final yet": each reason says whether it is in the total or not
  const pending = s.pending.map(p => (p.code === "open" || !p.date
    ? `<div class="info-row">${esc(report.pendingText(p, word))}</div>`
    : `<button class="warn-row" data-act="goto" data-date="${p.date}">${esc(report.pendingText(p, word))}</button>`)).join("");

  let verdict = "";
  const v = s.verdict;
  if (v.status === "match") verdict = '<div class="ok-row">Your payslip matches.</div>';
  else if (v.status === "short") verdict = `<div class="warn-row">Your payslip is ${pay.money(-v.diffCents)} less than this total. Compare each line above with the payslip.</div>`;
  else if (v.status === "over") verdict = `<div class="ok-row">Your payslip is ${pay.money(v.diffCents)} more than this total.</div>`;

  const dayRows = s.days.map(d => {
    const flags = report.dayFlags(d);
    return `<button class="row" data-act="goto" data-date="${d.date}">
      <div class="row-main"><p class="row-t">${esc(model.dateText(d.date, false))}</p>
        ${d.stores.length ? `<p class="row-s">${esc(d.stores.join(", "))}</p>` : ""}
        <p class="row-s">${pay.hoursDec(d.hoursMin)} h = ${pay.money(d.hoursCents)} · travel ${pay.money(d.kmCents)} · parking ${pay.money(d.parkingCents)}</p>
        ${flags.length ? `<p class="row-s warn">${esc(flags.join(" · "))}</p>` : ""}</div>
      <span class="row-v">${pay.money(d.totalCents)}</span></button>`;
  }).join("");
  const rounding = s.roundingCents
    ? `<div class="row"><div class="row-main"><p class="row-t">Rounding</p>
        <p class="row-s">Pay is rounded once for the whole ${word}, not day by day.</p></div>
        <span class="row-v">${pay.money(s.roundingCents)}</span></div>` : "";

  return `
  ${periodCard()}
  <div class="panel">
    <div class="dateline">
      <button class="nav-btn" data-act="prevPeriod" aria-label="Previous ${word}">${CHEV_L}</button>
      <div class="datepick" style="font-size:17px">${esc(model.dateText(s.start, false))} – ${esc(model.dateText(s.end, false))}</div>
      <button class="nav-btn" data-act="nextPeriod" aria-label="Next ${word}">${CHEV_R}</button>
    </div>
    <div class="dateline-s">
      <span class="hint">${s.isCurrent ? `This pay ${word}` : s.isFuture ? `A pay ${word} that has not started` : `A past pay ${word}`} · <button class="linkish" data-act="setupRates">change</button></span>
      ${s.isCurrent ? "" : `<button class="linkish" data-act="thisPeriod">Back to this ${word}</button>`}
    </div>
  </div>

  <div class="panel lead slip">
    <div class="panel-head"><h2>Payslip</h2>${s.final ? "" : '<span class="pill pill-wait">Not final yet</span>'}</div>
    <p class="lab">Hours</p>
    <div class="sum">
      ${hourRows}
      <div class="sum-row strong"><span>Total hours</span><b>${pay.hoursDec(s.hoursMin)} h</b></div>
      <div class="sum-row strong"><span>Pay for hours</span><b>${pay.money(s.hoursCents)}</b></div>
    </div>
    <p class="lab" style="margin-top:14px">Travel and parking</p>
    <div class="sum">
      ${kmRows}
      <div class="sum-row"><span>Parking</span><b>${pay.money(s.parkingCents)}</b></div>
    </div>
    <div class="sum-total"><span>Total payout, before tax${s.final ? "" : "<small>not final yet</small>"}</span><b>${pay.money(s.totalCents)}</b></div>
    ${pending ? `<div class="warns">${pending}</div>` : s.days.length ? `<div class="warns"><div class="ok-row">This ${word} is complete.</div></div>` : ""}
    <div class="f" style="margin-top:12px"><label>What your real payslip says, before tax ($)</label>
      <input inputmode="decimal" autocomplete="off" placeholder="Type it on pay day" value="${typeof s.paidCents === "number" ? centsText(s.paidCents) : ""}" data-chg="paid" data-key="${s.paidKey}"></div>
    ${verdict ? `<div class="warns">${verdict}</div>` : '<p class="panel-foot">On pay day, type the total from your payslip before tax is taken off. The app tells you if it matches. This app does not calculate tax or super.</p>'}
    <div class="f-actions" style="margin-top:12px">
      <button class="btn btn-primary" data-act="sharePay">Share payslip</button>
      <button class="btn btn-ghost" data-act="copyPay">Copy</button>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h2>Day by day</h2></div>
    <div class="rows">${dayRows || `<p class="empty">No work days in this ${word}.</p>`}${rounding}</div>
  </div>

  ${historyPanel(word)}`;
}

/* Past pay periods: what was expected, and whether the real payslip matched. */
function historyPanel(word) {
  const list = report.paidHistory(store.listDays(), cfg(), hol(), today(), 6);
  if (!list.length) return "";
  const status = h => {
    if (h.status === "match") return ["Paid in full", "ok"];
    if (h.status === "short") return [`Short by ${pay.money(-h.diffCents)}`, "warn"];
    if (h.status === "over") return [`${pay.money(h.diffCents)} more`, "ok"];
    return ["Not checked", ""];
  };
  return `<div class="panel">
    <div class="panel-head"><h2>Earlier ${word}s</h2></div>
    <div class="rows">${list.map(h => {
      const [text, cls] = status(h);
      return `<button class="row" data-act="openPay" data-date="${h.start}">
        <div class="row-main"><p class="row-t">${esc(model.dateText(h.start, false))} – ${esc(model.dateText(h.end, false))}</p>
          <p class="row-s ${cls}">${esc(text)}${h.notFinal ? " · something still to fix" : ""}</p></div>
        <span class="row-v">${pay.money(h.expectedCents)}</span></button>`;
    }).join("")}</div>
    <p class="panel-foot">Tap one to see its payslip.</p>
  </div>`;
}

/* The second view: days that still need something, the month, the year, and the spreadsheet. */
function payMoreHtml() {
  const c = cfg(), s = payData(), all = store.listDays();
  const word = s.periodDays === 14 ? "fortnight" : "week";
  const people = report.rangeCounts(all, s.start, s.end);
  const fy = report.financialYearOf(today());
  const yt = pay.periodTotals(all, c, hol(), fy.start, fy.end);
  const yc = report.rangeCounts(all, fy.start, fy.end);
  return `
  ${fixPanel()}
  ${calendarPanel()}

  <div class="panel">
    <div class="panel-head"><h2>Year so far</h2><span class="row-v">${esc(fy.label)}</span></div>
    <div class="mo-stats">
      <div class="stat"><p class="stat-v">${pay.money(yt.totalCents)}</p><p class="stat-l">Pay before tax</p></div>
      <div class="stat"><p class="stat-v">${pay.hoursDec(yt.hoursMin)}</p><p class="stat-l">Hours</p></div>
      <div class="stat"><p class="stat-v">${pay.kmText(yt.kmTenths)}</p><p class="stat-l">Km</p></div>
    </div>
    <p class="panel-foot">1 July to 30 June, the tax year. ${plural(yc.tastings, "tasting")}${yc.talked ? `: ${esc(countsText(yc, yc.sold > 0))}` : ""}. Parking ${pay.money(yt.parkingCents)}.</p>
  </div>

  <div class="panel">
    <div class="panel-head"><h2>Spreadsheet</h2></div>
    <p class="hint">The pay ${word} ${esc(model.dateText(s.start, false))} – ${esc(model.dateText(s.end, false))} as a file for Numbers, Excel or Google Sheets: the payslip lines, every day, every tasting with its flavours, every trip.</p>
    ${people.tastings ? `<p class="hint" style="margin-top:6px">${plural(people.tastings, "tasting")} in it: ${esc(countsText(people, people.sold > 0))}</p>` : ""}
    <div class="f-actions" style="margin-top:10px"><button class="btn" data-act="exportPay">Save as spreadsheet</button></div>
  </div>`;
}

/* ── Settings ─────────────────────────────────────────── */
const RATE_FIELDS = [
  ["weekday", "Weekday, per hour"], ["evening", "Weekday after 6 pm"], ["saturday", "Saturday"],
  ["sunday", "Sunday"], ["holiday", "Public holiday"], ["km", "Trips, per km"]
];
const rateVal = v => (typeof v === "number" ? centsText(v) : "");
/* The six rate boxes of the newest set of rates. Each one saves itself when it is left. */
function rateFields(r) {
  return RATE_FIELDS.map(([f, label]) => `<div class="f"><label>${label}</label>
    <input inputmode="decimal" autocomplete="off" value="${rateVal(r[f])}" placeholder="${f === "evening" ? "same" : "0.00"}" data-chg="rate" data-f="${f}"></div>`).join("");
}
const rateLine = r => `Weekday ${pay.money(r.weekday)}${typeof r.evening === "number" ? ` · after 6 pm ${pay.money(r.evening)}` : ""}`
  + ` · Sat ${pay.money(r.saturday)} · Sun ${pay.money(r.sunday)} · holiday ${pay.money(r.holiday)} · km ${pay.money(r.km)}`;

function paintSettings(el) {
  const c = cfg(), r = c.rateSets[currentRateIndex(c)], s = store.status();
  const upcoming = [...hol()].filter(([d]) => d >= today()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const days = c.payPeriod.days === 14 ? 14 : 7;
  const word = days === 14 ? "fortnight" : "week";
  const sets = c.rateSets.slice().sort((a, b) => (a.from < b.from ? 1 : -1));
  const used = storageUsed();
  const lastBackup = ls.get("lastBackup");
  const listEnding = today() > pay.addDays(HOLIDAYS_THROUGH, -92);

  const backupNote = "Your work is saved on this phone first, then backed up to your Google account when you are online. Counting works with no internet.";
  let account;
  if (DEMO) account = '<p class="hint">Demo mode. Nothing here is saved to your account.</p>';
  else if (ui.user) {
    account = `<p class="row-t">Signed in as ${esc(ui.user.email)}</p>
      <p class="hint">${esc(syncLine())}</p>
      <p class="hint">${backupNote}</p>
      <div class="f-actions" style="margin-top:10px"><button class="btn btn-ghost" data-act="signOut">Sign out</button></div>`;
  } else {
    account = `<p class="hint">${esc(syncLine())}</p>
      <p class="hint">${backupNote}</p>
      <div class="f-actions" style="margin-top:10px"><button class="btn btn-primary" data-act="signIn">Sign in with Google</button></div>`;
  }

  el.innerHTML = `
  <div class="panel">
    <div class="rows">
      <button class="row" data-act="help">
        <div class="row-main"><p class="row-t">How to use this app</p><p class="row-s">Short answers, step by step</p></div><span class="row-v">?</span></button>
      ${c.setup && c.setup.hidden ? `<button class="row" data-act="setupShow">
        <div class="row-main"><p class="row-t">Show the set-up steps again</p></div></button>` : ""}
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h2>Home and stores</h2></div>
    <div class="rows">
      <button class="row" data-act="place" data-id="home">
        <div class="row-main"><p class="row-t">Home</p><p class="row-s">${esc(c.homeAddress || "Add your home address — needed for the Maps buttons")}</p></div></button>
      ${activePlaces().slice(0, 8).map(p => `<button class="row" data-act="place" data-id="${esc(p.id)}">
        <div class="row-main"><p class="row-t">${esc(p.name)}</p><p class="row-s">${esc(p.address || "No address yet")}</p></div></button>`).join("")}
    </div>
    <p class="panel-foot">Stores are added when you add a tasting on Today.${activePlaces().length > 8 ? " These are the 8 used most recently. Older stores are still saved on the days you worked there." : ""}</p>
  </div>

  <div class="panel">
    <div class="panel-head"><h2>Trips</h2></div>
    <div class="switch"><span>Maps buttons avoid tolls</span>
      <button class="${c.avoidTolls !== false ? "on" : ""}" data-act="toll" role="switch" aria-checked="${c.avoidTolls !== false}" aria-label="Maps buttons avoid tolls"></button></div>
    <p class="panel-foot">Tolls are not paid back, so the km is measured on roads with no tolls. Do this one time in Google Maps too: get directions, tap More, then Options, then turn on Avoid tolls.</p>
  </div>

  <div class="panel">
    <div class="panel-head"><h2>My rates</h2></div>
    <div class="f-row">${rateFields(r)}</div>
    <p class="panel-foot">Leave "Weekday after 6 pm" empty if evenings are paid the same as the day. These rates apply from ${esc(model.dateText(r.from))}.</p>
    ${sets.length > 1 ? `<div class="rows" style="margin-top:10px">${sets.map((x, i) => `<div class="row">
        <div class="row-main"><p class="row-t">From ${esc(model.dateText(x.from))}</p><p class="row-s">${esc(rateLine(x))}</p></div>
        ${i < sets.length - 1 ? `<button class="btn btn-sm" data-act="rateRemove" data-from="${esc(x.from)}">Remove</button>` : ""}</div>`).join("")}</div>` : ""}
    <div class="f-actions" style="margin-top:10px"><button class="btn" data-act="newRates">My rates changed</button></div>
    <p class="panel-foot">When your rates go up, tap "My rates changed" and give the date. Days before that date keep the old rates, so old pay weeks still match their payslips.</p>
  </div>

  <div class="panel">
    <div class="panel-head"><h2>Pay period</h2></div>
    <div class="seg">
      <button class="${days === 7 ? "on" : ""}" data-act="period" data-days="7">Every week</button>
      <button class="${days === 14 ? "on" : ""}" data-act="period" data-days="14">Every fortnight</button>
    </div>
    <div class="f" style="margin-top:12px"><label>First day of a pay ${word}</label>
      <input type="date" value="${esc(c.payPeriod.anchor)}" data-chg="anchor"></div>
    <p class="panel-foot">Look at a payslip. It says "pay period from … to …". Pick the "from" date of any payslip.</p>
  </div>

  <div class="panel">
    <div class="panel-head"><h2>Public holidays</h2></div>
    ${listEnding ? `<div class="warn-row" style="margin-bottom:10px">${today() > HOLIDAYS_THROUGH ? "This list has ended." : "This list ends soon."} Add the new dates below, or set a day by hand on Today.</div>` : ""}
    <div class="rows">${upcoming.length ? upcoming.map(([d, n]) => `<div class="row">
        <div class="row-main"><p class="row-t">${esc(n)}</p><p class="row-s">${esc(model.dateText(d))}</p></div>
        <button class="btn btn-sm" data-act="holRemove" data-date="${d}">Remove</button></div>`).join("")
      : '<p class="empty">No dates listed.</p>'}</div>
    <div class="f-row" style="margin-top:12px">
      <div class="f"><label>Add a date</label><input type="date" id="holDate"></div>
      <div class="f"><label>Name</label><input type="text" id="holName" placeholder="Public holiday" maxlength="60"></div>
    </div>
    <div class="f-actions" style="margin-top:10px"><button class="btn" data-act="holAdd">Add holiday</button></div>
    <p class="panel-foot">Victorian public holidays up to ${esc(model.dateText(HOLIDAYS_THROUGH))}. The Friday before the 2027 AFL Grand Final is not in the list yet. Add it when the date is announced.</p>
  </div>

  <div class="panel">
    <div class="panel-head"><h2>My data</h2></div>
    ${used == null ? "" : `<div class="meter" role="img" aria-label="${used}% of the app's space used"><div class="meter-bar ${used >= 70 ? "hi" : ""}" style="width:${Math.max(2, used)}%"></div></div>
      <p class="hint">Space for the app on this phone: ${used}% used.${used >= 70 ? " It is getting full. Save a backup file now." : ""}</p>`}
    ${s.storageOk ? "" : '<div class="warn-row" style="margin-top:10px">This phone has stopped saving new changes. Keep the app open with internet on so they are backed up, and save a backup file.</div>'}
    <div class="f-actions" style="margin-top:10px"><button class="btn" data-act="backup">Save a backup file</button></div>
    <p class="panel-foot">${lastBackup ? `Last backup file: ${esc(model.dateText(lastBackup))}.` : "No backup file saved yet."} The file holds every day and your settings, with your home address. Keep it private.</p>
    <div class="f" style="margin-top:12px"><label>Bring back days from a backup file</label>
      <input type="file" accept=".json,application/json" data-chg="restoreFile" aria-label="Choose a backup file"></div>
    <p class="panel-foot">Only days that are missing on this phone are added. Nothing on this phone is replaced.</p>
  </div>

  <div class="panel">
    <div class="panel-head"><h2>Account</h2></div>
    ${account}
  </div>

  <div class="panel">
    <div class="panel-head"><h2>App update</h2></div>
    <p class="hint">Version ${esc(BUILD)}. The app updates itself: when a new version is ready, a green bar with "Update now" appears.</p>
    <div class="f-actions" style="margin-top:10px">
      <button class="btn btn-ghost" data-act="checkUpdate">Check for update</button>
      ${ui.swWaiting ? '<button class="btn btn-go" data-act="updateNow">Update now</button>' : ""}
    </div>
  </div>
  <p class="build">Tastings · ${esc(BUILD)}</p>`;
}

/* ══════════════════════════════════════════════════════════
   SHEETS
   ══════════════════════════════════════════════════════════ */
function openSheet(title, html, state = { kind: "plain" }) {
  ui.sheet = state;
  $("#sheetTitle").textContent = title;
  $("#sheetBody").innerHTML = html;
  $("#scrim").hidden = false;
  $("#sheet").hidden = false;
  $("#sheet").scrollTop = 0;
}
function closeSheet() {
  // A sheet field saves itself when it is left. Closing by the dark area or the X does not
  // leave it on an iPhone, so leave it here, while the sheet still knows what it belongs to.
  const f = document.activeElement;
  if (f && $("#sheet").contains(f) && /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName)) f.blur();
  commitNewFlavour();          // a flavour name typed but not added yet is kept, not thrown away
  ui.sheet = null;
  $("#scrim").hidden = true;
  $("#sheet").hidden = true;
  $("#sheetBody").innerHTML = "";
  render();
}
function setVal(sel, val) {
  const el = $(sel);
  if (el && document.activeElement !== el) el.value = val;
}

/* A button that only fires after being held: for things that cannot be undone. */
function holdButton(el, ms, fn) {
  if (!el) return;
  let timer = null;
  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } el.classList.remove("holding"); };
  el.addEventListener("pointerdown", ev => {
    ev.preventDefault();
    el.style.setProperty("--hold", ms + "ms");
    el.classList.add("holding");
    timer = setTimeout(() => { timer = null; el.classList.remove("holding"); fn(); }, ms);
  });
  for (const e of ["pointerup", "pointerleave", "pointercancel"]) el.addEventListener(e, stop);
  el.addEventListener("contextmenu", ev => ev.preventDefault());
}

/* ── the tasting sheet: finish, edit, check the pay ───── */
function lengthChips(v) {
  const out = [180, 240];
  const last = model.lastLengthAt(store.listDays(), v.placeId);
  if (last && last >= 30 && !out.includes(last)) out.unshift(last);
  return out;
}

/* The finish to offer for a running tasting: the clock (or the last count), snapped to a
   usual length when it is within 20 minutes of one. */
function suggestEnd(v) {
  const s = model.suggestPaidEnd(v, Date.now(), cfg().roundMin);
  const measured = pay.minutesBetween(v.paidStart, s.paidEnd);
  let chip = null;
  for (const len of lengthChips(v)) {
    const gap = Math.abs(measured - len);
    if (gap <= 20 && (chip == null || gap < Math.abs(measured - chip))) chip = len;
  }
  return { paidEnd: chip != null ? pay.addMinutes(v.paidStart, chip) : s.paidEnd, from: s.from };
}

function sheetVisit() {
  const sh = ui.sheet;
  if (!sh || sh.kind !== "visit") return null;
  const day = dayOf(sh.date);
  const v = (day.visits || []).find(x => x.id === sh.id);
  return v ? { sh, day, v } : null;
}

function openVisit(date, id, opts = {}) {
  const day = dayOf(date);
  const v = (day.visits || []).find(x => x.id === id);
  if (!v) return;
  const run = model.isRunning(v);
  // Opened from the Counter only to correct the shift times: the one way out is back to counting,
  // so a tap cannot end the tasting by surprise.
  const editOnly = run && !!opts.editOnly;
  // A running tasting opened to be finished gets a short screen: the three numbers, the shift,
  // parking, and one big Finish button. Everything else is one tap away under "Change …".
  const finish = run && !editOnly;
  const more = !finish || !!opts.stale;
  const place = placeOf(v.placeId);
  const step = (w, d, label) => `<button data-act="tstep" data-w="${w}" data-d="${d}">${label}</button>`;

  const top = opts.stale
    ? `<div class="note warn">This tasting from ${esc(model.dateText(date, false))} was not finished. Check the finish time below, then tap Finish tasting.</div>`
    : opts.over
      ? `<div class="note warn">The shift ended at ${esc(t12(v.paidEnd))}. Finish the tasting here, or go back to counting.</div>` : "";

  const names = model.flavoursOf(v);
  const start = model.counts(v);
  const summary = `<div class="vf">
      <div class="vf-big"><span>Total interactions</span><b id="vfTalk">0</b></div>
      <div class="vf-two vf-three">
        <div><span>Samples given</span><b id="vfS">0</b></div>
        <div><span>Rejected or ignored</span><b id="vfN">0</b></div>
        <div><span>Sold</span><b id="vfB">0</b></div>
      </div>
      ${names.length ? '<p class="vf-flav" id="vfFlav"></p>' : ""}
      <p class="vf-shift" id="vfShift"></p>
    </div>`;

  const storeRow = place ? `<button class="row" data-act="place" data-id="${esc(v.placeId)}">
      <div class="row-main"><p class="row-t">${esc(v.placeName)}</p><p class="row-s">${esc(place.address || "No address yet — tap to add it")}</p></div>
      <span class="row-v">Change</span></button>` : "";

  const brandF = `<div class="f"><label>Brand on the table</label>
      <input id="vsBrand" type="text" autocomplete="off" maxlength="60" placeholder="Optional" data-chg="vsBrand"></div>`;

  // One "− number +" for every count. A number can also be typed over.
  const stepper = (kind, f, label) => `<div class="vs-adj"><span>${esc(label)}</span><div class="stepper">
        <button data-act="adj" data-k="${kind}" data-f="${f}" data-d="-1" aria-label="One less: ${esc(label)}">−</button>
        <input inputmode="numeric" autocomplete="off" data-chg="vsCount" data-k="${kind}" data-f="${f}" data-count="${kind}:${f}" aria-label="${esc(label)}">
        <button data-act="adj" data-k="${kind}" data-f="${f}" data-d="1" aria-label="One more: ${esc(label)}">+</button></div></div>`;
  // counts made before the flavours were added have no flavour: they get their own block while there are any
  const plainLeft = names.length > 0 && (start.plain.sampled > 0 || start.plain.sold > 0);
  const flavourBlocks = names.map((name, i) => `<div class="vs-flav">
        <div class="vs-flav-h">
          <input type="text" autocomplete="off" maxlength="24" value="${esc(name)}" data-chg="vsFlav" data-i="${i}" aria-label="Flavour name">
          <button class="btn btn-sm" data-act="flavDel" data-i="${i}" hidden>Remove</button>
        </div>
        ${stepper("S", i, "Samples given")}${stepper("B", i, "Sold")}
      </div>`).join("");
  const nums = `<div class="vs-nums">
      <div class="vs-talk"><span>Total interactions</span><b id="vsTalk">0</b></div>
      ${names.length
        ? `${flavourBlocks}${plainLeft ? `<div class="vs-flav"><p class="vs-flav-t">No flavour</p>${stepper("S", -1, "Samples given")}${stepper("B", -1, "Sold")}</div>` : ""}`
        : `${stepper("S", -1, "Samples given")}${stepper("B", -1, "Sold")}`}
      ${stepper("N", -1, "Rejected or ignored")}
    </div>
    <p class="f-hint" id="vsInsight" hidden></p>
    <div class="note warn" id="vsLate" hidden><span id="vsLateT"></span>
      <button class="btn btn-sm" data-act="dropLate">Remove them</button></div>
    ${names.length < model.MAX_FLAVOURS ? `<div class="f"><label>${names.length ? "Add another flavour" : "Flavours — add them if the brand has 2 or more"}</label>
      <div class="newflav"><input id="vsNewFlav" type="text" autocomplete="off" maxlength="24" placeholder="Flavour name">
        <button class="btn" data-act="flavAdd">Add</button></div></div>` : ""}`;

  const paidBox = `<div class="vs-paid" id="vsPaidBox">
      <p class="vs-paidline" id="vsPaidLine"></p>
      <div class="f"><label>Shift starts</label><div class="tstep">${step("s", -15, "−15")}
        <input type="time" id="vsStart" data-chg="vsTime" data-w="s">${step("s", 15, "+15")}</div></div>
      <div class="f"><label>Shift ends</label><div class="tstep">${step("e", -15, "−15")}
        <input type="time" id="vsEnd" data-chg="vsTime" data-w="e">${step("e", 15, "+15")}</div></div>
      <div class="f"><label>Shift length</label><div class="chips" id="vsLens">${lengthChips(v).map(m =>
        `<button class="chip" data-act="len" data-min="${m}">${pay.hm(m)}</button>`).join("")}</div></div>
      <p class="f-hint" id="vsTapNote"></p>
      <div class="f"><label>Unpaid break</label><div class="chips" id="vsBreak">${[0, 15, 30, 45, 60].map(m =>
        `<button class="chip" data-act="brk" data-min="${m}">${m ? m + " min" : "None"}</button>`).join("")}</div></div>
      <div class="note bad" id="vsProb" hidden></div>
      <div class="note ask" id="vsEve" hidden><span id="vsEveT"></span>
        <div class="chips">
          <button class="chip" data-act="eve" data-v="yes" id="vsEveYes">Yes</button>
          <button class="chip" data-act="eve" data-v="no">No — same rate</button>
          <button class="chip" data-act="eve" data-v="unsure">Not sure yet</button>
        </div></div>
    </div>`;

  const parkF = `<div class="f"><label>Parking at this store ($)</label>
      <input id="vsPark" inputmode="decimal" autocomplete="off" placeholder="0.00" data-chg="vsPark"></div>`;
  const noteF = `<div class="f"><label>Customer comments — they go into your report</label>
      <input id="vsSaid" type="text" placeholder="What customers said about it" maxlength="300" data-chg="vsSaid"></div>
    <div class="f"><label>Note — only for you</label>
      <input id="vsNote" type="text" placeholder="Anything to remember" maxlength="300" data-chg="vsNote"></div>`;
  const del = '<button class="btn btn-danger hold" id="vsDelete">Hold to delete this tasting</button>';

  let body;
  if (finish) {
    body = `${top}${summary}${parkF}
      <button class="btn btn-finish btn-big" data-act="doneVisit">Finish tasting</button>
      ${opts.stale
        ? '<button class="btn btn-big" data-act="closeSheet">Not now</button>'
        : '<button class="btn btn-go btn-big" data-act="keepCounting">Back to counting</button>'}
      <button class="linkish more-link" id="vsMoreBtn" data-act="vsMore" ${more ? "hidden" : ""}>Change the numbers, flavours or times, or add a note</button>
      <div class="vs-more" id="vsMore" ${more ? "" : "hidden"}>${storeRow}${brandF}${nums}${paidBox}${noteF}${del}</div>`;
  } else if (editOnly) {
    body = `${storeRow}${brandF}${nums}${paidBox}${parkF}${noteF}
      <button class="btn btn-go btn-big" data-act="keepCounting">Save and go back to counting</button>`;
  } else {
    const canStart = model.isPlanned(v) && date === today() && !store.runningVisit();
    body = `${canStart ? `<button class="btn btn-go btn-big" data-act="startVisit" data-id="${esc(v.id)}">Start counting</button>` : ""}
      ${storeRow}${brandF}${nums}${paidBox}${parkF}${noteF}
      <div class="note ask" id="vsZero" hidden><span>No one was counted at this tasting. If that is right, tap the button and the app stops asking.</span>
        <button class="btn btn-sm" data-act="zeroOk">Yes, nobody to count</button></div>
      <div class="f-actions">
        <button class="btn btn-ghost" data-act="shareReport">Share report</button>
        <button class="btn btn-ghost" data-act="copyReport">Copy report</button>
      </div>
      ${v.startedAt != null && date === today() ? '<button class="btn btn-big" data-act="countMore">Count more people</button>' : ""}
      <button class="btn btn-primary btn-big" data-act="doneVisit">Close</button>
      ${del}`;
  }

  openSheet(v.placeName, body, { kind: "visit", date, id, eveSkip: !!opts.eveSkip, sug: null, finish, more, opts });
  holdButton($("#vsDelete"), 1000, () => deleteVisit(date, id));
  paintVisit();
}

/* Draw the tasting sheet again in the same state and at the same place. Needed when its
   flavours change, because each flavour has its own boxes on the sheet. */
function redrawVisit() {
  const sh = ui.sheet;
  if (!sh || sh.kind !== "visit") return;
  const top = $("#sheet").scrollTop, wasMore = sh.more;
  openVisit(sh.date, sh.id, { ...(sh.opts || {}), eveSkip: sh.eveSkip });
  if (wasMore) showMore();
  $("#sheet").scrollTop = top;
}

/* Show the full tasting sheet under the short Finish screen. */
function showMore() {
  const sh = ui.sheet;
  if (!sh || sh.kind !== "visit") return;
  sh.more = true;
  const box = $("#vsMore"), btn = $("#vsMoreBtn");
  if (box) box.hidden = false;
  if (btn) btn.hidden = true;
}

/* Updates the sheet in place. It never replaces a button or a field, so a tap is never lost. */
function paintVisit() {
  const ctx = sheetVisit();
  if (!ctx) { if (ui.sheet && ui.sheet.kind === "visit") closeSheet(); return; }
  const { sh, day, v } = ctx;
  const c = cfg(), h = hol(), run = model.isRunning(v), n = model.counts(v);

  $("#vsTalk").textContent = n.talked;
  for (const el of document.querySelectorAll("#sheetBody [data-count]")) {
    const [k, f] = el.dataset.count.split(":");
    if (document.activeElement !== el) el.value = model.countOf(v, k, Number(f));
  }
  for (const el of document.querySelectorAll('#sheetBody [data-chg="vsFlav"]')) {
    if (document.activeElement !== el) el.value = n.flav[Number(el.dataset.i)] ? n.flav[Number(el.dataset.i)].name : "";
  }
  // a flavour can be removed only while nothing is counted for it
  for (const el of document.querySelectorAll('#sheetBody [data-act="flavDel"]')) {
    el.hidden = !model.flavourIsEmpty(v, Number(el.dataset.i));
  }
  setVal("#vsBrand", v.brand || "");
  setVal("#vsSaid", v.comments || "");
  // two helpers worked out from the counts; they are for you, they are not in the report
  const tips = [];
  if (n.sold > 0 && n.sampled >= n.sold) tips.push(`About 1 sold for every ${Math.max(1, Math.round(n.sampled / n.sold))} ${Math.round(n.sampled / n.sold) === 1 ? "sample" : "samples"}.`);
  const busy = model.busiestHour(v);
  if (busy) tips.push(`Busiest hour: ${t12(String(busy.hour).padStart(2, "0") + ":00")} to ${t12(String((busy.hour + 1) % 24).padStart(2, "0") + ":00")} (${busy.count} interactions).`);
  const tipEl = $("#vsInsight");
  if (tipEl) { tipEl.hidden = !tips.length; tipEl.textContent = tips.join(" "); }

  const late = v.startedAt != null ? model.lateTapInfo(v) : null;
  $("#vsLate").hidden = !late;
  if (late) {
    $("#vsLateT").textContent = `${plural(late.n, "count")} added at ${t12(pay.hhmmOf(late.firstMs))}, ${late.gapMin} minutes after your last count. If they are a mistake, tap Remove them.`;
  }

  sh.sug = run && !v.paidEnd && !v.endManual ? suggestEnd(v) : null;
  const end = v.paidEnd || (sh.sug ? sh.sug.paidEnd : "");
  setVal("#vsStart", v.paidStart || "");
  setVal("#vsEnd", end);

  const eff = { ...v, paidEnd: end };
  const dEff = { ...day, visits: day.visits.map(x => (x.id === v.id ? eff : x)) };
  const probs = pay.visitProblems(dEff, eff).filter(p => !(run && p === "noEnd"));
  const lines = probs.length ? [] : pay.visitLines(eff, sh.date, c, h, day.paidAs);
  const total = lines.reduce((a, l) => a + l.cents, 0);
  const mins = lines.reduce((a, l) => a + l.minutes, 0);

  const line = $("#vsPaidLine");
  if (!end) line.textContent = "Set the time you finished.";
  else if (probs.length || !lines.length) line.textContent = `Paid ${t12(v.paidStart)} – ${t12(end)}`;
  else {
    line.innerHTML = `Paid ${esc(t12(v.paidStart))} – ${esc(t12(end))} = `
      + lines.map(l => `${pay.hm(l.minutes)} × ${pay.money(l.rate)} <small>(${KIND[l.kind]})</small>`).join(" + ")
      + ` = <b>${pay.money(total)}</b>`;
  }

  const cur = pay.minutesBetween(v.paidStart, end);
  document.querySelectorAll("#vsLens .chip").forEach(b => b.classList.toggle("on", Number(b.dataset.min) === cur));
  document.querySelectorAll("#vsBreak .chip").forEach(b => b.classList.toggle("on", Number(b.dataset.min) === (v.breakMin || 0)));

  // the real tap times, and a warning when rounding moved a time a long way
  const notes = [];
  let moved = false;
  if (v.startedAt != null) {
    const tapped = pay.hhmmOf(v.startedAt);
    notes.push(`Counting started ${t12(tapped)}`);
    if (!v.startManual && Math.abs(pay.toMin(tapped) - (pay.toMin(v.paidStart) ?? 0)) > 5) moved = true;
    if (v.endedAt != null) notes.push(`finished ${t12(pay.hhmmOf(v.endedAt))}`);
    if (sh.sug && sh.sug.from === "lastCount") notes.push(`finish time taken from your last count (${t12(pay.hhmmOf(model.lastTapMs(v)))})`);
    else if (sh.sug && Math.abs(pay.toMin(pay.hhmmOf(Date.now())) - (pay.toMin(end) ?? 0)) > 5) moved = true;
    if (v.startManual && v.endManual) notes.push("you are paid for the shift times above");
  } else notes.push("Shift times typed by you");
  if (moved) notes.push("times were rounded — check they are right");
  $("#vsTapNote").textContent = notes.join(" · ");
  $("#vsPaidBox").classList.toggle("amber", moved && !probs.length);

  $("#vsProb").hidden = !probs.length;
  $("#vsProb").textContent = probs.map(p => PROBLEM[p]).join(" ");

  // weekday hours after 6 pm: asked until answered
  const kind = pay.dayKind(sh.date, h, day.paidAs), r = rateSet(sh.date);
  const cut = pay.toMin(r.eveningFrom || "18:00") ?? 1080;
  const ask = kind === "weekday" && !c.eveningAsked && typeof r.evening !== "number" && !sh.eveSkip
    && !probs.length && !!end && (pay.toMin(end) ?? 0) > cut;
  $("#vsEve").hidden = !ask;
  if (ask) {
    const c2 = JSON.parse(JSON.stringify(c));
    const set = c2.rateSets.find(x => x.from === r.from) || c2.rateSets[0];
    set.evening = r.saturday;
    const withEve = pay.visitLines(eff, sh.date, c2, h, day.paidAs).reduce((a, l) => a + l.cents, 0);
    $("#vsEveT").textContent = `Is your pay higher after 6 pm on weekdays? Same rate: ${pay.money(total)}. Higher rate (${pay.money(r.saturday)} per hour): ${pay.money(withEve)}. Not sure? Check your payslip.`;
    $("#vsEveYes").textContent = `Yes — ${pay.money(r.saturday)}`;
  }

  const pk = (day.parking || []).find(p => p.visitId === v.id);
  setVal("#vsPark", pk ? centsText(pk.cents) : "");
  setVal("#vsNote", v.note || "");

  // a past tasting with nobody counted: offer to say that this is right
  const zero = $("#vsZero");
  if (zero) zero.hidden = !(sh.date < today() && n.talked === 0 && !v.zeroOk && !run);

  // the short Finish screen
  if ($("#vfTalk")) {
    $("#vfTalk").textContent = n.talked;
    $("#vfS").textContent = n.sampled;
    $("#vfN").textContent = n.declined;
    $("#vfB").textContent = n.sold;
    const fl = $("#vfFlav");
    if (fl) {
      const parts = n.flav.map(f => `${f.name}: ${plural(f.sampled, "sample")}, ${f.sold} sold`);
      if (n.plain.sampled || n.plain.sold) parts.push(`No flavour: ${plural(n.plain.sampled, "sample")}, ${n.plain.sold} sold`);
      fl.textContent = parts.join(" · ");
    }
    const el = $("#vfShift");
    if (!end) el.textContent = "Set the time you finished below.";
    else if (probs.length || !lines.length) el.textContent = `Shift ${t12(v.paidStart)} – ${t12(end)}`;
    else el.innerHTML = `Shift ${esc(t12(v.paidStart))} – ${esc(t12(end))} · ${pay.hm(mins)} · <b>${pay.money(total)}</b>`;
    // anything that needs a decision is under "Change …": open it so it cannot be missed
    if (!sh.more && (late || probs.length || ask || !end || moved)) showMore();
  }
}

function editVisit(fn, rebuild) {
  const sh = ui.sheet;
  if (!sh || sh.kind !== "visit") return;
  store.saveDay(sh.date, d => {
    const v = (d.visits || []).find(x => x.id === sh.id);
    if (!v) return;
    fn(v, d);
    if (rebuild) model.rebuildLegs(d, cfg());
  });
  paintVisit();
}

function deleteVisit(date, id) {
  store.saveDay(date, d => {
    d.visits = (d.visits || []).filter(v => v.id !== id);
    d.parking = (d.parking || []).filter(p => p.visitId !== id);
    model.rebuildLegs(d, cfg());
  });
  ui.sheet = null;
  if (ui.counter && !store.runningVisit()) closeCounter();
  closeSheet();
  toast("Tasting deleted");
}

function finishRunning() {
  const ctx = sheetVisit();
  if (!ctx) return;
  const { sh, v } = ctx;
  const now = Date.now(), c = cfg();
  const end = v.paidEnd || (sh.sug ? sh.sug.paidEnd : "");
  store.saveDay(sh.date, d => {
    const x = (d.visits || []).find(y => y.id === sh.id);
    if (!x) return;
    if (!x.paidEnd && !x.endManual && end) x.paidEnd = end;
    model.finishVisit(x, now, c.roundMin);
    model.rebuildLegs(d, c);
  });
  ui.sheet = null;
  closeCounter();
  rollDay();                    // the Counter may have been open across midnight: line up "today" first,
  ui.tab = "today";             // so that the day chosen next counts as chosen on purpose
  ui.viewDate = sh.date;
  saveUI();
  closeSheet();                 // redraws Today underneath
  finishedSheet(sh.date, sh.id);
}

/* Right after Finish: the report, ready to send, and what comes next. */
function finishedSheet(date, id) {
  const day = dayOf(date);
  const v = (day.visits || []).find(x => x.id === id);
  if (!v) return;
  const visits = (day.visits || []).slice().sort(byStart);
  // the next tasting still to do today: the first one waiting that comes after this one
  const next = date === today() ? visits.find(x => isWaiting(x) && byStart(v, x) < 0) : null;
  let after = "";
  if (next) {
    const url = next.placeId !== v.placeId
      ? model.mapsUrl(addrOf(v.placeId), addrOf(next.placeId), cfg().avoidTolls !== false) : null;
    after = `<div class="note ask"><span><b>Next: ${esc(next.placeName)}</b><br>${esc(shiftText(next))}</span>
      ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Directions to the next store</a>` : ""}</div>`;
  } else if (visits.length > 1 && !visits.some(x => model.isRunning(x) || isWaiting(x))) {
    after = '<button class="btn btn-big" data-act="dayReport">See the whole day report</button>';
  }
  openSheet("Tasting finished", `
    <pre class="report">${esc(model.reportText(day, v))}</pre>
    <div class="f-actions">
      <button class="btn btn-primary" data-act="shareReport" data-date="${date}" data-id="${esc(id)}">Share report</button>
      <button class="btn btn-ghost" data-act="copyReport" data-date="${date}" data-id="${esc(id)}">Copy</button>
    </div>
    ${after}
    ${date === today()
      ? '<button class="btn btn-big" data-act="closeSheet">Close</button>'
      : `<button class="btn btn-go btn-big" data-act="toToday">Go to today</button>
         <button class="btn btn-big" data-act="closeSheet">Stay on ${esc(model.dateText(date, false))}</button>`}`);
}

/* ── small sheets ─────────────────────────────────────── */
function placeSheet(id) {
  if (id === "home") {
    openSheet("Home address", `
      <div class="f"><label>Your home address</label>
        <input id="plAddr" type="text" autocomplete="street-address" placeholder="12 Example St, Suburb VIC 3000" value="${esc(cfg().homeAddress || "")}"></div>
      <p class="f-hint">Number, street, suburb, state and postcode, so Google Maps starts from the right spot. It is only used to open Google Maps.</p>
      <div class="f-actions"><button class="btn btn-primary" data-act="placeSave" data-id="home">Save</button></div>`);
    return;
  }
  const p = placeOf(id);
  if (!p) return;
  openSheet("Store", `
    <div class="f"><label>Name</label><input id="plName" type="text" autocomplete="off" maxlength="60" value="${esc(p.name)}"></div>
    <div class="f"><label>Address</label>
      <input id="plAddr" type="text" autocomplete="off" placeholder="250 High St, Suburb VIC 3000" value="${esc(p.address || "")}"></div>
    <p class="f-hint">Number, street, suburb, state and postcode, so Google Maps lands on the right store.</p>
    <p class="gate-note" id="plErr"></p>
    <div class="f-actions">
      <button class="btn btn-ghost" data-act="placeArchive" data-id="${esc(id)}">Remove from list</button>
      <button class="btn btn-primary" data-act="placeSave" data-id="${esc(id)}">Save</button>
    </div>`);
}

function parkSheet(id) {
  const item = id ? (dayOf(ui.viewDate).parking || []).find(p => p.id === id) : null;
  openSheet(item ? "Parking" : "Add parking", `
    <div class="f"><label>Amount ($)</label>
      <input id="pkAmt" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${item ? centsText(item.cents) : ""}"></div>
    <div class="f"><label>Note</label>
      <input id="pkNote" type="text" maxlength="80" placeholder="Which car park" value="${esc(item ? item.note || "" : "")}"></div>
    <p class="gate-note" id="pkErr"></p>
    <div class="f-actions">
      ${item ? `<button class="btn btn-danger" data-act="parkDelete" data-id="${esc(id)}">Delete</button>` : ""}
      <button class="btn btn-primary" data-act="parkSave" data-id="${esc(id || "")}">Save</button>
    </div>`);
}

/* Add a tasting for the day being viewed: the store, its address and the shift times, all typed
   by the user. The stores change every day, so a new store is the normal case; stores used
   before are offered as shortcuts above the name and narrow down as the name is typed. The
   shift times typed last time for this position in the day (1st tasting, 2nd tasting …) are
   filled in to start with. */
function addSheet() {
  const date = ui.viewDate, day = dayOf(date), c = cfg();
  const count = (day.visits || []).length;
  const usual = (c.usualShifts || [])[Math.min(count, 5)] || {};
  const canStartNow = date === today() && !store.runningVisit();
  openSheet(count ? "Add another tasting" : "Add a tasting", `
    <p class="f-hint">For ${esc(model.dateText(date))}.</p>
    <div class="f" id="aPrevBox" hidden><label>Stores used before — tap one</label><div class="chips" id="aChips"></div></div>
    <div class="f"><label>Store name</label>
      <input id="aName" type="text" autocomplete="off" maxlength="60" placeholder="BWS Northcote" data-inp="aName"></div>
    <div class="f"><label>Store address</label>
      <input id="aAddr" type="text" autocomplete="off" maxlength="160" placeholder="250 High St, Northcote VIC 3070">
      <p class="f-hint">Street, suburb and postcode. The Maps button measures the trip to this address.</p></div>
    <div class="f-row">
      <div class="f"><label>Shift starts</label><input id="aStart" type="time" value="${esc(usual.start || "")}"></div>
      <div class="f"><label>Shift ends</label><input id="aEnd" type="time" value="${esc(usual.end || "")}"></div>
    </div>
    <div class="f" id="aBrandBox" hidden><label>Brands used before — tap one</label><div class="chips" id="aBrands"></div></div>
    <div class="f"><label>Brand on the table (optional)</label>
      <input id="aBrand" type="text" autocomplete="off" maxlength="60" placeholder="The drink you are showing" data-inp="aBrand"></div>
    <div class="f"><label>Flavours (only if there are 2 or more)</label>
      <input id="aFlav" type="text" autocomplete="off" maxlength="160" placeholder="Lime, Mango" data-inp="aFlav">
      <p class="f-hint" id="aFlavHint">Type them with a comma between. Each flavour gets its own count and its own Sold.</p></div>
    <p class="gate-note" id="aErr"></p>
    ${canStartNow ? '<button class="btn btn-go btn-big" data-act="addSave" data-go="1">Add and start counting now</button>' : ""}
    <button class="btn btn-primary btn-big" data-act="addSave" data-go="0">${canStartNow ? "Add for later" : "Add tasting"}</button>`,
    { kind: "add", placeId: null, flavAuto: "" });
  paintAddChips();
  paintBrandChips();
}

/* Brands used before, as shortcuts. Picking one (or typing its name) fills in its flavours. */
function paintBrandChips() {
  const box = $("#aBrandBox"), el = $("#aBrands"), input = $("#aBrand");
  if (!box || !el || !input) return;
  const q = input.value.trim().toLowerCase();
  const list = (cfg().brands || []).filter(b => !q || b.name.toLowerCase().includes(q)).slice(0, 6);
  // nothing to offer when the one match is exactly what is typed
  const only = list.length === 1 && list[0].name.toLowerCase() === q;
  box.hidden = !list.length || only;
  el.innerHTML = list.map((b, i) =>
    `<button class="chip" data-act="pickBrand" data-name="${esc(b.name)}">${esc(b.name)}</button>`).join("");
}
/* Under the flavours box: what the app understood, so a missing comma shows at once. */
function paintFlavHint() {
  const el = $("#aFlavHint"), input = $("#aFlav");
  if (!el || !input) return;
  const names = model.parseFlavours(input.value);
  el.textContent = names.length >= 2 ? `${names.length} flavours: ${names.join(" · ")}`
    : names.length === 1 && /\s(and|or)\s|[\/+]/i.test(names[0]) ? "Is this more than one flavour? Put a comma between them, like: Lime, Mango"
      : names.length === 1 ? "One flavour only: you can leave this box empty. With 2 or more, put a comma between them."
        : "Type them with a comma between. Each flavour gets its own count and its own Sold.";
}
/* A brand the app remembers brings its flavours with it, unless the user typed their own. */
function fillBrandFlavours() {
  const sh = ui.sheet, brand = $("#aBrand"), flav = $("#aFlav");
  if (!sh || sh.kind !== "add" || !brand || !flav) return;
  if (flav.value.trim() && flav.value !== sh.flavAuto) return;       // typed by hand: leave it
  const known = model.brandFlavours(cfg(), brand.value);
  const text = known && known.length ? known.join(", ") : "";
  flav.value = text;
  sh.flavAuto = text;
  paintFlavHint();
}

/* The "stores used before" shortcuts: the six used most recently, or — once a name is being
   typed — the saved stores whose name contains what was typed. */
function paintAddChips() {
  const box = $("#aPrevBox"), el = $("#aChips"), name = $("#aName");
  if (!box || !el || !name) return;
  const q = name.value.trim().toLowerCase();
  const list = activePlaces().filter(p => !q || p.name.toLowerCase().includes(q)).slice(0, 6);
  box.hidden = !list.length;
  el.innerHTML = list.map(p =>
    `<button class="chip" data-act="pickPlace" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join("");
}

/* ── km: typed once per trip, remembered per direction ── */
function commitKm(i, text, el) {
  const date = ui.viewDate, day = dayOf(date), leg = (day.legs || [])[i];
  if (!leg) return;
  if (!String(text).trim()) {
    if (typeof leg.tenths === "number") {
      store.saveDay(date, d => { const l = d.legs[i]; if (l) { l.tenths = null; l.checkedOn = null; l.checkedTime = null; } });
    }
    return;
  }
  const tenths = model.parseKm(text);
  if (tenths == null) {
    toast("Type the km as a number, like 12.4");
    if (el) el.value = typeof leg.tenths === "number" ? pay.kmText(leg.tenths) : "";
    return;
  }
  if (leg.tenths === tenths) return;
  const mem = (cfg().kmMemory || {})[`${leg.from}>${leg.to}`];
  if (mem && !mem.stale && typeof mem.tenths === "number" && mem.tenths !== tenths) {
    const diff = mem.tenths ? Math.round((Math.abs(tenths - mem.tenths) * 100) / mem.tenths) : 100;
    openSheet("Which km is right?", `
      <p>You typed <b>${pay.kmText(tenths)} km</b> for ${esc(leg.fromName)} → ${esc(leg.toName)}.
        Last time this trip was <b>${pay.kmText(mem.tenths)} km</b>${mem.checkedOn ? ` (checked ${esc(model.dateText(mem.checkedOn, false))})` : ""}.</p>
      ${diff > 15 ? `<div class="note warn">That is a big difference (${diff}%). Check Google Maps again: the same two addresses, and no tolls.</div>` : ""}
      <button class="btn btn-big" data-act="kmApply" data-date="${date}" data-i="${i}" data-t="${tenths}" data-r="0">Use ${pay.kmText(tenths)} km for this day only</button>
      <button class="btn btn-primary btn-big" data-act="kmApply" data-date="${date}" data-i="${i}" data-t="${tenths}" data-r="1">Use ${pay.kmText(tenths)} km every time</button>`);
    return;
  }
  applyKm(i, tenths, true);
}

function applyKm(i, tenths, remember, date = ui.viewDate) {
  const leg = (dayOf(date).legs || [])[i];
  if (!leg) return;
  const key = `${leg.from}>${leg.to}`;
  const stampOpts = { date: today(), time: pay.hhmmOf(Date.now()), remember };
  const scratch = JSON.parse(JSON.stringify(cfg()));
  store.saveDay(date, d => model.setLegKm(d, scratch, i, tenths, stampOpts));
  if (!remember) return;
  store.saveConfig(c => {
    if (!c.kmMemory || typeof c.kmMemory !== "object") c.kmMemory = {};
    c.kmMemory[key] = scratch.kmMemory[key];
  });
  // Fill the same trip on other days where it is still empty.
  for (const d of store.listDays()) {
    if (d.date === date) continue;
    const idx = (d.legs || []).findIndex(l => l.from === leg.from && l.to === leg.to && typeof l.tenths !== "number" && !l.skip);
    if (idx >= 0) store.saveDay(d.date, x => model.setLegKm(x, null, idx, tenths, { ...stampOpts, remember: false }));
  }
}

/* ══════════════════════════════════════════════════════════
   COUNTER
   ══════════════════════════════════════════════════════════ */
const livePtr = new Map();        // pointerId → the count that touch made, so a cancelled touch can take it back

/* The name of one count, as the screen says it: a kind ("S" sample, "N" rejected, "B" sold)
   and, for samples and sold, a flavour (-1 = the product has no flavours). */
function countName(v, kind, flavour) {
  if (kind === "N") return "Rejected or ignored";
  const name = flavour >= 0 ? model.flavoursOf(v)[flavour] : null;
  if (kind === "B") return name ? `Sold · ${name}` : "Sold";
  return name || "Sample given";
}
const flavourOf = ds => { const f = Number(ds.f); return Number.isInteger(f) && f >= 0 ? f : -1; };
const kindOf = ds => (ds.kind === "N" || ds.kind === "B" ? ds.kind : "S");

/* The count rows, drawn once per tasting (and again only when its flavours change): "Rejected or
   ignored", then one row per flavour — Sold on the left, the samples on the right under the
   thumb — or one such row for a product with no flavours. Each count has its own "−". The
   numbers are filled in by paintCounter; nothing here is replaced while counting. */
let padKey = "";
function buildPad(v) {
  const names = model.flavoursOf(v);
  const key = v.id + "\u0001" + names.join("\u0001");
  if (key === padKey && $("#cPad").childElementCount) return;
  padKey = key;
  const cell = (kind, f, cls, label) => `<div class="c-cell ${cls}">
      <button class="c-minus" data-act="minus" data-kind="${kind}" data-f="${f}" aria-label="Take one off ${esc(countName(v, kind, f))}"><span aria-hidden="true">−</span><small>undo</small></button>
      <button class="c-count" data-kind="${kind}" data-f="${f}" aria-label="${esc(countName(v, kind, f))}"><span>${esc(label)}</span><b>0</b></button>
    </div>`;
  const rows = [`<div class="c-row"><div class="c-box">${cell("N", -1, "c-no", "Rejected or ignored")}</div></div>`];
  const flavours = names.length ? names.map((name, i) => [i, name]) : [[-1, "Sample given"]];
  for (const [i, name] of flavours) {
    rows.push(`<div class="c-row"><div class="c-box">${cell("B", i, "c-sold", "Sold")}${cell("S", i, "c-yes", name)}</div></div>`);
  }
  const pad = $("#cPad");
  pad.innerHTML = rows.join("");
  pad.dataset.rows = String(rows.length);
  $("#counter").classList.toggle("rows-many", rows.length >= 6);
}

function openCounter() {
  const r = store.runningVisit();
  if (!r) { render(); return; }
  ui.counter = true;
  ui.covered = false;
  ui.lastAct = Date.now();
  ui.undone = [];
  ui.backUntil = 0;
  $("#cCover").hidden = true;
  $("#counter").hidden = false;
  $("#app").hidden = true;
  $("#tabs").hidden = true;
  document.body.classList.add("counting");
  clearInterval(ui.tick);
  ui.tick = setInterval(counterTick, 1000);
  wakeOn();
  paintCounter();
}

function closeCounter() {
  ui.counter = false;
  $("#counter").hidden = true;
  $("#app").hidden = false;
  $("#tabs").hidden = false;
  document.body.classList.remove("counting");
  clearInterval(ui.tick);
  ui.tick = null;
  wakeOff();
}

function counterTick() {
  paintClock();
  paintBack();
  // Ten minutes without a count: cover the screen and let the phone sleep (pocket safety).
  if (!ui.covered && !ui.sheet && Date.now() - ui.lastAct > 10 * 60000) cover("idle");
}

/* Minutes past the booked end of a tasting that is running today. 0 while the shift is still on. */
function shiftOverMin(r) {
  const end = pay.toMin(r.visit.paidEnd);
  if (end == null || r.date !== today()) return 0;
  const now = new Date();
  return Math.max(0, now.getHours() * 60 + now.getMinutes() - end);
}

/* Under the store name: how long the shift still has, then "Shift ended" once its typed end has
   passed (the Finish button then pulses). One line, never taller, so nothing below it moves. */
function paintClock() {
  const r = store.runningVisit();
  if (!r) return;
  const v = r.visit, el = $("#cTime");
  const end = pay.toMin(v.paidEnd);
  let due = false;
  if (end != null && r.date === today()) {
    const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
    const start = pay.toMin(v.paidStart);
    if (start != null && nowMin < start) el.textContent = `Shift ${t12(v.paidStart)} – ${t12(v.paidEnd)}`;
    else if (nowMin < end) el.textContent = `${pay.hm(end - nowMin)} left · ends ${t12(v.paidEnd)}`;
    else { el.textContent = `Shift ended at ${t12(v.paidEnd)}`; due = true; }
  } else {
    const mins = Math.max(0, Math.floor((Date.now() - v.startedAt) / 60000));
    el.textContent = mins < 1 ? "just started" : `counting for ${pay.hm(mins)}`;
  }
  $("#cFinish").classList.toggle("due", due);
}

function paintStatus() {
  const el = $("#cStatus");
  const ok = store.status().storageOk;
  el.classList.toggle("bad", !ok);
  el.textContent = ok
    ? `Saved · ${shortSync()} · ${ui.wakeOn ? "Screen stays on" : "Screen will sleep"}`
    : "Not saved on this phone · keep the app open";
}

function paintCounter() {
  const r = store.runningVisit();
  if (!r) { if (!ui.sheet) closeCounter(), paint(); return; }
  const v = r.visit, n = model.counts(v);
  $("#cStore").textContent = v.placeName;
  buildPad(v);
  for (const cell of document.querySelectorAll("#cPad .c-cell")) {
    const btn = cell.querySelector(".c-count"), b = btn.querySelector("b");
    const kind = kindOf(btn.dataset), f = flavourOf(btn.dataset);
    const slot = f >= 0 ? n.flav[f] : n.plain;
    const value = kind === "N" ? n.declined : !slot ? 0 : kind === "B" ? slot.sold : slot.sampled;
    b.textContent = value;
    b.classList.toggle("wide", value > 99);            // three digits get a smaller size: the number stays inside its box
    cell.querySelector(".c-minus").disabled = value === 0;   // a minus with nothing to take off is greyed out
  }
  $("#cTalk").textContent = n.talked;
  $("#cSam").textContent = n.sampled;
  $("#cSold").textContent = n.sold;
  paintBack();

  paintStatus();
  paintClock();
  if (ui.sheet && ui.sheet.kind === "visit") paintVisit();
}

/* The line above the numbers. It normally names the last count. For 15 seconds after a minus it
   turns into "put it back". It is always there and always the same height, so the boxes never move. */
function paintBack() {
  const btn = $("#cBack"), txt = $("#cBackT");
  const r = store.runningVisit();
  if (!r) return;
  if (ui.undone.length && (Date.now() > ui.backUntil || ui.undone[ui.undone.length - 1].id !== r.visit.id)) ui.undone = [];
  const e = ui.undone[ui.undone.length - 1];
  const fresh = !e && !(r.visit.tapK || "").length;       // nothing tapped yet in this tasting
  btn.disabled = !e && !fresh;
  btn.classList.toggle("can", !!e);
  btn.classList.toggle("start", fresh);
  if (e) { txt.textContent = `1 removed from ${countName(r.visit, e.kind, e.flavour)}. Tap here to add it back`; return; }
  if (fresh) {
    const v = r.visit;
    txt.textContent = `Shift ${t12(v.paidStart)}${v.paidEnd ? " – " + t12(v.paidEnd) : ""}. Wrong store or times? Tap here`;
    return;
  }
  const last = model.peekUndo(r.visit);
  txt.textContent = last
    ? `Last count: ${countName(r.visit, last.kind, last.flavour)}, ${t12(pay.hhmmOf(r.visit.startedAt + last.t * 1000))}`
    : "No counts yet";
}

/* "hit" = one added, "off" = one taken off. Shown on that count's own part of the row. */
function flash(el, cls = "hit") {
  const box = el.closest(".c-cell") || el;
  box.classList.remove("hit", "off");
  box.classList.add(cls);
  clearTimeout(box._t);
  box._t = setTimeout(() => box.classList.remove(cls), 140);
}

/* One tap = one sample given, one person who said no, or one sold. Counted the instant the finger lands. */
function onPadDown(ev) {
  const btn = ev.target.closest(".c-count");
  if (!btn || ui.covered) return;
  ev.preventDefault();
  const r = store.runningVisit();
  if (!r) return;
  const kind = kindOf(btn.dataset), flavour = flavourOf(btn.dataset), now = Date.now();
  store.saveDay(r.date, d => {
    const v = (d.visits || []).find(x => x.id === r.visit.id);
    if (v) model.addTap(v, kind, now, flavour >= 0 ? flavour : null);
  });
  livePtr.set(ev.pointerId, { kind, flavour, id: r.visit.id, date: r.date });
  ui.lastAct = now;
  flash(btn);
  if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) { /* not on iPhone */ } }
}

/* The phone took the touch away (a swipe up from the bottom edge, say): that was not a person. */
function onPadCancel(ev) {
  const p = livePtr.get(ev.pointerId);
  if (!p) return;
  livePtr.delete(ev.pointerId);
  let removed = -1;
  store.saveDay(p.date, d => {
    const v = (d.visits || []).find(x => x.id === p.id);
    if (!v) return;
    const i = model.findTap(v, p.kind, p.flavour);
    if (i < 0 || i < v.tapK.length - 3) return;
    if (model.removeTapAt(v, i)) removed = i;
  });
  // the log got one shorter: keep "put back" pointing at the right taps
  if (removed >= 0) for (const e of ui.undone) if (e.id === p.id && e.index != null && e.index > removed) e.index--;
}

/* The minus beside a count: take one off THAT count (a kind and, for samples and sold, one
   flavour). It undoes the newest tap of that count or, when the number came from a hand
   correction, lowers the correction. */
const minusButton = (kind, flavour) => document.querySelector(`#cPad .c-minus[data-kind="${kind}"][data-f="${flavour}"]`);
function takeOff(kind, flavour) {
  if (ui.covered) return;
  const r = store.runningVisit();
  if (!r) return;
  let entry = null;
  store.saveDay(r.date, d => {
    const v = (d.visits || []).find(x => x.id === r.visit.id);
    if (!v) return;
    // Never take one off a count that already shows zero, whatever the button looked like.
    if (model.countOf(v, kind, flavour) <= 0) return;
    const tap = model.undoKind(v, kind, flavour);
    if (tap) { entry = { id: v.id, kind, flavour, index: tap.index }; return; }
    model.bumpCount(v, kind, flavour, -1);
    entry = { id: v.id, kind, flavour, index: null };
  });
  if (!entry) return;
  ui.undone.push(entry);
  if (ui.undone.length > 30) ui.undone.shift();
  ui.backUntil = Date.now() + 15000;
  ui.lastAct = Date.now();
  const btn = minusButton(kind, flavour);
  if (btn) flash(btn, "off");
  paintCounter();
}

/* Put back the count most recently taken off. */
function putBack() {
  const r = store.runningVisit();
  const e = ui.undone[ui.undone.length - 1];
  if (!r || !e || e.id !== r.visit.id) { ui.undone = []; paintCounter(); return; }
  ui.undone.pop();
  store.saveDay(r.date, d => {
    const v = (d.visits || []).find(x => x.id === e.id);
    if (!v) return;
    if (e.index != null) model.redoAt(v, e.index);
    else model.bumpCount(v, e.kind, e.flavour, 1);
  });
  ui.backUntil = ui.undone.length ? Date.now() + 15000 : 0;
  ui.lastAct = Date.now();
  const btn = minusButton(e.kind, e.flavour);
  if (btn) flash(btn, "hit");
  paintCounter();
}

function cover(why) {
  ui.covered = true;
  $("#cCoverT").textContent = why === "idle" ? "Paused" : "Locked";
  $("#cCoverS").textContent = why === "idle"
    ? "No count for 10 minutes, so the screen locked itself. Your counts are saved."
    : "The screen is locked. Taps are not counted.";
  $("#cThumb").style.transform = "";
  $("#cCover").hidden = false;
  wakeOff();
  paintStatus();
}
function uncover() {
  ui.covered = false;
  ui.lastAct = Date.now();
  $("#cCover").hidden = true;
  wakeOn();
}

/* Keep the screen on while counting. It is dropped whenever the app leaves the front, so it is
   asked for again every time the app comes back, and the real state is always shown. */
async function wakeOn() {
  if (!("wakeLock" in navigator) || !ui.counter || ui.covered || document.hidden) {
    ui.wakeOn = false; paintStatus(); return;
  }
  try {
    if (ui.wake) { try { await ui.wake.release(); } catch (e) { /* gone already */ } }
    const lock = await navigator.wakeLock.request("screen");
    ui.wake = lock;
    ui.wakeOn = true;
    lock.addEventListener("release", () => { if (ui.wake === lock) { ui.wake = null; ui.wakeOn = false; paintStatus(); } });
  } catch (e) {
    ui.wake = null; ui.wakeOn = false;
  }
  paintStatus();
}
function wakeOff() {
  const lock = ui.wake;
  ui.wake = null;
  ui.wakeOn = false;
  if (lock) { try { lock.release(); } catch (e) { /* gone already */ } }
}

function wireCounter() {
  const pad = $("#cPad");
  pad.addEventListener("pointerdown", onPadDown, { passive: false });
  pad.addEventListener("pointercancel", onPadCancel);
  document.addEventListener("pointerup", ev => livePtr.delete(ev.pointerId));

  // Slide to unlock (a hold can happen by itself in a pocket; a slide cannot).
  const track = $("#cSlide"), thumb = $("#cThumb");
  let id = null, startX = 0, max = 0, x = 0;
  thumb.addEventListener("pointerdown", ev => {
    ev.preventDefault();
    id = ev.pointerId;
    try { thumb.setPointerCapture(id); } catch (e) { /* fine without */ }
    startX = ev.clientX;
    max = track.clientWidth - thumb.offsetWidth - 6;
    x = 0;
  });
  thumb.addEventListener("pointermove", ev => {
    if (ev.pointerId !== id) return;
    x = Math.max(0, Math.min(max, ev.clientX - startX));
    thumb.style.transform = `translateX(${x}px)`;
  });
  const end = ev => {
    if (ev.pointerId !== id) return;
    id = null;
    const ok = max > 0 && x >= max * 0.8;
    thumb.style.transform = "";
    if (ok) uncover();
  };
  thumb.addEventListener("pointerup", end);
  thumb.addEventListener("pointercancel", end);

  // The counting screen never scrolls, zooms or shows a menu.
  const counter = $("#counter");
  // (The CSS already stops scrolling here. This is a second guard, and it leaves touches that
  // started on a button alone so their tap is never swallowed.)
  document.addEventListener("touchmove", ev => {
    if (ui.counter && !ev.target.closest(".sheet, button, a, input")) ev.preventDefault();
  }, { passive: false });
  for (const e of ["contextmenu", "selectstart", "gesturestart", "dblclick"]) {
    counter.addEventListener(e, ev => ev.preventDefault());
  }
}

/* ══════════════════════════════════════════════════════════
   ACTIONS (taps) and CHANGES (fields)
   ══════════════════════════════════════════════════════════ */
const A = {};
const C = {};

function setDate(d) {
  ui.viewDate = d;
  saveUI();
  render();
}

A.tab = ds => {
  if (ds.tab === "pay" && ui.tab !== "pay") ui.payView = "slip";      // the Pay tab always opens on the payslip
  ui.tab = ds.tab;
  saveUI();
  render();
  window.scrollTo(0, 0);
};
A.closeSheet = () => closeSheet();

/* Today */
A.prevDay = () => setDate(pay.addDays(ui.viewDate, -1));
A.nextDay = () => setDate(pay.addDays(ui.viewDate, 1));
A.goToday = () => setDate(today());
A.toToday = () => { ui.sheet = null; closeSheet(); setDate(today()); window.scrollTo(0, 0); };
C.viewDate = (val, ds, el) => { el.blur(); if (/^\d{4}-\d{2}-\d{2}$/.test(val)) setDate(val); };

A.paidAs = () => {
  const date = ui.viewDate, day = dayOf(date), h = hol();
  const auto = pay.dayKind(date, h, null);
  const opt = (v, label) => `<button class="row" data-act="setPaidAs" data-v="${v}">
    <div class="row-main"><p class="row-t">${esc(label)}</p></div>${(day.paidAs || "") === v ? '<span class="row-v">✓</span>' : ""}</button>`;
  openSheet("How is this day paid?", `
    <p class="f-hint">The app picks the pay rate from the date. Change it only if this day is paid at a different rate.</p>
    <div class="rows">
      ${opt("", `Automatic — ${KIND[auto]}${auto === "holiday" ? ": " + (h.get(date) || "") : ""}`)}
      ${opt("weekday", "Weekday")}${opt("saturday", "Saturday")}${opt("sunday", "Sunday")}${opt("holiday", "Public holiday")}
    </div>`);
};
A.setPaidAs = ds => {
  store.saveDay(ui.viewDate, d => { d.paidAs = ds.v || null; });
  closeSheet();
};

A.openCounter = () => openCounter();

/* Start counting on a tasting that was added earlier. Its typed shift times are kept. */
A.startVisit = ds => {
  if (store.runningVisit()) { toast("Finish the tasting that is running first"); return; }
  const date = ui.viewDate;
  if (date !== today()) { toast("You can only start counting on today's tastings"); return; }
  const now = Date.now();
  let placeId = null;
  store.saveDay(date, d => {
    const v = (d.visits || []).find(x => x.id === ds.id);
    if (!v || !model.isPlanned(v)) return;
    model.startVisit(v, now);
    placeId = v.placeId;
  });
  if (!placeId) return;
  store.saveConfig(c => { const p = c.places.find(x => x.id === placeId); if (p) p.lastUsed = now; });
  if (ui.sheet) { ui.sheet = null; closeSheet(); }
  openCounter();
};

A.visit = ds => openVisit(ui.viewDate, ds.id);
A.addTasting = () => addSheet();
A.pickPlace = ds => {
  const p = placeOf(ds.id);
  if (!p || !ui.sheet || ui.sheet.kind !== "add") return;
  $("#aName").value = p.name;
  $("#aAddr").value = p.address || "";
  ui.sheet.placeId = p.id;
  $("#aErr").textContent = "";
};
/* Typing in a field that updates something as you type (not only when the field is left). */
const I = {};
I.aName = () => paintAddChips();
I.aBrand = () => { paintBrandChips(); fillBrandFlavours(); };
I.aFlav = () => paintFlavHint();
A.pickBrand = ds => {
  if (!ui.sheet || ui.sheet.kind !== "add") return;
  $("#aBrand").value = ds.name || "";
  paintBrandChips();
  fillBrandFlavours();
};
A.addSave = ds => {
  if (!ui.sheet || ui.sheet.kind !== "add") return;
  const err = m => { $("#aErr").textContent = m; };
  const name = $("#aName").value.trim(), addr = $("#aAddr").value.trim();
  const brand = model.brandName(cfg(), $("#aBrand").value);   // keep a known brand's own spelling
  const flavours = model.parseFlavours($("#aFlav").value);
  const start = $("#aStart").value, end = $("#aEnd").value;
  if (!name) return err("Type the store's name.");
  if (!start || !end) return err("Type the time the shift starts and the time it ends.");
  if (pay.minutesBetween(start, end) <= 0) return err("The shift must end after it starts.");
  const go = ds.go === "1" && ui.viewDate === today() && !store.runningVisit();
  const date = ui.viewDate, now = Date.now();
  // The day's shift times in clock order, with this one included: they become the times offered
  // next time for the 1st, 2nd … tasting of a day, whatever order they were typed in.
  const shifts = (dayOf(date).visits || []).map(x => ({ start: x.paidStart, end: x.paidEnd }))
    .concat([{ start, end }])
    .filter(t => t.start && t.end)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
    .slice(0, 6);
  const picked = ui.sheet.placeId ? placeOf(ui.sheet.placeId) : null;
  const norm = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  // Use the saved store again when a shortcut was tapped and its name left alone, or when the
  // typed name is a store already saved and the address does not say it is a different one.
  let reuse = picked && picked.name === name ? picked.id : null;
  if (!reuse) {
    const same = (cfg().places || []).find(p => !p.archived && norm(p.name) === norm(name)
      && (!addr || !p.address || norm(p.address) === norm(addr)));
    if (same) reuse = same.id;
  }

  let place = null;
  store.saveConfig(c => {
    if (reuse) {
      if (addr) model.setAddress(c, reuse, addr);
      const p = c.places.find(x => x.id === reuse);
      if (p) { p.lastUsed = now; place = { id: p.id, name: p.name }; }
    }
    if (!place) {
      const p = model.newPlace(name, now);
      p.address = addr;
      c.places.push(p);
      place = { id: p.id, name: p.name };
    }
    // remember the day's times by position for next time (later positions are left as they were)
    const us = Array.isArray(c.usualShifts) ? c.usualShifts.filter(Boolean) : [];
    shifts.forEach((t, i) => { us[i] = t; });
    c.usualShifts = us;
    // and the brand with its flavours, so they are typed once (a known list is never replaced
    // by nothing or by a single name: one flavour alone is not stored as a flavour)
    if (brand) model.rememberBrand(c, brand, flavours.length >= 2 ? flavours : (model.brandFlavours(c, brand) || []), now);
  });
  store.saveDay(date, d => {
    const v = model.plannedVisit(place, start, end, now);
    v.brand = brand;
    // one flavour alone is just the product: flavours only mean something from two up
    model.setFlavours(v, flavours.length >= 2 ? flavours : []);
    if (go) model.startVisit(v, now);
    d.visits.push(v);
    model.rebuildLegs(d, cfg());
  });
  ui.sheet = null;
  closeSheet();
  if (go) { openCounter(); return; }
  // Every day has two tastings: after the first one, offer the second straight away.
  if ((dayOf(date).visits || []).length === 1) {
    openSheet("Tasting added", `
      <p><b>${esc(place.name)}</b> is on the plan for ${esc(model.dateText(date, false))}.${addr ? "" : " It has no address yet, so its Maps button will not work until you add one."}</p>
      <button class="btn btn-go btn-big" data-act="addTasting">Add the second tasting</button>
      <button class="btn btn-big" data-act="closeSheet">Not now</button>`);
  } else toast(addr ? "Tasting added" : "Tasting added. Add the store's address for the Maps button.");
};

C.km = (val, ds, el) => commitKm(Number(ds.i), val, el);
/* One km figure for the whole day. An empty box takes it away again (the trips count as before). */
C.kmDay = (val, ds, el) => {
  const date = ui.viewDate, day = dayOf(date), had = model.hasDayKm(day);
  if (!String(val).trim()) {
    if (had) store.saveDay(date, d => model.setDayKm(d, null));
    return;
  }
  const tenths = model.parseKm(val);
  if (!tenths) {
    toast("Type the km as a number, like 41.2");
    if (el) el.value = had ? pay.kmText(day.kmDay) : "";
    return;
  }
  if (had && day.kmDay === tenths) return;
  store.saveDay(date, d => model.setDayKm(d, tenths, { date: today(), time: pay.hhmmOf(Date.now()) }));
};
A.toKm = () => {
  const el = document.querySelector("#viewToday .leg.miss") || $("#dayKm");
  if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
};
A.kmApply = ds => {
  applyKm(Number(ds.i), Number(ds.t), ds.r === "1", /^\d{4}-\d{2}-\d{2}$/.test(ds.date || "") ? ds.date : ui.viewDate);
  closeSheet();
};
A.skipLeg = ds => {
  const i = Number(ds.i);
  store.saveDay(ui.viewDate, d => { if (d.legs[i]) model.setLegSkip(d, i, !d.legs[i].skip); });
};

A.addPark = () => parkSheet(null);
A.park = ds => parkSheet(ds.id);
A.parkSave = ds => {
  const cents = model.parseMoney($("#pkAmt").value);
  if (!cents) { $("#pkErr").textContent = "Type the amount, like 6.50"; return; }
  const note = $("#pkNote").value.trim();
  store.saveDay(ui.viewDate, d => {
    if (!Array.isArray(d.parking)) d.parking = [];
    const item = ds.id ? d.parking.find(p => p.id === ds.id) : null;
    if (item) { item.cents = cents; item.note = note; }
    else d.parking.push({ id: "k_" + Date.now().toString(36), cents, note, visitId: null });
  });
  closeSheet();
};
A.parkDelete = ds => {
  store.saveDay(ui.viewDate, d => { d.parking = (d.parking || []).filter(p => p.id !== ds.id); });
  closeSheet();
};

/* The tasting sheet */
const sheetKind = ds => (ds.k === "N" || ds.k === "B" ? ds.k : "S");
A.adj = ds => editVisit(v => model.bumpCount(v, sheetKind(ds), flavourOf(ds), Number(ds.d) < 0 ? -1 : 1));
C.vsCount = (val, ds) => {
  const typed = parseInt(val, 10);
  if (!(typed >= 0) || typed > 9999) { paintVisit(); return; }
  editVisit(v => model.setCount(v, sheetKind(ds), flavourOf(ds), typed));
};

/* Flavours of the brand on the table: added at the end, renamed, or removed while nothing is
   counted for them. The brand remembers its flavours for next time. */
function rememberFlavours() {
  const ctx = sheetVisit();
  if (!ctx || !(ctx.v.brand || "").trim()) return;
  const brand = ctx.v.brand, now = Date.now();
  // a brand's remembered flavours are never replaced by "none" just because this tasting has none
  const names = model.flavoursOf(ctx.v);
  const keep = names.length ? names : (model.brandFlavours(cfg(), brand) || []);
  store.saveConfig(c => model.rememberBrand(c, brand, keep, now));
}
/* Adds what is typed in the "flavour name" box of the tasting sheet: one name, or several with
   commas between. → how many were added (0 = nothing typed, or all were on the list already). */
function commitNewFlavour() {
  const el = $("#vsNewFlav");
  if (!el || !sheetVisit()) return 0;
  const names = model.parseFlavours(el.value);
  if (!names.length) return 0;
  let added = 0;
  editVisit(v => { for (const name of names) if (model.addFlavour(v, name) >= 0) added++; });
  el.value = "";
  if (added) rememberFlavours();
  return added;
}
A.flavAdd = () => {
  const el = $("#vsNewFlav");
  if (!el || !sheetVisit()) return;
  if (!model.parseFlavours(el.value).length) { toast("Type the flavour's name first"); return; }
  if (!commitNewFlavour()) { toast("That flavour is already on the list"); return; }
  redrawVisit();
};
A.flavDel = ds => {
  let ok = false;
  editVisit(v => { ok = model.removeFlavour(v, Number(ds.i)); });
  if (!ok) { toast("This flavour has counts. Set them to 0 first."); return; }
  ui.undone = [];                       // the "add it back" offer pointed at the old list of flavours
  rememberFlavours();
  redrawVisit();
};
C.vsFlav = (val, ds) => {
  let ok = false;
  editVisit(v => { ok = model.renameFlavour(v, Number(ds.i), val); });
  if (!ok) toast("A flavour needs a name, and two flavours cannot have the same name");
  else rememberFlavours();
  paintVisit();
};
C.vsSaid = val => editVisit(v => { v.comments = String(val).replace(/\s+/g, " ").trim().slice(0, 300); });
C.vsTime = (val, ds) => {
  if (!val) { paintVisit(); return; }
  editVisit(v => {
    if (ds.w === "s") { v.paidStart = val; v.startManual = true; }
    else { v.paidEnd = val; v.endManual = true; }
  }, true);
};
A.tstep = ds => {
  const ctx = sheetVisit();
  if (!ctx) return;
  const { sh, v } = ctx;
  const base = ds.w === "s" ? v.paidStart : (v.paidEnd || (sh.sug ? sh.sug.paidEnd : "") || v.paidStart);
  const next = pay.addMinutes(base, Number(ds.d));
  if (!next) return;
  editVisit(x => {
    if (ds.w === "s") { x.paidStart = next; x.startManual = true; }
    else { x.paidEnd = next; x.endManual = true; }
  }, true);
};
A.len = ds => editVisit(v => { v.paidEnd = pay.addMinutes(v.paidStart, Number(ds.min)); v.endManual = true; }, true);
A.brk = ds => editVisit(v => { v.breakMin = Number(ds.min); });
A.dropLate = () => editVisit(v => { model.dropLateTaps(v); });
A.eve = ds => {
  const ctx = sheetVisit();
  if (!ctx) return;
  if (ds.v === "unsure") { ctx.sh.eveSkip = true; paintVisit(); return; }
  const from = rateSet(ctx.sh.date).from;
  store.saveConfig(c => {
    const set = c.rateSets.find(x => x.from === from) || c.rateSets[latestRateIndex(c)];
    if (ds.v === "yes") {
      set.evening = set.saturday;
      for (const later of c.rateSets) {
        if (later.from > set.from && typeof later.evening !== "number") later.evening = later.saturday;
      }
    }
    c.eveningAsked = true;
  });
  paintVisit();
};
C.vsPark = val => {
  const ctx = sheetVisit();
  if (!ctx) return;
  const cents = String(val).trim() === "" ? 0 : model.parseMoney(val);
  if (cents == null) { toast("Type the amount as a number, like 6.50"); paintVisit(); return; }
  const { sh, v } = ctx;
  store.saveDay(sh.date, d => {
    if (!Array.isArray(d.parking)) d.parking = [];
    const i = d.parking.findIndex(p => p.visitId === sh.id);
    if (!cents) { if (i >= 0) d.parking.splice(i, 1); }
    else if (i >= 0) d.parking[i].cents = cents;
    else d.parking.push({ id: "k_" + Date.now().toString(36), cents, note: v.placeName, visitId: sh.id });
  });
  paintVisit();
};
C.vsNote = val => editVisit(v => { v.note = String(val).slice(0, 300); });
C.vsBrand = val => {
  // a flavour name waiting in the "add" box must not be redrawn away by the auto-fill below;
  // leave it, and the normal commit on the next button or close adds it under this brand
  const nf = $("#vsNewFlav");
  const typedFlav = !!nf && model.parseFlavours(nf.value).length > 0;
  const name = model.brandName(cfg(), val);            // a brand retyped in another case keeps its spelling
  const known = model.brandFlavours(cfg(), name) || [];
  let filled = false;
  editVisit(v => {
    v.brand = name;
    // a brand the app knows brings its flavours, while this tasting has none and nothing counted
    const n = model.counts(v);
    if (known.length >= 2 && !typedFlav && !model.flavoursOf(v).length && n.talked === 0 && n.sold === 0 && !(v.tapK || "").length) {
      model.setFlavours(v, known);
      filled = true;
    }
  });
  // learn this tasting's flavours for the brand only when the brand is new, or we just filled it
  // in — never when the brand is already known, so typing it cannot wipe that brand's own list
  if (filled || !known.length) rememberFlavours();
  if (filled) { redrawVisit(); toast("Flavours added. If you tapped a button, tap it again."); }
};
A.vsMore = () => showMore();
A.zeroOk = () => editVisit(v => { v.zeroOk = true; });

/* The three numbers for one tasting, as text: of the tasting named on the button (date + id),
   or of the tasting whose sheet is open. */
function reportOf(ds) {
  if (ds && ds.date && ds.id) {
    const day = dayOf(ds.date), v = (day.visits || []).find(x => x.id === ds.id);
    return v ? model.reportText(day, v) : null;
  }
  const ctx = sheetVisit();
  if (!ctx) return null;
  const { sh, day, v } = ctx;
  return model.reportText(day, { ...v, paidEnd: v.paidEnd || (sh.sug ? sh.sug.paidEnd : "") });
}
A.copyReport = ds => { const t = reportOf(ds); if (t) copyText(t, "Report copied"); };
A.shareReport = ds => { const t = reportOf(ds); if (t) shareText(t, "Report copied"); };

/* The whole day in one message: both tastings, the km and the parking. No pay amounts. */
const dayReport = () => report.dayReportText(dayOf(ui.viewDate), cfg());
A.dayReport = () => {
  const day = dayOf(ui.viewDate);
  const t = pay.dayTotals(day, cfg(), hol());
  const warn = [];
  if ((day.visits || []).some(model.isRunning)) warn.push("A tasting is still running. Finish it first, so the numbers are final.");
  if ((day.visits || []).some(v => isWaiting(v) && !v.zeroOk)) warn.push("A tasting has not been counted yet. Its numbers are 0 in this report.");
  if (t.missingKm) warn.push(`${plural(t.missingKm, "trip")} still ${t.missingKm === 1 ? "has" : "have"} no km. The report says "km not entered".`);
  openSheet("Day report", `
    ${warn.map(w => `<div class="note warn">${esc(w)}</div>`).join("")}
    <pre class="report">${esc(dayReport())}</pre>
    <p class="f-hint">This is the message that is sent. It has no pay amounts in it.</p>
    <div class="f-actions">
      <button class="btn btn-primary" data-act="shareDay">Share</button>
      <button class="btn btn-ghost" data-act="copyDay">Copy</button>
    </div>`);
};
A.copyDay = () => copyText(dayReport(), "Day report copied");
A.shareDay = () => shareText(dayReport(), "Day report copied");
A.keepCounting = () => {
  ui.lastAct = Date.now();
  closeSheet();
  if (!ui.counter && store.runningVisit()) openCounter();
};
A.countMore = () => {
  const ctx = sheetVisit();
  if (!ctx) return;
  if (store.runningVisit()) { toast("Finish the tasting that is running first"); return; }
  editVisit(v => model.reopenVisit(v));
  ui.sheet = null;
  closeSheet();
  openCounter();
};
A.doneVisit = () => {
  const ctx = sheetVisit();
  if (!ctx) { closeSheet(); return; }
  const { v } = ctx;
  if (!model.isRunning(v)) { closeSheet(); return; }
  const n = model.counts(v);
  if (n.talked === 0 && n.sold === 0 && Date.now() - v.startedAt < 5 * 60000) {
    const { sh } = ctx;
    openSheet("No counts yet", `
      <p>You have not counted anyone yet. What do you want to do?</p>
      <button class="btn btn-go btn-big" data-act="closeSheet">Back to counting</button>
      <button class="btn btn-big" data-act="cancelVisit">Stop counting. Keep the tasting on today's list</button>
      <button class="btn btn-big" data-act="keepVisit" data-date="${sh.date}" data-id="${esc(sh.id)}">Finish with 0 people counted</button>
      <button class="btn btn-danger hold" id="ncDelete">Hold to delete this tasting</button>`);
    holdButton($("#ncDelete"), 1000, () => deleteVisit(sh.date, sh.id));
    return;
  }
  finishRunning();
};
A.keepVisit = ds => {
  ui.sheet = { kind: "visit", date: ds.date, id: ds.id, eveSkip: false, sug: null };
  const ctx = sheetVisit();
  if (ctx) ctx.sh.sug = suggestEnd(ctx.v);
  finishRunning();
};

/* Counter */
A.lock = () => cover("lock");
/* Leave the Counter without finishing: look at the day, type km, add parking. The tasting keeps
   running; the big green "Back to counting" button on Today comes straight back. */
A.showDay = () => {
  const r = store.runningVisit();
  ui.undone = [];
  ui.backUntil = 0;
  closeCounter();
  rollDay();                    // as in finishRunning
  ui.tab = "today";
  if (r) ui.viewDate = r.date;
  saveUI();
  render();
  window.scrollTo(0, 0);
};
A.finish = () => {
  const r = store.runningVisit();
  if (!r) return;
  // The numbers can be typed over on the sheet, so a pending "put it back" no longer means anything.
  ui.undone = [];
  ui.backUntil = 0;
  openVisit(r.date, r.visit.id);
};
A.minus = (ds, el) => { if (!el || !el.disabled) takeOff(kindOf(ds), flavourOf(ds)); };
/* The line above the numbers. What a tap on it does depends on what it is offering. */
A.lineTap = () => {
  if (ui.undone.length) { putBack(); return; }
  const r = store.runningVisit();
  if (!r || (r.visit.tapK || "").length) return;
  const v = r.visit;
  openSheet("Wrong store or times?", `
    <p><b>${esc(v.placeName)}</b><br>Shift ${esc(t12(v.paidStart))}${v.paidEnd ? " – " + esc(t12(v.paidEnd)) : ""}</p>
    <button class="btn btn-go btn-big" data-act="closeSheet">Back to counting</button>
    <button class="btn btn-big" data-act="editTimes">Change the shift times or the flavours</button>
    ${placeOf(v.placeId) ? `<button class="btn btn-big" data-act="place" data-id="${esc(v.placeId)}">Change the store name or address</button>` : ""}
    <button class="btn btn-danger btn-big" data-act="cancelVisit">Not this store — stop counting</button>`);
};
A.editTimes = () => {
  const r = store.runningVisit();
  if (r) openVisit(r.date, r.visit.id, { editOnly: true });
};
/* Stop counting without finishing. A tasting that was added with its shift times stays on the
   day's list, uncounted; one started the old way (no typed times) is removed. */
A.cancelVisit = () => {
  const r = store.runningVisit();
  if (!r) return;
  const keep = !!(r.visit.startManual && r.visit.endManual);
  store.saveDay(r.date, d => {
    if (keep) {
      const v = (d.visits || []).find(x => x.id === r.visit.id);
      if (v) {
        // Counts typed in by hand before counting was started (no taps were made) are not
        // part of this run: they stay. With taps, unstartVisit clears everything, as before.
        const typed = (v.tapK || "").length ? null
          : { adjS: v.adjS || 0, adjN: v.adjN || 0, adjB: v.adjB || 0, adjF: (v.adjF || []).slice(), adjBF: (v.adjBF || []).slice() };
        model.unstartVisit(v);
        if (typed) Object.assign(v, typed);
      }
    } else {
      d.visits = (d.visits || []).filter(v => v.id !== r.visit.id);
    }
    model.rebuildLegs(d, cfg());
  });
  ui.undone = [];
  closeCounter();
  closeSheet();                 // also redraws Today
  toast(keep ? "Stopped counting. The tasting is still on the list." : "Tasting cancelled");
};

/* Pay */
A.period = ds => {
  store.saveConfig(c => { c.payPeriod.days = Number(ds.days) === 14 ? 14 : 7; });
  if (ui.sheet && ui.sheet.kind === "setupRates") A.setupRates();       // redraw the sheet with the new choice
};
function shiftPeriod(n) {
  const days = cfg().payPeriod.days === 14 ? 14 : 7;
  ui.payDate = pay.addDays(pay.periodOf(ui.payDate, cfg().payPeriod).start, n * days);
  render();
}
A.prevPeriod = () => shiftPeriod(-1);
A.nextPeriod = () => shiftPeriod(1);
A.thisPeriod = () => { ui.payDate = today(); render(); };
A.goto = ds => {
  if (!ds.date) return;
  ui.tab = "today";
  setDate(ds.date);
  window.scrollTo(0, 0);
};
A.copyPay = () => copyText(payText(), "Payslip copied");
A.sharePay = () => shareText(payText(), "Payslip copied");
A.openPay = ds => {
  ui.payDate = /^\d{4}-\d{2}-\d{2}$/.test(ds.date || "") ? ds.date : today();
  ui.tab = "pay";
  ui.payView = "slip";
  saveUI();
  render();
  window.scrollTo(0, 0);
};
A.payView = ds => { ui.payView = ds.view === "more" ? "more" : "slip"; saveUI(); render(); window.scrollTo(0, 0); };
/* From Today: straight to the list of days that still need something. */
A.openFix = () => { ui.tab = "pay"; ui.payView = "more"; saveUI(); render(); window.scrollTo(0, 0); };
/* The answer to "which pay week or fortnight are you in now?": it settles how long a pay
   period is and the day it starts on. */
A.periodPick = ds => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds.start || "")) return;
  const days = Number(ds.days) === 14 ? 14 : 7;
  ui.payDate = today();                                   // set before the save, whose redraw reads it
  store.saveConfig(c => { c.payPeriod = { ...c.payPeriod, days, anchor: ds.start, confirmed: true }; });
  toast("Saved. You can change it in Settings.");
};
A.calMonth = ds => { if (/^\d{4}-\d{2}$/.test(ds.ym || "")) { ui.calMonth = ds.ym; render(); } };
/* The pay period as a file a spreadsheet can open (Numbers, Excel, Google Sheets). */
A.exportPay = () => {
  const { start, end } = payData();
  // The leading mark (a "byte order mark") tells Excel the file is UTF-8, so store names with accents read correctly.
  shareFile(`tastings-${start}-to-${end}.csv`, "text/csv", "\uFEFF" + report.periodCsv(store.listDays(), cfg(), hol(), start, end));
};
/* What the payslip said for one pay period. An empty box removes it. */
C.paid = (val, ds) => {
  const key = ds.key, text = String(val).trim();
  if (!key) return;
  const cents = text === "" ? null : model.parseMoney(text);
  if (text !== "" && cents == null) { toast("Type the amount as a number, like 512.40"); render(); return; }
  store.saveConfig(c => {
    if (!c.paid || typeof c.paid !== "object" || Array.isArray(c.paid)) c.paid = {};
    if (cents == null) delete c.paid[key]; else c.paid[key] = cents;
  });
};
C.anchor = (val, ds, el) => {
  el.blur();
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) store.saveConfig(c => { c.payPeriod.anchor = val; c.payPeriod.confirmed = true; });
};

/* Settings */
A.place = ds => placeSheet(ds.id);
A.placeSave = ds => {
  const id = ds.id, addr = $("#plAddr").value.trim();
  const before = addrOf(id);
  let name = null;
  if (id === "home") {
    store.saveConfig(c => model.setAddress(c, "home", addr));
  } else {
    name = $("#plName").value.trim();
    if (!name) { $("#plErr").textContent = "The store needs a name."; return; }
    store.saveConfig(c => {
      const p = c.places.find(x => x.id === id);
      if (!p) return;
      p.name = name;
      model.setAddress(c, id, addr);
    });
  }
  // Today, later days and the day on screen: show the new name on their tastings and trips.
  // Where the address changed, km typed for trips to or from it were measured to the old
  // address, so they are emptied to be measured again. Other past days are history and stay.
  const moved = !!before && before !== addr;
  let cleared = false;
  for (const d of store.listDays()) {
    if (d.date < today() && d.date !== ui.viewDate) continue;
    const touches = (d.visits || []).some(v => v.placeId === id) || (id === "home" && (d.legs || []).length > 0);
    if (!touches) continue;
    store.saveDay(d.date, x => {
      if (name) for (const v of x.visits || []) if (v.placeId === id) v.placeName = name;
      if (moved) {
        for (const l of x.legs || []) {
          if ((l.from === id || l.to === id) && typeof l.tenths === "number") {
            l.tenths = null; l.checkedOn = null; l.checkedTime = null; cleared = true;
          }
        }
        if (model.hasDayKm(x)) { model.setDayKm(x, null); cleared = true; }
      }
      model.rebuildLegs(x, cfg());
    });
  }
  closeSheet();
  if (cleared) toast("Address changed. Type the km for those trips again.");
};
A.placeArchive = ds => {
  store.saveConfig(c => { const p = c.places.find(x => x.id === ds.id); if (p) p.archived = true; });
  closeSheet();
  toast("Removed from the list. Past days keep it.");
};
A.toll = () => store.saveConfig(c => { c.avoidTolls = c.avoidTolls === false; });
C.rate = (val, ds) => {
  const f = ds.f;
  const text = String(val).trim();
  let cents = text === "" ? null : model.parseMoney(text);
  const unreadable = text !== "" && cents == null;
  if (f === "evening" && cents === 0) cents = null;          // "0" here means "no different rate": the same as empty
  if (unreadable || (cents == null && f !== "evening") || (cents === 0 && f !== "km")) {
    toast("Type the rate as a number, like 34.76");
    render();
    return;
  }
  store.saveConfig(c => {
    const set = c.rateSets[currentRateIndex(c)];
    set[f] = cents;
    if (f === "evening") c.eveningAsked = true;
    if (c.setup) c.setup.ratesChecked = true;        // a rate typed by hand has been checked
  });
};

/* Rates that change on a date: a new set is added, so earlier days keep their old rates. */
A.newRates = () => {
  const c = cfg(), r = c.rateSets[currentRateIndex(c)];
  openSheet("My rates changed", `
    <p class="f-hint">Type the new rates and the first day they apply. Days before that date keep the old rates.</p>
    <div class="f"><label>New rates start on</label><input type="date" id="nrFrom" value="${today()}"></div>
    <div class="f-row">${RATE_FIELDS.map(([f, label]) => `<div class="f"><label>${label}</label>
      <input inputmode="decimal" autocomplete="off" id="nr_${f}" value="${rateVal(r[f])}" placeholder="${f === "evening" ? "same" : "0.00"}"></div>`).join("")}</div>
    <p class="gate-note" id="nrErr"></p>
    <button class="btn btn-primary btn-big" data-act="newRatesSave">Save the new rates</button>`);
};
A.newRatesSave = () => {
  const err = m => { $("#nrErr").textContent = m; };
  const from = $("#nrFrom").value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return err("Pick the day the new rates start.");
  const vals = {};
  for (const [f, label] of RATE_FIELDS) {
    const text = $("#nr_" + f).value.trim();
    if (f === "evening" && text === "") { vals[f] = null; continue; }
    const cents = model.parseMoney(text);
    if (cents == null || (cents === 0 && f !== "km")) return err(`Type a number for "${label}", like 34.76`);
    vals[f] = cents;
  }
  store.saveConfig(c => {
    const same = c.rateSets.find(x => x.from === from);
    if (same) Object.assign(same, vals);
    else c.rateSets.push({ ...c.rateSets[currentRateIndex(c)], ...vals, from });
    if (vals.evening != null) c.eveningAsked = true;
  });
  closeSheet();
  toast(`New rates saved, from ${model.dateText(from)}`);
};
A.rateRemove = ds => {
  // The earliest set stays: without it every earlier day would be paid at the newer rates.
  const first = cfg().rateSets.map(x => x.from).sort()[0];
  if (cfg().rateSets.length < 2 || ds.from === first) { toast("These are your first rates. Change the numbers in the boxes instead."); return; }
  store.saveConfig(c => { c.rateSets = c.rateSets.filter(x => x.from !== ds.from); });
  toast("Removed. Days from that date now use the older rates.");
};

/* The first-time guide */
A.setupRates = () => {
  const c = cfg(), r = c.rateSets[currentRateIndex(c)];
  const days = c.payPeriod.days === 14 ? 14 : 7;
  openSheet("Check your pay", `
    <p class="f-hint">The app uses these rates to add up your pay. Change any that are different on your payslip.</p>
    <div class="f-row">${rateFields(r)}</div>
    <div class="f"><label>How often are you paid?</label>
      <div class="seg">
        <button class="${days === 7 ? "on" : ""}" data-act="period" data-days="7">Every week</button>
        <button class="${days === 14 ? "on" : ""}" data-act="period" data-days="14">Every fortnight</button>
      </div></div>
    <div class="f"><label>First day of a pay ${days === 14 ? "fortnight" : "week"}</label>
      <input type="date" value="${esc(c.payPeriod.anchor)}" data-chg="anchor"></div>
    <p class="f-hint">Look at a payslip. It says "pay period from … to …". Pick the "from" date of any payslip.</p>
    <button class="btn btn-primary btn-big" data-act="setupRatesOk">These are right</button>`, { kind: "setupRates" });
};
A.setupRatesOk = () => {
  store.saveConfig(c => { c.setup = { ...(c.setup || {}), ratesChecked: true }; c.payPeriod.confirmed = true; });
  closeSheet();
};
A.setupTolls = () => {
  openSheet("Avoid tolls in Google Maps", `
    <p>Tolls are not paid back. So the km must be measured on roads with no tolls, and you should drive on them too.</p>
    <p><b>Do this one time in the Google Maps app:</b></p>
    <ol class="steps">
      <li>Open Google Maps and get directions to any place.</li>
      <li>Tap the three dots (More), then <b>Options</b>.</li>
      <li>Turn on <b>Avoid tolls</b>.</li>
    </ol>
    <p class="f-hint">The Maps buttons in this app also ask for a route with no tolls. If Google Maps still shows a toll on a route, check that Avoid tolls is on.</p>
    <button class="btn btn-primary btn-big" data-act="setupTollsOk">I have done this</button>
    <button class="btn btn-big" data-act="closeSheet">Later</button>`);
};
A.setupTollsOk = () => {
  store.saveConfig(c => { c.setup = { ...(c.setup || {}), tollsDone: true }; });
  closeSheet();
};
A.setupHide = () => {
  store.saveConfig(c => { c.setup = { ...(c.setup || {}), hidden: true }; });
  toast("Hidden. You can show it again in Settings.");
};
A.setupShow = () => {
  store.saveConfig(c => { c.setup = { ...(c.setup || {}), hidden: false }; });
  ui.tab = "today";
  saveUI();
  render();
  window.scrollTo(0, 0);
};

/* Help: short answers in simple words. Works with no internet. */
const HELP = [
  ["In the morning", "On Today, tap <b>Add a tasting</b>. Type the store, its address and your shift times. Do this for both stores."],
  ["At the store", "Tap <b>Start counting</b>. Tap the green box for each sample you give. Tap the yellow box for each person who says no or ignores you. Tap the blue <b>Sold</b> box for each bottle or pack you sell. Total interactions is the samples and the rejected added together."],
  ["Two or more flavours", "When you add the tasting, type the flavours with a comma between, like <b>Lime, Mango</b>. Each flavour gets its own green box and its own Sold box. A customer who tries two flavours is two taps. The app remembers a brand's flavours for next time. Forgot a flavour? Tap <b>Finish tasting</b>, then <b>Change the numbers, flavours or times</b>, add it, then <b>Back to counting</b>."],
  ["A wrong tap", "Tap <b>− undo</b> on the left of that box. It takes one off."],
  ["Phone in your pocket", "Tap <b>Lock</b>. Slide to unlock. Your counts stay saved."],
  ["Look at your day while counting", "Tap <b>My day</b>. The tasting keeps running. Tap <b>Back to counting</b> to return."],
  ["When the shift ends", "Tap the pink <b>Finish tasting</b> button, then <b>Finish tasting</b> again. Then tap <b>Share report</b> to send your numbers."],
  ["Km", "On Today, tap <b>Maps</b> on a trip. Read the km in Google Maps, on roads with no tolls. Come back and type it. Or use <b>Whole day: one km number</b>: one Maps route, one number."],
  ["Parking", "On Today, tap <b>Add parking</b> and type the amount. Keep the receipt."],
  ["A number is wrong after you finish", "On Today, tap the tasting. Change the numbers or the times there."],
  ["Your pay", "The <b>Pay</b> tab opens on your <b>Payslip</b>: hours, pay for those hours, travel, parking and the total payout for the pay fortnight. On pay day, type the total from your real payslip there. The app tells you if it matches."],
  ["No internet", "The app still works. Everything is saved on the phone and backed up to your Google account when you are online again."],
  ["A new version", "When a green bar says <b>New version ready</b>, tap <b>Update now</b>."]
];
A.help = () => {
  openSheet("How to use this app", `
    <div class="help">${HELP.map(([q, a]) => `<div class="help-i"><p class="help-q">${q}</p><p class="help-a">${a}</p></div>`).join("")}</div>
    <button class="btn btn-big" data-act="closeSheet">Close</button>`);
};

/* My data: a backup file out, and missing days back in. */
A.backup = async () => {
  const text = report.backupText(cfg(), store.listDays(), new Date().toISOString());
  const ok = await shareFile(`tastings-backup-${today()}.json`, "application/json", text);
  if (ok) { ls.set("lastBackup", today()); render(); }
};
C.restoreFile = async (val, ds, el) => {
  const file = el.files && el.files[0];
  if (!file) return;
  // Only once the phone holds what the account holds: then a day missing here is missing there
  // too, and bringing it back cannot replace newer work that simply has not arrived yet.
  if (!DEMO && !(ui.user && store.status().ready)) {
    el.value = "";
    openSheet("Not ready yet", `
      <p>The app must first load what is already in your account. Then the file can only add days, never replace newer work.</p>
      <p><b>Connect to the internet, sign in, wait a moment, then choose the file again.</b></p>
      <button class="btn btn-big" data-act="closeSheet">OK</button>`);
    return;
  }
  let data = null;
  try { data = JSON.parse(await file.text()); } catch (e) { data = null; }
  el.value = "";
  if (!data || typeof data !== "object" || data.app !== "tastings" || !Array.isArray(data.days)) {
    toast("That is not a Tastings backup file");
    return;
  }
  let added = 0, kept = 0, bad = 0;
  for (const raw of data.days) {
    const d = model.cleanBackupDay(raw);
    if (!d) { bad++; continue; }
    if (!model.dayHasContent(d)) continue;
    if (model.dayHasContent(store.getDay(d.date))) { kept++; continue; }
    store.saveDay(d.date, x => { for (const k of Object.keys(d)) if (k !== "date" && k !== "updatedAt") x[k] = d[k]; });
    added++;
  }
  // Stores named in the backup that this phone does not know come back too (their addresses
  // feed the Maps buttons). Settings come back only onto a phone that has none of its own yet.
  const src = data.config && typeof data.config === "object" && !Array.isArray(data.config)
    ? model.withConfigDefaults(data.config) : null;
  let settings = false;
  if (src) {
    const fresh = !cfg().homeAddress && !(cfg().places || []).length;
    store.saveConfig(c => {
      if (fresh) {
        for (const k of Object.keys(src)) if (k !== "updatedAt" && k !== "places") c[k] = src[k];
        settings = true;
      }
      for (const p of src.places) {
        if (!p || typeof p.id !== "string" || typeof p.name !== "string" || c.places.some(x => x.id === p.id)) continue;
        c.places.push({
          id: p.id, name: p.name, address: typeof p.address === "string" ? p.address : "",
          lastUsed: Number(p.lastUsed) || 0, archived: !!p.archived
        });
      }
    });
  }
  openSheet("Backup file read", `
    <p><b>${plural(added, "day")} added.</b></p>
    ${kept ? `<p>${plural(kept, "day")} already on this phone ${kept === 1 ? "was" : "were"} left as ${kept === 1 ? "it is" : "they are"}.</p>` : ""}
    ${bad ? `<p>${plural(bad, "day")} in the file could not be read.</p>` : ""}
    ${settings ? "<p>Your settings came back too.</p>" : ""}
    <button class="btn btn-big" data-act="closeSheet">Close</button>`);
};
A.holRemove = ds => store.saveConfig(c => {
  const i = c.holidaysAdded.findIndex(h => h.date === ds.date);
  if (i >= 0) c.holidaysAdded.splice(i, 1);
  else if (!c.holidaysRemoved.includes(ds.date)) c.holidaysRemoved.push(ds.date);
});
A.holAdd = () => {
  const d = $("#holDate").value, n = $("#holName").value.trim() || "Public holiday";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { toast("Pick the date first"); return; }
  store.saveConfig(c => {
    c.holidaysRemoved = c.holidaysRemoved.filter(x => x !== d);
    if (!c.holidaysAdded.some(h => h.date === d)) c.holidaysAdded.push({ date: d, name: n });
  });
  toast("Holiday added");
};

/* Account */
A.signIn = () => {
  const note = m => { $("#gateNote").textContent = m; if ($("#gate").hidden && m) toast(m); };
  if (!ui.fb) {
    note(navigator.onLine === false ? "No connection. Connect to the internet to sign in." : "Still connecting — try again in a moment.");
    connect();
    return;
  }
  note("");
  ui.fb.signIn().catch(e => { console.error(e); note("Sign-in did not work. Check your internet, then tap Sign in again."); });
};
A.signOut = () => {
  if (store.status().dirty) { toast("Wait until your changes are backed up, then sign out"); return; }
  ls.del("owner");
  store.detachRemote();
  ui.user = null;
  if (ui.fb) ui.fb.signOut().catch(() => {});
  showGate();
};
A.skipInstall = () => { $("#installHint").hidden = true; ls.set("skipInstall", "1"); };

/* App update */
A.checkUpdate = () => {
  if (!ui.swReg) { toast("The app can check for updates when it is online. Try again in a moment."); return; }
  if (navigator.onLine === false) { toast("Connect to the internet first"); return; }
  ui.swReg.update()
    .then(() => setTimeout(() => {
      noteWaiting();
      if (ui.swReg.installing) toast("Downloading the new version. A green bar appears when it is ready.");
      else toast(ui.swWaiting ? "New version ready" : "You have the latest version");
    }, 1500))
    .catch(() => toast("Could not check just now. Try again later."));
};
A.updateNow = () => {
  const w = ui.swReg && ui.swReg.waiting;
  if (!w) { toast("No update waiting"); return; }
  if (navigator.onLine === false) { toast("Connect to the internet first"); return; }
  if (store.runningVisit()) { toast("Finish the tasting that is running first"); return; }
  ui.updateAsked = true;
  store.flush();
  w.postMessage({ type: "SKIP_WAITING" });
};

/* ══════════════════════════════════════════════════════════
   ACCOUNT AND SYNC
   ══════════════════════════════════════════════════════════ */
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () => navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;

function showGate() {
  $("#boot").hidden = true;
  $("#app").hidden = true;
  $("#tabs").hidden = true;
  $("#counter").hidden = true;
  $("#gate").hidden = false;
  $("#installHint").hidden = !(isIOS && !isStandalone() && ls.get("skipInstall") !== "1");
  if (ui.userMsg) $("#gateNote").textContent = ui.userMsg;
}

function showApp() {
  $("#boot").hidden = true;
  $("#gate").hidden = true;
  $("#app").hidden = false;
  $("#tabs").hidden = false;
  restoreUI();
  const r = store.runningVisit();
  if (r && (r.date < today() || Date.now() - r.visit.startedAt > 14 * 3600000)) {
    // Left running since an earlier day: go to its finish sheet, not the counter.
    ui.tab = "today";
    ui.viewDate = r.date;
    render();
    openVisit(r.date, r.visit.id, { stale: true });
  } else if (r && shiftOverMin(r) > 30) {
    // Opened well after the shift's typed end: offer to finish, with the counter one tap away.
    ui.tab = "today";
    ui.viewDate = r.date;
    openCounter();
    openVisit(r.date, r.visit.id, { over: true });
  } else if (r) {
    openCounter();
  } else {
    render();
  }
}

async function connect() {
  if (DEMO || ui.fb || ui.fbState === "connecting") return;
  ui.fbState = "connecting";
  try {
    const mod = await import("./remote-firebase.js");
    ui.fb = await mod.connectFirebase({ onUser });
    ui.fbState = "ready";
    applyUser();
  } catch (e) {
    console.error("firebase", e);
    ui.fbState = "offline";
    window.addEventListener("online", () => connect(), { once: true });
    if (!$("#gate").hidden) $("#gateNote").textContent = "No connection. Connect to the internet to sign in the first time.";
  }
  render();
}

function onUser(user, message) {
  ui.user = user || null;
  ui.userMsg = message || "";
  ui.authKnown = true;
  applyUser();
}

function applyUser() {
  if (!ui.authKnown || !ui.fb) return;       // wait until both the SDK and the answer are in
  if (ui.user) {
    ls.set("owner", "1");
    try { store.attachRemote(ui.fb.remote); } catch (e) { console.error(e); }
    if (!$("#gate").hidden) showApp(); else render();
  } else {
    store.detachRemote();
    if (ownerFlag() && !ui.userMsg) render();           // keep working; a quiet "Sign in to sync" bar shows
    else { ls.del("owner"); showGate(); }
  }
}

/* ══════════════════════════════════════════════════════════
   SERVICE WORKER
   A new version downloads in the background and waits. It is
   switched on only when "Update now" is tapped, never mid-tasting.
   ══════════════════════════════════════════════════════════ */
function noteWaiting() {
  const reg = ui.swReg;
  ui.swWaiting = !!(reg && reg.waiting && navigator.serviceWorker.controller);
  if (!ui.counter) render();
}

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  if (local && !Q.has("sw")) return;
  navigator.serviceWorker.register("/sw.js").then(reg => {
    ui.swReg = reg;
    noteWaiting();
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      if (w) w.addEventListener("statechange", noteWaiting);
    });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !ui.updateAsked) return;
    reloading = true;
    location.reload();
  });
}

/* ══════════════════════════════════════════════════════════
   WIRING AND START-UP
   ══════════════════════════════════════════════════════════ */
function wire() {
  document.addEventListener("pointerdown", () => { ptrDown = true; }, true);
  const up = () => {
    ptrDown = false;
    if (queued) setTimeout(() => { if (!ptrDown && queued) render(); }, 80);
  };
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", up, true);
  document.addEventListener("focusout", () => {
    setTimeout(() => { if (ui.pending && !ui.counter) render(); }, 80);
  });

  document.addEventListener("click", ev => {
    const a = ev.target.closest("[data-act]");
    if (!a) return;
    const fn = A[a.dataset.act];
    if (!fn) return;
    // iPhone does not move focus to a tapped button: finish any field being typed in first.
    const f = document.activeElement;
    if (f && f !== a && /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName)) {
      const before = ui.sheet;
      f.blur();
      // Leaving the field asked a question (the "Which km is right?" sheet): answer that first.
      if (ui.sheet && ui.sheet !== before) return;
    }
    // A flavour name typed on the tasting sheet but not added yet: add it now, so that Back to
    // counting, Finish or Close cannot throw it away. The sheet is drawn again with the new
    // flavour's boxes, and the button that was tapped is tapped again by the user.
    if (a.dataset.act !== "flavAdd" && a.dataset.act !== "closeSheet" && commitNewFlavour()) {
      redrawVisit();
      toast("Flavour added. Now tap the button again.");
      return;
    }
    fn(a.dataset, a, ev);
  });

  document.addEventListener("change", ev => {
    const el = ev.target.closest("[data-chg]");
    if (!el) return;
    const fn = C[el.dataset.chg];
    if (!fn) return;
    inChange = true;                       // see render()
    try { fn(el.value, el.dataset, el); } finally { inChange = false; }
  });
  document.addEventListener("input", ev => {
    const el = ev.target.closest && ev.target.closest("[data-inp]");
    const fn = el && I[el.dataset.inp];
    if (fn) fn(el.value, el.dataset, el);
  });

  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape" && ui.sheet) { closeSheet(); return; }
    if (ev.key !== "Enter" || !ev.target.matches || !ev.target.matches("input")) return;
    // Return in the "flavour name" box means Add (every other box saves itself when it is left)
    if (ev.target.id === "vsNewFlav" && !ev.isComposing) { ev.preventDefault(); A.flavAdd(); return; }
    ev.target.blur();
  });

  $("#scrim").addEventListener("click", () => closeSheet());

  // Leaving the app (to Google Maps, say) with a number still being typed: save it first.
  // A field only saves itself when it is left, and the phone may close the app while it is away.
  const commitField = () => {
    const f = document.activeElement;
    if (f && f.matches && f.matches("[data-chg]")) f.blur();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { commitField(); store.flush(); saveUI(); return; }
    if (ui.counter && !ui.covered) wakeOn();
    rollDay();
    render();
  });
  window.addEventListener("pagehide", () => { commitField(); store.flush(); saveUI(); });
  window.addEventListener("online", () => render());
  window.addEventListener("offline", () => render());

  // keeps "Backed up 2 min ago" honest
  setInterval(() => {
    if (document.hidden) return;
    const rolled = rollDay();
    if (!ui.counter && !ui.sheet && (ui.tab === "today" || rolled)) render();
  }, 30000);

  wireCounter();
  store.subscribe(render);
}

function seedDemo() {
  if ((cfg().places || []).length) return;
  const now = Date.now(), d = today();
  store.saveConfig(c => {
    c.homeAddress = "100 Sydney Rd, Brunswick VIC 3056";
    c.places = [
      { id: "p_demo_a", name: "Store A · High St", address: "250 High St, Northcote VIC 3070", lastUsed: now, archived: false },
      { id: "p_demo_b", name: "Store B · Station St", address: "90 Station St, Fairfield VIC 3078", lastUsed: now - 1000, archived: false }
    ];
    c.kmMemory = {
      "home>p_demo_a": { tenths: 124, checkedOn: d, checkedTime: "09:40", via: "", stale: false },
      "p_demo_b>home": { tenths: 151, checkedOn: d, checkedTime: "09:42", via: "", stale: false }
    };
  });
}

function boot() {
  wire();
  if (DEMO) { seedDemo(); showApp(); }
  else if (ownerFlag()) { showApp(); connect(); }
  else { showGate(); connect(); }
  registerSW();
}

boot();
