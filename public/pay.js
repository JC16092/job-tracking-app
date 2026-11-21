/* ══════════════════════════════════════════════════════════
   Tastings — pay engine and local-date helpers.
   Pure: no DOM, no storage, no Firebase.
   Money is whole cents, time whole minutes, km whole tenths,
   dates are local calendar dates "YYYY-MM-DD" (never UTC).
   ══════════════════════════════════════════════════════════ */

export const DEFAULT_RATE_SET = {
  from: "2026-07-01",
  weekday: 3476, evening: null, eveningFrom: "18:00",
  saturday: 4172, sunday: 4867, holiday: 6953,
  km: 100
};

const pad = n => String(n).padStart(2, "0");

/* ── dates ────────────────────────────────────────────── */
export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function parseISO(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s, n) {
  const d = parseISO(s);
  d.setDate(d.getDate() + n);
  return todayISO(d);
}
/** 0 = Sunday … 6 = Saturday */
export function weekdayOf(s) { return parseISO(s).getDay(); }
export function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 864e5); }

/* ── times of day ─────────────────────────────────────── */
export function toMin(hhmm) {
  if (typeof hhmm !== "string" || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}
export function fromMin(min) {
  const v = Math.min(1439, Math.max(0, Math.round(min)));
  return `${pad(Math.floor(v / 60))}:${pad(v % 60)}`;
}
/** Minutes from start to end. 0 if either is missing or end <= start. Never wraps past midnight. */
export function minutesBetween(start, end) {
  const a = toMin(start), b = toMin(end);
  if (a == null || b == null || b <= a) return 0;
  return b - a;
}
/** Clamped to 00:00–23:59. */
export function addMinutes(hhmm, n) {
  const a = toMin(hhmm);
  return a == null ? "" : fromMin(a + n);
}
export function roundHHMM(hhmm, stepMin) {
  const a = toMin(hhmm);
  if (a == null) return "";
  if (!stepMin) return fromMin(a);
  return fromMin(Math.round(a / stepMin) * stepMin);
}
export function hhmmOf(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ── rates ────────────────────────────────────────────── */
/** Latest set whose `from` is on or before the date, else the earliest set. */
export function rateSetFor(date, rateSets) {
  const sets = (Array.isArray(rateSets) && rateSets.length ? rateSets : [DEFAULT_RATE_SET])
    .slice().sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  let pick = sets[0];
  for (const s of sets) if (s.from <= date) pick = s;
  return pick;
}

const KINDS = ["weekday", "saturday", "sunday", "holiday"];

/** "weekday" | "saturday" | "sunday" | "holiday". `holidays` is a Map (or Set) keyed by date. */
export function dayKind(date, holidays, paidAs) {
  if (KINDS.includes(paidAs)) return paidAs;
  if (holidays && typeof holidays.has === "function" && holidays.has(date)) return "holiday";
  const wd = weekdayOf(date);
  return wd === 0 ? "sunday" : wd === 6 ? "saturday" : "weekday";
}

/** Round half up, in whole numbers, once per line — the way a payslip does. */
function centsFor(minutes, rate) { return Math.floor((minutes * rate + 30) / 60); }

/* The paid pieces of one visit before they are grouped: [{ kind, minutes, rate }]. */
function segments(visit, date, config, holidays, paidAs) {
  const start = toMin(visit.paidStart), end = toMin(visit.paidEnd);
  if (start == null || end == null || end <= start) return [];
  const rs = rateSetFor(date, config && config.rateSets);
  const kind = dayKind(date, holidays, paidAs);
  let brk = Math.max(0, Math.round(visit.breakMin || 0));

  if (kind !== "weekday" || typeof rs.evening !== "number") {
    const minutes = Math.max(0, end - start - brk);
    return minutes ? [{ kind, minutes, rate: rs[kind] }] : [];
  }
  // Weekday with an evening rate: split at eveningFrom. A break comes off the daytime part first.
  const cutRaw = toMin(rs.eveningFrom || "18:00");
  const cut = cutRaw == null ? 1080 : cutRaw;
  let dayMin = Math.max(0, Math.min(end, cut) - start);
  let eveMin = Math.max(0, end - Math.max(start, cut));
  const off = Math.min(dayMin, brk);
  dayMin -= off; brk -= off;
  eveMin = Math.max(0, eveMin - brk);
  const out = [];
  if (dayMin) out.push({ kind: "weekday", minutes: dayMin, rate: rs.weekday });
  if (eveMin) out.push({ kind: "evening", minutes: eveMin, rate: rs.evening });
  return out;
}

const ORDER = ["weekday", "evening", "saturday", "sunday", "holiday"];

/* Group by kind and rate, add the minutes, then work out the cents once per line. */
function mergeLines(segs) {
  const map = new Map();
  for (const s of segs) {
    const k = s.kind + "@" + s.rate;
    const cur = map.get(k);
    if (cur) cur.minutes += s.minutes;
    else map.set(k, { kind: s.kind, minutes: s.minutes, rate: s.rate });
  }
  const out = [...map.values()].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.rate - b.rate);
  for (const l of out) l.cents = centsFor(l.minutes, l.rate);
  return out;
}

/** → [{ kind, minutes, rate, cents }]; [] if there is no paid time yet. */
export function visitLines(visit, date, config, holidays, paidAs) {
  return mergeLines(segments(visit, date, config, holidays, paidAs));
}

const isRunning = v => v.startedAt != null && v.endedAt == null;

/** → subset of ["noEnd", "endBeforeStart", "tooLong", "overlap"]. A visit with a problem pays nothing until it is fixed. */
export function visitProblems(day, visit) {
  const out = [];
  const s = toMin(visit.paidStart), e = toMin(visit.paidEnd);
  if (e == null) {
    if (!isRunning(visit)) out.push("noEnd");
    return out;
  }
  if (s == null || e <= s) { out.push("endBeforeStart"); return out; }
  if (e - s > 600) out.push("tooLong");
  for (const o of (day && day.visits) || []) {
    if (o === visit || o.id === visit.id) continue;
    const os = toMin(o.paidStart), oe = toMin(o.paidEnd);
    if (os == null || oe == null || oe <= os) continue;
    if (s < oe && os < e) { out.push("overlap"); break; }
  }
  return out;
}

function daySegments(day, config, holidays) {
  const segs = [];
  for (const v of day.visits || []) {
    if (visitProblems(day, v).length) continue;
    segs.push(...segments(v, day.date, config, holidays, day.paidAs));
  }
  return segs;
}

function sum(list, key) { return list.reduce((a, x) => a + x[key], 0); }

export function dayTotals(day, config, holidays) {
  const problems = [];
  let running = false;
  for (const v of day.visits || []) {
    if (isRunning(v)) running = true;
    for (const p of visitProblems(day, v)) if (!problems.includes(p)) problems.push(p);
  }
  const lines = mergeLines(daySegments(day, config, holidays));
  const rs = rateSetFor(day.date, config && config.rateSets);

  // Km: either one figure typed for the whole day (it then stands for every trip), or the trips added up.
  const kmWhole = typeof day.kmDay === "number";
  let kmTenths = 0, missingKm = 0;
  if (kmWhole) kmTenths = Math.max(0, Math.round(day.kmDay));
  else {
    for (const l of day.legs || []) {
      if (l.skip) continue;
      if (typeof l.tenths !== "number") missingKm++;
      else kmTenths += l.tenths;
    }
  }
  const kmCents = Math.round(kmTenths * rs.km / 10);

  let parkingCents = 0;
  for (const p of day.parking || []) parkingCents += Math.max(0, Math.round(p.cents || 0));

  const hoursMin = sum(lines, "minutes"), hoursCents = sum(lines, "cents");
  return {
    lines, hoursMin, hoursCents,
    kmTenths, kmCents, kmRate: rs.km, kmWhole,
    parkingCents,
    totalCents: hoursCents + kmCents + parkingCents,
    missingKm, running, problems
  };
}

/** The pay period that contains `date`: { start, end }, both inclusive. */
export function periodOf(date, payPeriod) {
  const days = payPeriod && payPeriod.days === 14 ? 14 : 7;
  const anchor = (payPeriod && payPeriod.anchor) || "2026-09-21";
  const n = Math.floor(daysBetween(anchor, date) / days);
  const start = addDays(anchor, n * days);
  return { start, end: addDays(start, days - 1) };
}

/* The period groups minutes per rate across all its days and multiplies once per line,
   so the sum of the days can differ from the period by a cent. Never show a sum of days. */
export function periodTotals(days, config, holidays, start, end) {
  const inRange = (days || []).filter(d => d && d.date >= start && d.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const segs = [];
  const kmByRate = new Map();
  let parkingCents = 0, missingKm = 0, running = false;
  const problems = [], list = [];

  for (const day of inRange) {
    const t = dayTotals(day, config, holidays);
    segs.push(...daySegments(day, config, holidays));
    kmByRate.set(t.kmRate, (kmByRate.get(t.kmRate) || 0) + t.kmTenths);
    parkingCents += t.parkingCents;
    missingKm += t.missingKm;
    running = running || t.running;
    for (const p of t.problems) if (!problems.includes(p)) problems.push(p);
    const has = (day.visits || []).length || (day.parking || []).length || (day.legs || []).length;
    if (has) list.push({
      date: day.date, hoursMin: t.hoursMin, kmTenths: t.kmTenths, totalCents: t.totalCents,
      missingKm: t.missingKm, running: t.running, problems: t.problems
    });
  }

  const lines = mergeLines(segs);
  let kmTenths = 0, kmCents = 0;
  const kmLines = [];
  for (const [rate, tenths] of kmByRate) {
    if (!tenths) continue;
    const cents = Math.round(tenths * rate / 10);
    kmTenths += tenths; kmCents += cents;
    kmLines.push({ rate, tenths, cents });
  }
  const hoursMin = sum(lines, "minutes"), hoursCents = sum(lines, "cents");
  return {
    lines, hoursMin, hoursCents,
    kmTenths, kmCents, kmLines,
    parkingCents,
    totalCents: hoursCents + kmCents + parkingCents,
    missingKm, running, problems,
    days: list
  };
}

/* ── formatting ───────────────────────────────────────── */
export function money(cents) {
  const neg = cents < 0;
  const v = Math.abs(Math.round(cents || 0));
  const dollars = String(Math.floor(v / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${dollars}.${pad(v % 100)}`;
}
/** "7.00" — the number a payslip uses. */
export function hoursDec(min) {
  const h100 = Math.round((Math.max(0, min || 0) * 100) / 60);
  return `${Math.floor(h100 / 100)}.${pad(h100 % 100)}`;
}
/** "7 h" / "7 h 30 m" */
export function hm(min) {
  const v = Math.max(0, Math.round(min || 0));
  const H = Math.floor(v / 60), M = v % 60;
  if (!H) return `${M} m`;
  return M ? `${H} h ${M} m` : `${H} h`;
}
/** 124 → "12.4" */
export function kmText(tenths) {
  const v = Math.max(0, Math.round(tenths || 0));
  return `${Math.floor(v / 10)}.${v % 10}`;
}
