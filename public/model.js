/* ══════════════════════════════════════════════════════════
   Tastings — operations on the day and config documents.
   Pure: no DOM, no storage, no Firebase. Functions that need
   the time take `now` as an argument.
   Shapes are described in SPEC.md section 5.
   ══════════════════════════════════════════════════════════ */

import {
  DEFAULT_RATE_SET, roundHHMM, hhmmOf, addMinutes, toMin, fromMin, minutesBetween, parseISO, todayISO
} from "./pay.js";

const uid = (p, now) =>
  `${p}_${Math.round(now).toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;

/* ── config ───────────────────────────────────────────── */
export function defaultConfig() {
  return {
    v: 1,
    updatedAt: 0,
    homeAddress: "",
    places: [],
    kmMemory: {},
    rateSets: [{ ...DEFAULT_RATE_SET }],
    eveningAsked: false,
    // The one user is paid by the fortnight. `confirmed` turns true once they have said (in the
    // app) how often they are paid and which day a pay period starts.
    payPeriod: { days: 14, anchor: "2026-09-21", confirmed: false },
    brands: [],                    // [{ name, flavours: [names], lastUsed }] — remembered so they are typed once
    roundMin: 15,
    avoidTolls: true,
    usualShifts: [],               // [{ start, end }] by position in the day: what was typed last time for the 1st, 2nd … tasting
    setup: { ratesChecked: false, tollsDone: false, hidden: false },   // the first-time guide on Today
    paid: {},                      // what the payslip said: { "<period start>:<7|14>": cents }
    holidaysAdded: [],
    holidaysRemoved: []
  };
}

/** Fills in anything missing. Never drops a field it does not know. */
export function withConfigDefaults(cfg) {
  const d = defaultConfig();
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const out = { ...d, ...c };
  if (!Array.isArray(out.places)) out.places = [];
  if (!out.kmMemory || typeof out.kmMemory !== "object") out.kmMemory = {};
  out.rateSets = Array.isArray(out.rateSets) && out.rateSets.length
    ? out.rateSets.map(r => ({ ...DEFAULT_RATE_SET, ...r }))
    : d.rateSets;
  out.payPeriod = { ...d.payPeriod, ...(c.payPeriod && typeof c.payPeriod === "object" ? c.payPeriod : {}) };
  if (!Array.isArray(out.holidaysAdded)) out.holidaysAdded = [];
  if (!Array.isArray(out.holidaysRemoved)) out.holidaysRemoved = [];
  if (typeof out.avoidTolls !== "boolean") out.avoidTolls = true;
  if (!Array.isArray(out.usualShifts)) out.usualShifts = [];
  out.setup = { ...d.setup, ...(c.setup && typeof c.setup === "object" ? c.setup : {}) };
  if (!out.paid || typeof out.paid !== "object" || Array.isArray(out.paid)) out.paid = {};
  // A config saved before the pay period could be confirmed has no `days` of its own only if it
  // was never saved at all; a stored 7 or 14 always wins over the default.
  if (out.payPeriod.days !== 14) out.payPeriod.days = 7;
  out.payPeriod.confirmed = out.payPeriod.confirmed === true;
  out.brands = Array.isArray(out.brands) ? out.brands.filter(b => b && typeof b.name === "string" && b.name.trim()) : [];
  if (typeof out.roundMin !== "number") out.roundMin = 15;
  return out;
}

export function emptyDay(date) {
  return { v: 1, date, updatedAt: 0, paidAs: null, visits: [], legs: [], parking: [] };
}

export function newPlace(name, now) {
  return { id: uid("p", now), name: String(name || "").trim(), address: "", lastUsed: now, archived: false };
}

/** Sets an address ("home" or a store id) and marks the remembered km that touch it for re-checking. */
export function setAddress(config, placeId, address) {
  const next = String(address || "").trim();
  let prev;
  if (placeId === "home") { prev = config.homeAddress || ""; config.homeAddress = next; }
  else {
    const p = (config.places || []).find(x => x.id === placeId);
    if (!p) return;
    prev = p.address || ""; p.address = next;
  }
  // Also when there was no address before: km remembered for a store with no address was
  // typed without Maps, and the address now typed may be a different branch.
  if (prev !== next) {
    for (const key of Object.keys(config.kmMemory || {})) {
      const [a, b] = key.split(">");
      if (a === placeId || b === placeId) config.kmMemory[key].stale = true;
    }
  }
}

/* ── brands ───────────────────────────────────────────────
   A brand and the flavours it comes in are remembered, so they are typed once and offered
   again the next time that brand is on the table. */
const sameText = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

/** The flavours remembered for a brand name, or null when the brand is not known. */
export function brandFlavours(config, name) {
  const b = ((config && config.brands) || []).find(x => x && sameText(x.name, name));
  return b ? parseFlavours((Array.isArray(b.flavours) ? b.flavours : []).join(",")) : null;
}
/** The spelling a brand is already remembered under — so a brand retyped in a different case
    keeps its first spelling — or the given name, cleaned, when the brand is new. */
export function brandName(config, name) {
  const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const b = ((config && config.brands) || []).find(x => x && sameText(x.name, clean));
  return b ? b.name : clean;
}
/** Remembers (or updates) a brand with its flavours. Newest first, at most 30 are kept.
    A brand retyped in a different case keeps the spelling it was first saved with. */
export function rememberBrand(config, name, flavours, now) {
  const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!clean) return;
  const all = Array.isArray(config.brands) ? config.brands : [];
  const was = all.find(x => x && sameText(x.name, clean));
  const rest = all.filter(x => x && !sameText(x.name, clean));
  config.brands = [{ name: was ? was.name : clean, flavours: parseFlavours((flavours || []).join(",")), lastUsed: now }, ...rest].slice(0, 30);
}

/* ── visits ───────────────────────────────────────────── */
export const isRunning = v => !!v && v.startedAt != null && v.endedAt == null;

function blankVisit(place, now) {
  return {
    id: uid("v", now),
    placeId: place.id, placeName: place.name,
    brand: "",                     // what is on the table (optional); older tastings have no such field
    flavours: [],                  // the flavours or options on the table, in order ([] = just the one product)
    startedAt: null, endedAt: null,
    paidStart: "", paidEnd: "",
    startManual: false, endManual: false,
    breakMin: 0,
    tapT: [], tapK: "", tapF: "",  // the tap log: seconds, kind, flavour (see "taps" below)
    adjS: 0, adjN: 0, adjB: 0,     // hand corrections: samples and sold with no flavour, rejected
    adjF: [], adjBF: [],           // hand corrections for each flavour: samples, sold
    note: "",
    comments: ""                   // what customers said (optional); it goes into the report
  };
}

/** A running tasting. Its paid start is the start time rounded to the step. */
export function newVisit(place, now, roundMin) {
  const v = blankVisit(place, now);
  v.startedAt = now;
  v.paidStart = roundHHMM(hhmmOf(now), roundMin);
  return v;
}

/** A tasting typed in afterwards: never ran, both times set by hand. */
export function manualVisit(place, paidStart, paidEnd, now = Date.now()) {
  const v = blankVisit(place, now);
  v.endedAt = now;
  v.paidStart = paidStart; v.paidEnd = paidEnd;
  v.startManual = true; v.endManual = true;
  return v;
}

/* ── planned tastings ─────────────────────────────────────
   The user's days are two booked shifts at two stores that change every day. A tasting is
   therefore added ahead of time with its store and its shift times typed in, and counting
   starts later from its card. Planned = not started and not finished. */
export const isPlanned = v => !!v && v.startedAt == null && v.endedAt == null;

/** A tasting added ahead of time: the shift times are typed by the user and never guessed. */
export function plannedVisit(place, paidStart, paidEnd, now = Date.now()) {
  const v = blankVisit(place, now);
  v.paidStart = paidStart; v.paidEnd = paidEnd;
  v.startManual = true; v.endManual = true;
  return v;
}
/** Start counting on a tasting that has not been counted on the phone yet. Its typed times are kept. */
export function startVisit(visit, now) {
  if (visit.startedAt == null) { visit.startedAt = now; visit.endedAt = null; }
  // counted from now on by a version that counts sales: its report says "Sold", also when it is 0
  if (typeof visit.adjB !== "number") visit.adjB = 0;
}
/** Stop counting without finishing: the tasting goes back to planned, with nothing counted.
    Hand corrections go too: they were made against taps that no longer exist. */
export function unstartVisit(visit) {
  visit.startedAt = null; visit.endedAt = null;
  visit.tapT = []; visit.tapK = ""; visit.tapF = "";
  visit.adjS = 0; visit.adjN = 0; visit.adjB = 0;
  visit.adjF = flavoursOf(visit).map(() => 0);
  visit.adjBF = flavoursOf(visit).map(() => 0);
}

/** "I started 30 minutes before I tapped": paid start = (start tap − minutes), rounded. */
export function startedEarlier(visit, minutes, roundMin) {
  if (visit.startedAt == null) return;
  visit.paidStart = roundHHMM(addMinutes(hhmmOf(visit.startedAt), -minutes), roundMin);
  visit.startManual = true;
}

/* ── taps ─────────────────────────────────────────────────
   The tap log is three lists of the same length, one entry per tap:
     tapT[i]  seconds since startedAt
     tapK[i]  what was tapped: "S" a sample given, "N" rejected or ignored, "B" one sold.
              Lower case = taken off again: kept in the log, not counted, can be put back.
              "x" = a taken-off tap of a flavour that was removed since: it can never come back.
     tapF[i]  which flavour: "0" … "9" = its place in visit.flavours, "-" = none.
   The log only grows. Tastings counted before flavours existed have no tapF at all, and a
   tapF that is shorter than tapK reads as "-" for the missing end, so old days still add up. */
export const MAX_FLAVOURS = 6;
const KINDS = "SNB";
const isKind = k => typeof k === "string" && k.length === 1 && KINDS.includes(k);
const isUpper = ch => ch === "S" || ch === "N" || ch === "B";
const isOff = ch => ch === "s" || ch === "n" || ch === "b";

/** The flavours of a tasting as a clean list of names ([] when it has none). */
export function flavoursOf(visit) {
  const list = visit && Array.isArray(visit.flavours) ? visit.flavours : [];
  return list.filter(x => typeof x === "string").slice(0, MAX_FLAVOURS);
}
/** The flavour of tap i: its place in the list, or -1 for "no flavour". */
function flavourAt(visit, i, count) {
  const ch = (typeof visit.tapF === "string" ? visit.tapF : "")[i];
  if (!(ch >= "0" && ch <= "9")) return -1;
  const f = Number(ch);
  return f < count ? f : -1;
}
const flavourChar = f => (Number.isInteger(f) && f >= 0 && f <= 9 ? String(f) : "-");
/** tapF, made exactly as long as tapK (missing entries are "no flavour"). */
function alignedF(visit) {
  const k = visit.tapK || "", f = typeof visit.tapF === "string" ? visit.tapF : "";
  return f.length >= k.length ? f.slice(0, k.length) : f + "-".repeat(k.length - f.length);
}

/** One tap. `flavour` is the flavour's place in visit.flavours; leave it out for none.
    A rejection never has a flavour. */
export function addTap(visit, kind, now, flavour = null) {
  if (!isKind(kind)) return;
  if (!Array.isArray(visit.tapT)) visit.tapT = [];
  const base = visit.startedAt == null ? now : visit.startedAt;
  let t = Math.max(0, Math.round((now - base) / 1000));
  const last = visit.tapT.length ? visit.tapT[visit.tapT.length - 1] : 0;
  if (t < last) t = last;
  const f = kind === "N" || !isPlace(flavour, flavoursOf(visit).length) ? -1 : flavour;
  visit.tapF = alignedF(visit) + flavourChar(f);
  visit.tapT.push(t);
  visit.tapK = (visit.tapK || "") + kind;
}

/** Takes tap i out of the log altogether (a touch the phone cancelled: it never happened). */
export function removeTapAt(visit, i) {
  const k = visit.tapK || "";
  if (!(i >= 0 && i < k.length)) return false;
  const f = alignedF(visit);
  visit.tapT.splice(i, 1);
  visit.tapK = k.slice(0, i) + k.slice(i + 1);
  visit.tapF = f.slice(0, i) + f.slice(i + 1);
  settleAdj(visit);
  return true;
}

function lastCountedIndex(visit) {
  const k = visit.tapK || "";
  for (let i = k.length - 1; i >= 0; i--) if (isUpper(k[i])) return i;
  return -1;
}
const setCharAt = (s, i, ch) => s.slice(0, i) + ch + s.slice(i + 1);
const tapAt = (visit, i) => ({
  kind: visit.tapK[i].toUpperCase(), t: visit.tapT[i],
  flavour: flavourAt(visit, i, flavoursOf(visit).length)
});

/** What Undo would remove, without changing anything. */
export function peekUndo(visit) {
  const i = lastCountedIndex(visit);
  return i < 0 ? null : tapAt(visit, i);
}
/** What Put back would restore: the first undone tap after the last counted one. */
/* The first taken-off tap after the last counted one, stepping over "x" taps (they belong to
   a flavour that was removed and can never come back). -1 when there is none. */
function nextOff(visit) {
  const k = visit.tapK || "";
  let i = lastCountedIndex(visit) + 1;
  while (k[i] === "x") i++;
  return i < k.length && isOff(k[i]) ? i : -1;
}
export function peekRedo(visit) {
  const i = nextOff(visit);
  return i < 0 ? null : tapAt(visit, i);
}
export function undoTap(visit) {
  const i = lastCountedIndex(visit);
  if (i < 0) return null;
  const tap = tapAt(visit, i);
  visit.tapK = setCharAt(visit.tapK, i, visit.tapK[i].toLowerCase());
  settleAdj(visit);
  return tap;
}
export function redoTap(visit) {
  const k = visit.tapK || "";
  const i = nextOff(visit);
  if (i < 0) return null;
  visit.tapK = setCharAt(k, i, k[i].toUpperCase());
  return tapAt(visit, i);
}

/** Takes off the newest counted tap of ONE count: a kind ("S", "N" or "B") and, for samples and
    sold, one flavour (-1 or left out = the count with no flavour), wherever it sits in the log.
    → { kind, flavour, t, index }, or null when there is none of that count to take off. */
export function undoKind(visit, kind, flavour = -1) {
  const i = findTap(visit, kind, flavour);
  if (i < 0) return null;
  visit.tapK = setCharAt(visit.tapK, i, kind.toLowerCase());
  settleAdj(visit);
  return { kind, flavour: flavourAt(visit, i, flavoursOf(visit).length), t: visit.tapT[i], index: i };
}
/** The place in the log of the newest counted tap of one count (a kind and a flavour), or -1. */
export function findTap(visit, kind, flavour = -1) {
  if (!isKind(kind)) return -1;
  const k = visit.tapK || "", count = flavoursOf(visit).length;
  if (kind !== "N" && !isNone(flavour) && !isPlace(flavour, count)) return -1;      // no such flavour
  const want = kind === "N" || isNone(flavour) ? -1 : flavour;
  for (let i = k.length - 1; i >= 0; i--) {
    if (k[i] === kind && flavourAt(visit, i, count) === want) return i;
  }
  return -1;
}
/** Puts back the tap at `index` if it is still undone. → { kind, flavour, t, index } or null. */
export function redoAt(visit, index) {
  const k = visit.tapK || "";
  const ch = k[index];
  if (ch !== "s" && ch !== "n" && ch !== "b") return null;
  visit.tapK = setCharAt(k, index, ch.toUpperCase());
  return { kind: ch.toUpperCase(), flavour: flavourAt(visit, index, flavoursOf(visit).length), t: visit.tapT[index], index };
}

const whole = x => Math.round(Number(x) || 0);
const atLeast0 = x => Math.max(0, x);

/** Every number of one tasting.
    sampled   samples given, all flavours together (every sample is one interaction)
    declined  rejected or ignored
    talked    total interactions = sampled + declined
    sold      sold, all flavours together
    plain     the part with no flavour: { sampled, sold, tapS, tapB }
    flav      one entry per flavour, in order: { name, sampled, sold, tapS, tapB }
    tapS, tapN  taps with no flavour (what a typed-over number is measured against) */
export function counts(visit) {
  const names = flavoursOf(visit);
  const k = visit.tapK || "";
  const flav = names.map(name => ({ name, sampled: 0, sold: 0, tapS: 0, tapB: 0 }));
  const plain = { sampled: 0, sold: 0, tapS: 0, tapB: 0 };
  let n = 0;
  for (let i = 0; i < k.length; i++) {
    const ch = k[i];
    if (ch === "N") { n++; continue; }
    if (ch !== "S" && ch !== "B") continue;
    const f = flavourAt(visit, i, names.length);
    const slot = f < 0 ? plain : flav[f];
    if (ch === "S") slot.tapS++; else slot.tapB++;
  }
  const adjF = Array.isArray(visit.adjF) ? visit.adjF : [];
  const adjBF = Array.isArray(visit.adjBF) ? visit.adjBF : [];
  plain.sampled = atLeast0(plain.tapS + whole(visit.adjS));
  plain.sold = atLeast0(plain.tapB + whole(visit.adjB));
  let sampled = plain.sampled, sold = plain.sold;
  flav.forEach((x, i) => {
    x.sampled = atLeast0(x.tapS + whole(adjF[i]));
    x.sold = atLeast0(x.tapB + whole(adjBF[i]));
    sampled += x.sampled; sold += x.sold;
  });
  const declined = atLeast0(n + whole(visit.adjN));
  return { sampled, declined, talked: sampled + declined, sold, plain, flav, tapS: plain.tapS, tapN: n };
}

/* ── hand corrections ─────────────────────────────────────
   A number typed over a count is kept as a correction beside the tap log, never by rewriting
   the log. `flavour` -1 = the count with no flavour. */

/* After taps leave the log, a correction may take away more than is left. It is cut back to
   exactly "what is left", so the count reads 0 and the next tap shows as 1 — a tap always
   raises its count by one. Fields a tasting does not have are never created here. */
function settleAdj(visit) {
  const n = counts(visit);
  if (whole(visit.adjS) < -n.plain.tapS) visit.adjS = -n.plain.tapS;
  if (whole(visit.adjB) < -n.plain.tapB) visit.adjB = -n.plain.tapB;
  if (whole(visit.adjN) < -n.tapN) visit.adjN = -n.tapN;
  n.flav.forEach((x, i) => {
    if (Array.isArray(visit.adjF) && whole(visit.adjF[i]) < -x.tapS) visit.adjF[i] = -x.tapS;
    if (Array.isArray(visit.adjBF) && whole(visit.adjBF[i]) < -x.tapB) visit.adjBF[i] = -x.tapB;
  });
}
function adjList(visit, key) {
  const len = flavoursOf(visit).length;
  const list = Array.isArray(visit[key]) ? visit[key].slice(0, len).map(whole) : [];
  while (list.length < len) list.push(0);
  visit[key] = list;
  return list;
}
/** The number one count shows now. kind "S" | "N" | "B". */
/* Which count is meant: -1, null or nothing = the count with no flavour; a place in the list =
   that flavour; anything else (a flavour that is not there) = no count at all, so a stale
   button can never change the wrong number. */
const isPlace = (flavour, count) => Number.isInteger(flavour) && flavour >= 0 && flavour < count;
const isNone = flavour => flavour == null || flavour === -1;
export function countOf(visit, kind, flavour = -1) {
  const n = counts(visit);
  if (kind === "N") return n.declined;
  const slot = isNone(flavour) ? n.plain : isPlace(flavour, n.flav.length) ? n.flav[flavour] : null;
  if (!slot) return 0;
  return kind === "B" ? slot.sold : slot.sampled;
}
/** Sets one count to a number (0 or more). */
export function setCount(visit, kind, flavour, value) {
  const v = Math.max(0, whole(value));
  const n = counts(visit);
  if (kind === "N") { visit.adjN = v - n.tapN; return; }
  if (isPlace(flavour, n.flav.length)) {
    if (kind === "S") adjList(visit, "adjF")[flavour] = v - n.flav[flavour].tapS;
    else if (kind === "B") adjList(visit, "adjBF")[flavour] = v - n.flav[flavour].tapB;
    return;
  }
  if (!isNone(flavour)) return;                    // a flavour that is not in the list: nothing to set
  if (kind === "S") visit.adjS = v - n.plain.tapS;
  else if (kind === "B") {
    const adj = v - n.plain.tapB;
    // "0 sold" set on a tasting from before sales were counted changes nothing: it must not
    // start printing "Sold: 0" for a day on which sales were simply not counted
    if (adj === 0 && typeof visit.adjB !== "number") return;
    visit.adjB = adj;
  }
}
/** Moves one count up or down by `delta`, never below 0. */
export function bumpCount(visit, kind, flavour, delta) {
  setCount(visit, kind, flavour, countOf(visit, kind, flavour) + whole(delta));
}

/* ── flavours ─────────────────────────────────────────────
   The flavours (or options) of the product on the table. Taps point at a flavour by its place
   in the list, so a flavour is only ever added at the end, renamed, or removed while it has
   nothing counted. */
export function cleanFlavourName(name) {
  // commas, semicolons and line breaks separate names in a typed list, so a name cannot hold one
  return String(name == null ? "" : name).replace(/[,;\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 24);
}
/** "Lime, Mango" → ["Lime", "Mango"]: split on commas or new lines, no empties, no repeats. */
export function parseFlavours(text) {
  const out = [];
  for (const part of String(text == null ? "" : text).split(/[,\n;]+/)) {
    const name = cleanFlavourName(part);
    if (name && !out.some(x => x.toLowerCase() === name.toLowerCase())) out.push(name);
    if (out.length >= MAX_FLAVOURS) break;
  }
  return out;
}
/** Sets the whole list on a tasting that has nothing counted for any flavour yet. */
export function setFlavours(visit, names) {
  visit.flavours = [];
  settleMarks(visit);                              // nothing may point at the old list any more
  visit.flavours = parseFlavours((names || []).join(","));
  visit.adjF = visit.flavours.map(() => 0);
  visit.adjBF = visit.flavours.map(() => 0);
}
/** Marks that point at a flavour which is not in the list (a damaged file, another device)
    read as "no flavour". This writes that down, and gives rejections no flavour at all. */
function settleMarks(visit) {
  if (typeof visit.tapF !== "string" || !visit.tapF) return;
  const count = flavoursOf(visit).length, k = visit.tapK || "", f = alignedF(visit);
  let out = "";
  for (let i = 0; i < f.length; i++) {
    const kind = (k[i] || "").toUpperCase();
    out += kind !== "N" && f[i] >= "0" && f[i] <= "9" && Number(f[i]) < count ? f[i] : "-";
  }
  visit.tapF = out;
}
/** → its place in the list, or -1 (empty name, already there, or the list is full). */
export function addFlavour(visit, name) {
  const clean = cleanFlavourName(name), list = flavoursOf(visit);
  if (!clean || list.length >= MAX_FLAVOURS) return -1;
  if (list.some(x => x.toLowerCase() === clean.toLowerCase())) return -1;
  settleMarks(visit);
  visit.flavours = [...list, clean];
  adjList(visit, "adjF");
  adjList(visit, "adjBF");
  return visit.flavours.length - 1;
}
export function renameFlavour(visit, index, name) {
  const clean = cleanFlavourName(name), list = flavoursOf(visit);
  if (!clean || !(index >= 0 && index < list.length)) return false;
  if (list.some((x, i) => i !== index && x.toLowerCase() === clean.toLowerCase())) return false;
  list[index] = clean;
  visit.flavours = list;
  return true;
}
/** True when nothing is counted for that flavour (so it can be removed). */
export function flavourIsEmpty(visit, index) {
  const x = counts(visit).flav[index];
  return !!x && x.sampled === 0 && x.sold === 0;
}
/** Removes a flavour that has nothing counted. Later flavours move up one place, and so do
    their taps. Taps of the removed flavour that were taken off stay in the log with no flavour. */
export function removeFlavour(visit, index) {
  const list = flavoursOf(visit);
  if (!(index >= 0 && index < list.length) || !flavourIsEmpty(visit, index)) return false;
  settleMarks(visit);
  const f = alignedF(visit);
  let out = "";
  for (const ch of f) {
    if (!(ch >= "0" && ch <= "9")) { out += ch; continue; }
    const n = Number(ch);
    out += n === index ? "-" : n > index ? String(n - 1) : ch;
  }
  // The removed flavour has nothing counted, so any tap of it is one that was taken off (or
  // one a hand correction cancelled). It is marked "x": it can never be put back, because it
  // would come back as a count with no flavour. (settleMarks has made sure no rejection
  // carries a flavour mark, so rejections are never touched here.)
  const k = visit.tapK || "";
  let kOut = "";
  for (let i = 0; i < k.length; i++) kOut += f[i] === String(index) ? "x" : k[i];
  visit.tapK = kOut;
  visit.tapF = out;
  const adjF = adjList(visit, "adjF"), adjBF = adjList(visit, "adjBF");
  adjF.splice(index, 1); adjBF.splice(index, 1);
  list.splice(index, 1);
  visit.flavours = list;
  visit.adjF = adjF; visit.adjBF = adjBF;
  return true;
}

/** The instant of the last counted tap, or null. */
export function lastTapMs(visit) {
  const i = lastCountedIndex(visit);
  if (i < 0 || visit.startedAt == null) return null;
  return visit.startedAt + visit.tapT[i] * 1000;
}

/** The paid finish to suggest: the last count if it was more than 20 minutes ago, else now. Always after the start. */
export function suggestPaidEnd(visit, now, roundMin) {
  const last = lastTapMs(visit);
  let from = "now", ms = now;
  if (last != null && now - last > 20 * 60000) { from = "lastCount"; ms = last; }
  let paidEnd = roundHHMM(hhmmOf(ms), roundMin);
  const s = toMin(visit.paidStart);
  const e = toMin(paidEnd);
  if (s != null && (e == null || e <= s)) paidEnd = fromMin(s + (roundMin || 1));
  return { paidEnd, from };
}

/* Counted taps at the very end that follow a long gap — the pattern of a phone tapping in a
   pocket. Only a handful is ever reported; a long run after a quiet spell is real counting. */
function lateStart(visit, gapMin) {
  const k = visit.tapK || "";
  const idx = [];
  // Sold taps are left out: bottles sold are often tapped in together at the end of a shift,
  // long after the last sample, and that is real work, not a phone in a pocket.
  for (let i = 0; i < k.length; i++) if (k[i] === "S" || k[i] === "N") idx.push(i);
  for (let j = idx.length - 1; j >= 1; j--) {
    if (visit.tapT[idx[j]] - visit.tapT[idx[j - 1]] >= gapMin * 60) {
      const n = idx.length - j;
      return n <= 5 ? { from: idx[j], n, gapSec: visit.tapT[idx[j]] - visit.tapT[idx[j - 1]] } : null;
    }
  }
  return null;
}
export function lateTaps(visit, gapMin = 20) {
  const l = lateStart(visit, gapMin);
  return l ? l.n : 0;
}
export function lateTapInfo(visit, gapMin = 20) {
  const l = lateStart(visit, gapMin);
  if (!l) return null;
  return { n: l.n, gapMin: Math.round(l.gapSec / 60), firstMs: visit.startedAt + visit.tapT[l.from] * 1000 };
}
export function dropLateTaps(visit, gapMin = 20) {
  const l = lateStart(visit, gapMin);
  if (!l) return 0;
  // Only the late samples and rejections go. Bottles sold in the same stretch (and any dead
  // marks) are real work — they are kept, so "Remove them" never quietly drops a sale.
  const f = alignedF(visit), k = visit.tapK || "", keep = [];
  for (let i = 0; i < k.length; i++) if (i < l.from || !/[SNsn]/.test(k[i])) keep.push(i);
  visit.tapT = keep.map(i => visit.tapT[i]);
  visit.tapK = keep.map(i => k[i]).join("");
  visit.tapF = keep.map(i => f[i]).join("");
  settleAdj(visit);
  return l.n;
}

/** Ends a tasting. Fills the paid finish only if it is empty and was not set by hand. */
export function finishVisit(visit, now, roundMin) {
  if (!visit.paidEnd && !visit.endManual) visit.paidEnd = suggestPaidEnd(visit, now, roundMin).paidEnd;
  visit.endedAt = now;
}
/** "Count more": the tasting runs again; its paid times are kept. */
export function reopenVisit(visit) {
  if (visit.startedAt != null) visit.endedAt = null;
  if (typeof visit.adjB !== "number") visit.adjB = 0;      // see startVisit
}

/** Paid minutes of the most recent finished tasting at that store, or null. */
export function lastLengthAt(days, placeId) {
  let best = null;
  for (const d of days || []) {
    for (const v of d.visits || []) {
      if (v.placeId !== placeId || v.endedAt == null) continue;
      const len = minutesBetween(v.paidStart, v.paidEnd);
      if (!len) continue;
      const key = `${d.date} ${v.paidStart}`;
      if (!best || key > best.key) best = { key, len };
    }
  }
  return best ? best.len : null;
}

/* ── trips ────────────────────────────────────────────────
   Legs are derived from the day's tastings: home → first store → … → last store → home.
   Every leg is counted. One with no km is flagged, never silently left out. */
function currentName(config, v) {
  const p = ((config && config.places) || []).find(x => x.id === v.placeId);
  return (p && p.name) || v.placeName || "Store";
}

export function rebuildLegs(day, config) {
  const visits = (day.visits || []).slice().sort((a, b) => {
    const x = toMin(a.paidStart), y = toMin(b.paidStart);
    return (x == null ? 1e9 : x) - (y == null ? 1e9 : y) || (a.startedAt || 0) - (b.startedAt || 0);
  });
  const stops = [];
  for (const v of visits) {
    if (!stops.length || stops[stops.length - 1].id !== v.placeId) stops.push({ id: v.placeId, name: currentName(config, v) });
  }
  const old = new Map();
  for (const l of day.legs || []) {
    const k = `${l.from}>${l.to}`;
    if (!old.has(k)) old.set(k, l);
  }
  const legs = [];
  if (stops.length) {
    const chain = [{ id: "home", name: "Home" }, ...stops, { id: "home", name: "Home" }];
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i], b = chain[i + 1];
      const key = `${a.id}>${b.id}`;
      const prev = old.get(key);
      const mem = config && config.kmMemory && config.kmMemory[key];
      const leg = {
        from: a.id, to: b.id, fromName: a.name, toName: b.name,
        tenths: null, checkedOn: null, checkedTime: null, via: "", skip: false
      };
      if (prev) {
        leg.tenths = typeof prev.tenths === "number" ? prev.tenths : null;
        leg.checkedOn = prev.checkedOn || null;
        leg.checkedTime = prev.checkedTime || null;
        leg.via = prev.via || "";
        leg.skip = !!prev.skip;
      }
      if (leg.tenths == null && mem && !mem.stale && typeof mem.tenths === "number") {
        leg.tenths = mem.tenths;
        leg.checkedOn = mem.checkedOn || null;
        leg.checkedTime = mem.checkedTime || null;
        leg.via = mem.via || "";
      }
      legs.push(leg);
    }
  }
  day.legs = legs;
  // A whole-day km figure belongs to one route. A different route (a store added, removed or
  // moved in the day) needs measuring again.
  if (day.kmDay != null && day.kmDayFor !== routeKey(day)) clearDayKm(day);
  return day;
}

/* ── km for the whole day in one figure ───────────────────
   Instead of one figure per trip, the whole route (home → each store → home) can be opened as
   ONE Google Maps route and its total typed once. While `kmDay` is set it is the day's km and
   the per-trip figures are ignored. It is tied to the route it was measured on (`kmDayFor`). */
export function routeKey(day) {
  const legs = (day && day.legs) || [];
  return legs.length ? legs.map(l => l.from).concat(legs[legs.length - 1].to).join(">") : "";
}
function clearDayKm(day) {
  day.kmDay = null; day.kmDayOn = null; day.kmDayTime = null; day.kmDayFor = null;
}
/** tenths = null removes the whole-day figure (the per-trip figures count again). */
export function setDayKm(day, tenths, { date = null, time = null } = {}) {
  if (typeof tenths !== "number" || !(day.legs || []).length) { clearDayKm(day); return; }
  day.kmDay = tenths; day.kmDayOn = date; day.kmDayTime = time; day.kmDayFor = routeKey(day);
}
export const hasDayKm = day => !!day && typeof day.kmDay === "number";

/** remember=false changes this day only. */
export function setLegKm(day, config, index, tenths, { date = null, time = null, remember = true } = {}) {
  const leg = day.legs && day.legs[index];
  if (!leg) return;
  const apply = l => { l.tenths = tenths; l.checkedOn = date; l.checkedTime = time; };
  apply(leg);
  for (const l of day.legs) {
    if (l !== leg && l.from === leg.from && l.to === leg.to && typeof l.tenths !== "number") apply(l);
  }
  if (remember && config) {
    if (!config.kmMemory || typeof config.kmMemory !== "object") config.kmMemory = {};
    config.kmMemory[`${leg.from}>${leg.to}`] = {
      tenths, checkedOn: date, checkedTime: time, via: leg.via || "", stale: false
    };
  }
}

export function setLegSkip(day, index, skip) {
  const leg = day.legs && day.legs[index];
  if (!leg) return;
  leg.skip = !!skip;
  // The whole-day figure was for the whole route; with a trip not driven it no longer fits.
  if (day.kmDay != null) clearDayKm(day);
}

/** Opens Google Maps on exactly one leg. Toll-free by default: tolls are not reimbursed. */
export function mapsUrl(fromAddress, toAddress, avoidTolls = true) {
  const a = String(fromAddress || "").trim(), b = String(toAddress || "").trim();
  if (!a || !b) return null;
  return "https://www.google.com/maps/dir/?api=1"
    + `&origin=${encodeURIComponent(a)}&destination=${encodeURIComponent(b)}`
    + "&travelmode=driving" + (avoidTolls ? "&avoid=tolls" : "");
}

/** Opens Google Maps on the whole day as ONE route: the first address, every stop in order,
    the last address. null unless there are at least three addresses and none is empty. */
export function mapsDayUrl(addresses, avoidTolls = true) {
  const list = (addresses || []).map(a => String(a || "").replace(/\|/g, " ").trim());
  if (list.length < 3 || list.some(a => !a)) return null;
  return "https://www.google.com/maps/dir/?api=1"
    + `&origin=${encodeURIComponent(list[0])}&destination=${encodeURIComponent(list[list.length - 1])}`
    + `&waypoints=${encodeURIComponent(list.slice(1, -1).join("|"))}`
    + "&travelmode=driving" + (avoidTolls ? "&avoid=tolls" : "");
}

/* ── report text ──────────────────────────────────────── */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dateText(iso, withYear = true) {
  const d = parseISO(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? " " + d.getFullYear() : ""}`;
}
export function time12(hhmm) {
  const m = toMin(hhmm);
  if (m == null) return "";
  const h = Math.floor(m / 60), mm = m % 60;
  return `${h % 12 || 12}:${String(mm).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** Does this tasting count sales? Tastings from before version 6 do not, and a report must
    never print "Sold: 0" for a day on which sales were simply not counted. */
export const tracksSold = v => !!v && (typeof v.adjB === "number" || /[Bb]/.test(v.tapK || "") || counts(v).sold > 0);

/** The numbers of one tasting as report lines, the same in every report: total interactions,
    samples (and each flavour), rejected, sold (and each flavour), what customers said. */
export function countLines(visit) {
  const n = counts(visit);
  const out = [`Total interactions: ${n.talked}`, `Samples given: ${n.sampled}`];
  if (n.flav.length) {
    for (const f of n.flav) out.push(`  ${f.name}: ${f.sampled}`);
    if (n.plain.sampled) out.push(`  No flavour: ${n.plain.sampled}`);
  }
  out.push(`Rejected or ignored: ${n.declined}`);
  if (tracksSold(visit)) {
    out.push(`Sold: ${n.sold}`);
    if (n.flav.length) {
      for (const f of n.flav) out.push(`  ${f.name}: ${f.sold}`);
      if (n.plain.sold) out.push(`  No flavour: ${n.plain.sold}`);
    }
  }
  const said = typeof visit.comments === "string" ? visit.comments.replace(/\s+/g, " ").trim() : "";
  if (said) out.push(`Customer comments: ${said}`);
  return out;
}

export function reportText(day, visit) {
  const time = visit.paidStart && visit.paidEnd
    ? `${time12(visit.paidStart)} – ${time12(visit.paidEnd)}`
    : time12(visit.paidStart);
  const brand = typeof visit.brand === "string" ? visit.brand.trim() : "";
  return [
    `Tasting report — ${dateText(day.date)}`,
    `Store: ${visit.placeName}`,
    ...(brand ? [`Brand: ${brand}`] : []),
    `Time: ${time}`,
    ...countLines(visit)
  ].join("\n");
}

/** The clock hour with the most interactions, from the tap times: { hour (0–23), count }.
    null until at least 10 taps were made over more than one hour (before that it says nothing). */
export function busiestHour(visit) {
  const k = visit.tapK || "";
  if (visit.startedAt == null || !Array.isArray(visit.tapT)) return null;
  const perHour = new Map();
  let total = 0;
  for (let i = 0; i < k.length; i++) {
    if (k[i] !== "S" && k[i] !== "N") continue;
    const hour = new Date(visit.startedAt + (visit.tapT[i] || 0) * 1000).getHours();
    perHour.set(hour, (perHour.get(hour) || 0) + 1);
    total++;
  }
  if (total < 10 || perHour.size < 2) return null;
  let best = null;
  for (const [hour, count] of perHour) {
    if (!best || count > best.count || (count === best.count && hour < best.hour)) best = { hour, count };
  }
  return best;
}

/* ── restoring from a backup file ─────────────────────────
   A backup is read back one day at a time, and only days this phone does not have are added.
   Anything that is not shaped like a day is refused, so a damaged file cannot break the app. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = x => !!x && typeof x === "object" && !Array.isArray(x);

/** → a safe copy of one day from a backup file, or null when it is not a usable day. */
export function cleanBackupDay(raw) {
  if (!isObj(raw) || typeof raw.date !== "string" || !ISO_DATE.test(raw.date)) return null;
  if (todayISO(parseISO(raw.date)) !== raw.date) return null;       // not a real calendar date
  let d;
  try { d = JSON.parse(JSON.stringify(raw)); } catch (e) { return null; }
  if (d.visits != null && !Array.isArray(d.visits)) return null;
  if (d.legs != null && !Array.isArray(d.legs)) return null;
  if (d.parking != null && !Array.isArray(d.parking)) return null;

  const visits = [];
  for (const v of d.visits || []) {
    if (!isObj(v) || typeof v.id !== "string" || !v.id) return null;
    visits.push({
      ...v,
      placeId: typeof v.placeId === "string" ? v.placeId : "p_unknown",
      placeName: typeof v.placeName === "string" ? v.placeName : "Store",
      startedAt: typeof v.startedAt === "number" ? v.startedAt : null,
      // A tasting cannot come back still running: counting could never be finished properly.
      endedAt: typeof v.endedAt === "number" ? v.endedAt : (typeof v.startedAt === "number" ? v.startedAt : null),
      paidStart: typeof v.paidStart === "string" ? v.paidStart : "",
      paidEnd: typeof v.paidEnd === "string" ? v.paidEnd : "",
      breakMin: typeof v.breakMin === "number" ? v.breakMin : 0,
      tapT: Array.isArray(v.tapT) ? v.tapT.filter(t => typeof t === "number") : [],
      tapK: typeof v.tapK === "string" ? v.tapK : "",
      adjS: typeof v.adjS === "number" ? v.adjS : 0,
      adjN: typeof v.adjN === "number" ? v.adjN : 0,
      note: typeof v.note === "string" ? v.note : ""
    });
    const last = visits[visits.length - 1];
    if (last.tapT.length !== last.tapK.length) { last.tapT = []; last.tapK = ""; last.tapF = ""; }
    // version 6 fields: flavours, the flavour of each tap, corrections per flavour, comments
    // every place in the list is kept (an empty or damaged name gets a stand-in), because the
    // taps point at a flavour by its place
    const names = [];
    for (const x of Array.isArray(v.flavours) ? v.flavours : []) {
      if (names.length >= MAX_FLAVOURS) break;
      let name = cleanFlavourName(typeof x === "string" ? x : "") || `Flavour ${names.length + 1}`;
      while (names.some(n => n.toLowerCase() === name.toLowerCase())) name = (name.slice(0, 20) + " " + (names.length + 1)).trim();
      names.push(name);
    }
    const numbers = list => names.map((_, i) => (Array.isArray(list) && typeof list[i] === "number" ? Math.round(list[i]) : 0));
    last.flavours = names;
    last.tapF = typeof v.tapF === "string" ? v.tapF.replace(/[^0-9-]/g, "-") : "";
    last.tapF = alignedF(last);
    settleMarks(last);
    last.adjF = numbers(v.adjF);
    last.adjBF = numbers(v.adjBF);
    if (v.adjB != null && typeof v.adjB !== "number") last.adjB = 0;
    if (v.comments != null && typeof v.comments !== "string") last.comments = "";
    settleAdj(last);
  }
  const legs = [];
  for (const l of d.legs || []) {
    if (!isObj(l) || typeof l.from !== "string" || typeof l.to !== "string") return null;
    legs.push({
      ...l,
      fromName: typeof l.fromName === "string" ? l.fromName : "",
      toName: typeof l.toName === "string" ? l.toName : "",
      tenths: typeof l.tenths === "number" ? l.tenths : null,
      skip: !!l.skip
    });
  }
  const parking = [];
  for (const p of d.parking || []) {
    if (!isObj(p) || typeof p.cents !== "number") continue;
    parking.push({ ...p, id: typeof p.id === "string" && p.id ? p.id : "k_" + parking.length, note: typeof p.note === "string" ? p.note : "" });
  }
  const out = { ...d, v: 1, visits, legs, parking, paidAs: typeof d.paidAs === "string" ? d.paidAs : null };
  if (typeof out.kmDay !== "number") { out.kmDay = null; out.kmDayFor = null; }
  return out;
}

/** True when the phone already holds something for that day (a backup never replaces it). */
export function dayHasContent(day) {
  return !!day && ((day.visits || []).length + (day.legs || []).length + (day.parking || []).length) > 0;
}

/* ── typed numbers ────────────────────────────────────────
   Read from the characters, never by multiplying floats (19.4 * 100 is 1939.9999999999998). */

/** "12.4" | "12,4" | "12" → tenths of a km (124 / 124 / 120). null if it is not a number. */
export function parseKm(text) {
  const s = String(text == null ? "" : text).trim().replace(/\s*km$/i, "").replace(",", ".");
  const m = /^(\d{0,4})(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  const frac = m[2] || "";
  const tenths = Number(m[1] || 0) * 10 + Number(frac[0] || 0) + (Number(frac[1] || 0) >= 5 ? 1 : 0);
  return tenths > 9999 ? null : tenths;
}

/** "6.5" | "$6.50" | "6" → cents (650 / 650 / 600). null if it is not a number. */
export function parseMoney(text) {
  let s = String(text == null ? "" : text).trim().replace(/^\$/, "").replace(/\s/g, "");
  // "1,234" and "12,345,678" are thousands; "6,50" is six dollars fifty.
  if (s.includes(".") || /^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const m = /^(\d{0,6})(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  const frac = m[2] || "";
  return Number(m[1] || 0) * 100 + Number(frac[0] || 0) * 10 + Number(frac[1] || 0) + (Number(frac[2] || 0) >= 5 ? 1 : 0);
}
