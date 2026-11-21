/* ══════════════════════════════════════════════════════════
   Tastings — reports, exports, the month view and the "to fix" list.
   Pure: no DOM, no storage, no network. Anything about "now"
   comes in as an argument.
   Money is whole cents, km whole tenths, dates local "YYYY-MM-DD".
   ══════════════════════════════════════════════════════════ */

import * as pay from "./pay.js";
import * as model from "./model.js";

const pad = n => String(n).padStart(2, "0");
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const KIND_LABEL = {
  weekday: "Weekday", evening: "Weekday after 6 pm",
  saturday: "Saturday", sunday: "Sunday", holiday: "Public holiday"
};

/* ── small helpers ────────────────────────────────────── */
const brandOf = v => (typeof v.brand === "string" ? v.brand.trim() : "");
const storeOf = v => v.placeName || "Store";
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

/** The day's visits in clock order (the same order the trips are built in). */
function orderedVisits(day) {
  return ((day && day.visits) || []).slice().sort((a, b) => {
    const x = pay.toMin(a.paidStart), y = pay.toMin(b.paidStart);
    return (x == null ? 1e9 : x) - (y == null ? 1e9 : y) || (a.startedAt || 0) - (b.startedAt || 0);
  });
}
function daysInRange(days, start, end) {
  return (days || []).filter(d => d && d.date >= start && d.date <= end).sort(byDate);
}
const hasAnything = d =>
  ((d.visits || []).length || (d.legs || []).length || (d.parking || []).length) > 0;
/** The stops of the day's route in order: ["Home", "Store A", "Store B", "Home"]. */
function routeNames(day) {
  const legs = (day && day.legs) || [];
  if (!legs.length) return [];
  return legs.map(l => l.fromName || "Home").concat(legs[legs.length - 1].toName || "Home");
}

/** 4172 → "41.72": plain dollars for a spreadsheet, built from whole cents. */
function dollars(cents) {
  const c = Math.round(cents || 0), v = Math.abs(c);
  return `${c < 0 ? "-" : ""}${Math.floor(v / 100)}.${pad(v % 100)}`;
}
const pctOf = (sampled, talked) => (talked > 0 ? Math.round(sampled * 100 / talked) : null);

/* ── counts ───────────────────────────────────────────── */
export function conversion(visit) {
  const n = model.counts(visit);
  return { talked: n.talked, sampled: n.sampled, declined: n.declined, pct: pctOf(n.sampled, n.talked) };
}

export function rangeCounts(days, start, end) {
  let tastings = 0, talked = 0, sampled = 0, declined = 0, sold = 0;
  for (const d of daysInRange(days, start, end)) {
    for (const v of d.visits || []) {
      const n = model.counts(v);
      tastings++; talked += n.talked; sampled += n.sampled; declined += n.declined; sold += n.sold;
    }
  }
  return { tastings, talked, sampled, declined, sold, pct: pctOf(sampled, talked) };
}

/* ── the day report (plain text for the agency; no pay figures) ── */
export function dayReportText(day, config) {
  const blocks = [[`Tasting day report — ${model.dateText(day.date)}`]];

  const visits = orderedVisits(day);
  visits.forEach((v, i) => {
    const a = model.time12(v.paidStart), b = model.time12(v.paidEnd);
    const time = a && b ? `${a} – ${b}` : a || b;
    const lines = [`${i + 1}. ${storeOf(v)}`];
    if (brandOf(v)) lines.push(`Brand: ${brandOf(v)}`);
    if (time) lines.push(`Time: ${time}`);
    lines.push(...model.countLines(v));
    blocks.push(lines);
  });
  // the total of all the day's tastings, when there is more than one
  if (visits.length > 1) {
    const c = rangeCounts([day], day.date, day.date);
    const lines = ["Total for the day", `Total interactions: ${c.talked}`, `Samples given: ${c.sampled}`, `Rejected or ignored: ${c.declined}`];
    if (visits.some(model.tracksSold)) lines.push(`Sold: ${c.sold}`);
    blocks.push(lines);
  }

  const legs = (day.legs || []).filter(l => !l.skip);
  if (legs.length) {
    const tollFree = !config || config.avoidTolls !== false;
    const lines = [tollFree ? "Travel (roads with no tolls)" : "Travel"];
    if (typeof day.kmDay === "number") {
      // one figure for the whole day, measured as one Google Maps route
      lines.push(`${routeNames(day).join(" → ")}: ${pay.kmText(day.kmDay)} km`);
      lines.push(`Total: ${pay.kmText(day.kmDay)} km`);
    } else {
      let total = 0;
      for (const l of legs) {
        const known = typeof l.tenths === "number";
        if (known) total += l.tenths;
        lines.push(`${l.fromName || "Home"} → ${l.toName || "Home"}: ${known ? pay.kmText(l.tenths) + " km" : "km not entered"}`);
      }
      lines.push(`Total: ${pay.kmText(total)} km`);
    }
    blocks.push(lines);
  }

  let parking = 0;
  for (const p of day.parking || []) parking += Math.max(0, Math.round(p.cents || 0));
  if (parking > 0) blocks.push([`Parking: ${pay.money(parking)}`]);

  return blocks.map(b => b.join("\n")).join("\n\n");
}

/* ── CSV for a spreadsheet ────────────────────────────── */
function csvField(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = fields => fields.map(csvField).join(",");

function tripsNeedKm(n) { return `${n} ${n === 1 ? "trip needs" : "trips need"} km`; }

export function periodCsv(days, config, holidays, start, end) {
  const list = daysInRange(days, start, end);
  const t = pay.periodTotals(days, config, holidays, start, end);

  const summary = [["Tastings summary", start, end], ["Line", "Hours", "Rate", "Amount"]];
  for (const l of t.lines) {
    summary.push([KIND_LABEL[l.kind] || l.kind, pay.hoursDec(l.minutes), dollars(l.rate), dollars(l.cents)]);
  }
  summary.push(["Total hours", pay.hoursDec(t.hoursMin), "", ""]);
  summary.push(["Pay for hours", "", "", dollars(t.hoursCents)]);
  for (const k of t.kmLines) summary.push(["Travel", pay.kmText(k.tenths), dollars(k.rate), dollars(k.cents)]);
  summary.push(["Parking", "", "", dollars(t.parkingCents)]);
  summary.push(["Total payout before tax", "", "", dollars(t.totalCents)]);

  const dayRows = [["Days"], ["Date", "Day", "Paid as", "Tastings", "Total interactions", "Samples given", "Rejected or ignored", "Sold",
    "Paid hours", "Hours pay", "Km", "Km pay", "Parking", "Day total", "To fix"]];
  const visitRows = [["Tastings"], ["Date", "Store", "Brand", "Shift start", "Shift end", "Unpaid break (min)",
    "Paid hours", "Total interactions", "Samples given", "Rejected or ignored", "Sold", "Pay", "Note", "Customer comments"]];
  const flavourRows = [["Flavours"], ["Date", "Store", "Brand", "Flavour", "Samples given", "Sold"]];
  const legRows = [["Trips"], ["Date", "From", "To", "Km", "Checked on", "Not driven"]];

  for (const d of list) {
    if (!hasAnything(d)) continue;
    const dt = pay.dayTotals(d, config, holidays);
    const c = rangeCounts([d], d.date, d.date);
    const fix = [];
    if (dt.missingKm) fix.push(tripsNeedKm(dt.missingKm));
    if (dt.running) fix.push("tasting not finished");
    if (dt.problems.length) fix.push("wrong times");
    dayRows.push([
      d.date, DAY_NAMES[pay.weekdayOf(d.date)], KIND_LABEL[pay.dayKind(d.date, holidays, d.paidAs)],
      c.tastings, c.talked, c.sampled, c.declined, c.sold,
      pay.hoursDec(dt.hoursMin), dollars(dt.hoursCents), pay.kmText(dt.kmTenths), dollars(dt.kmCents),
      dollars(dt.parkingCents), dollars(dt.totalCents), fix.join("; ")
    ]);

    for (const v of orderedVisits(d)) {
      const n = model.counts(v);
      const bad = pay.visitProblems(d, v).length > 0;
      const lines = bad ? [] : pay.visitLines(v, d.date, config, holidays, d.paidAs);
      const minutes = lines.reduce((a, l) => a + l.minutes, 0);
      const cents = lines.reduce((a, l) => a + l.cents, 0);
      visitRows.push([
        d.date, storeOf(v), brandOf(v), v.paidStart || "", v.paidEnd || "",
        Math.max(0, Math.round(v.breakMin || 0)),
        bad ? "" : pay.hoursDec(minutes),
        n.talked, n.sampled, n.declined, n.sold,
        bad ? "" : dollars(cents),
        v.note || "", typeof v.comments === "string" ? v.comments : ""
      ]);
      for (const f of n.flav) flavourRows.push([d.date, storeOf(v), brandOf(v), f.name, f.sampled, f.sold]);
      if (n.flav.length && (n.plain.sampled || n.plain.sold)) {
        flavourRows.push([d.date, storeOf(v), brandOf(v), "No flavour", n.plain.sampled, n.plain.sold]);
      }
    }

    if (typeof d.kmDay === "number" && (d.legs || []).length) {
      // one figure was typed for the whole day's route
      const names = routeNames(d);
      legRows.push([d.date, names[0], names.slice(1).join(" → "), pay.kmText(d.kmDay), d.kmDayOn || "", ""]);
    } else {
      for (const l of d.legs || []) {
        legRows.push([
          d.date, l.fromName || "", l.toName || "",
          typeof l.tenths === "number" ? pay.kmText(l.tenths) : "",
          l.checkedOn || "", l.skip ? "yes" : ""
        ]);
      }
    }
  }

  return [summary, dayRows, visitRows, flavourRows, legRows]
    .map(block => block.map(csvRow).join("\r\n"))
    .join("\r\n\r\n");
}

/* ── month view ───────────────────────────────────────── */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}
const ymText = (y, m) => `${String(y).padStart(4, "0")}-${pad(m)}`;

export function monthGrid(ym, days, config, holidays) {
  const [y, m] = String(ym).split("-").map(Number);
  const count = daysInMonth(y, m);
  const first = `${ymText(y, m)}-01`, last = `${ymText(y, m)}-${pad(count)}`;
  const stored = new Map();
  for (const d of days || []) if (d && d.date >= first && d.date <= last) stored.set(d.date, d);
  const named = holidays && typeof holidays.get === "function";

  const cells = [];
  const lead = (pay.weekdayOf(first) + 6) % 7;          // Monday first
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let n = 1; n <= count; n++) {
    const date = `${ymText(y, m)}-${pad(n)}`;
    const day = stored.get(date);
    const isHoliday = !!(holidays && typeof holidays.has === "function" && holidays.has(date));
    const cell = {
      date, dayNum: n,
      kind: pay.dayKind(date, holidays, day ? day.paidAs : null),
      holidayName: isHoliday ? ((named && holidays.get(date)) || "Public holiday") : null,
      tastings: 0, planned: 0, hoursMin: 0, totalCents: 0, missingKm: 0, running: false, problems: false
    };
    if (day) {
      const t = pay.dayTotals(day, config, holidays);
      cell.tastings = (day.visits || []).length;
      cell.planned = (day.visits || []).filter(model.isPlanned).length;
      cell.hoursMin = t.hoursMin;
      cell.totalCents = t.totalCents;
      cell.missingKm = t.missingKm;
      cell.running = t.running;
      cell.problems = t.problems.length > 0;
    }
    cells.push(cell);
  }
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return {
    ym: ymText(y, m),
    label: `${MONTH_NAMES[m - 1]} ${y}`,
    prev: m === 1 ? ymText(y - 1, 12) : ymText(y, m - 1),
    next: m === 12 ? ymText(y + 1, 1) : ymText(y, m + 1),
    weeks,
    totals: { ...pay.periodTotals(days, config, holidays, first, last), ...rangeCounts(days, first, last) }
  };
}

/* ── things to fix ────────────────────────────────────── */
export function todoList(days, config, holidays, today, lookbackDays = 60) {
  const from = pay.addDays(today, -lookbackDays);
  const out = [];
  for (const d of daysInRange(days, from, today)) {
    const issues = [];
    const past = d.date < today;
    const missing = typeof d.kmDay === "number" ? 0
      : (d.legs || []).filter(l => !l.skip && typeof l.tenths !== "number").length;
    if (missing) issues.push(tripsNeedKm(missing));
    const visits = orderedVisits(d);
    if (visits.some(v => pay.visitProblems(d, v).length)) issues.push("A tasting has wrong times");
    if (past && visits.some(model.isRunning)) issues.push("A tasting was not finished");
    if (past) {
      for (const v of visits) {
        // A tasting that is still running is already listed; one marked "nobody to count" is done.
        if (model.isRunning(v) || v.zeroOk) continue;
        if (model.counts(v).talked === 0) issues.push(`Counts not entered for ${storeOf(v)}`);
      }
    }
    if (issues.length) out.push({ date: d.date, issues });
  }
  return out.reverse();
}

/* ── Australian financial year: 1 July to 30 June ─────── */
export function financialYearOf(date) {
  const [y, m] = String(date).split("-").map(Number);
  const startYear = m >= 7 ? y : y - 1;
  return {
    start: `${startYear}-07-01`,
    end: `${startYear + 1}-06-30`,
    label: `${startYear}–${pad((startYear + 1) % 100)}`
  };
}

/* ── backup ───────────────────────────────────────────── */
export function backupText(config, days, exportedAtISO) {
  return JSON.stringify({
    app: "tastings",
    backupVersion: 1,
    exportedAt: exportedAtISO,
    config,
    days: (days || []).filter(d => d && typeof d.date === "string").slice().sort(byDate)
  }, null, 2);
}

/* ── the payslip ──────────────────────────────────────────
   One pay period as a payslip: hours by pay type, total hours, pay for hours, travel and
   parking as their own lines, the total payout, and the days one by one. Nothing here is
   stored: it is worked out fresh from the days every time. */

/** "Does the real payslip match?" The tolerance (a few cents of rounding) lives here only. */
export const PAID_TOLERANCE = 5;
export function paidVerdict(expectedCents, paidCents) {
  if (typeof paidCents !== "number" || !Number.isFinite(paidCents) || !Number.isFinite(Number(expectedCents))) {
    return { status: "unchecked", diffCents: 0 };
  }
  const diff = Math.round(paidCents) - Math.round(expectedCents);
  return { status: Math.abs(diff) <= PAID_TOLERANCE ? "match" : diff < 0 ? "short" : "over", diffCents: diff };
}
const periodLength = payPeriod => (payPeriod && payPeriod.days === 14 ? 14 : 7);
/** The key a typed payslip amount is kept under in config.paid. */
export const paidKeyOf = (start, payPeriod) => `${start}:${periodLength(payPeriod)}`;

export function payslipData(days, config, holidays, date, today) {
  const pp = (config && config.payPeriod) || {};
  const { start, end } = pay.periodOf(date, pp);
  const t = pay.periodTotals(days, config, holidays, start, end);
  const stored = new Map(daysInRange(days, start, end).map(d => [d.date, d]));

  let toComeShifts = 0, toComeMin = 0, notCounted = 0;
  const list = t.days.map(row => {
    const day = stored.get(row.date);
    const dt = pay.dayTotals(day, config, holidays);          // exactly what Today shows for that day
    const visits = orderedVisits(day);
    let planned = 0, uncounted = 0;
    for (const v of visits) {
      if (!model.isPlanned(v) || model.counts(v).talked !== 0) continue;
      if (row.date >= today) {
        // a shift that is typed in but not worked yet: it is already paid in the totals
        planned++; toComeShifts++;
        if (!pay.visitProblems(day, v).length) {
          toComeMin += pay.visitLines(v, row.date, config, holidays, day.paidAs).reduce((a, l) => a + l.minutes, 0);
        }
      } else if (!v.zeroOk && !pay.visitProblems(day, v).length) {
        // an earlier shift typed in but never counted: it is paid in the totals all the same. One
        // with wrong times is left out of the totals, so it belongs to the wrongTimes item, not this one
        uncounted++; notCounted++;
      }
    }
    return {
      date: row.date, kind: pay.dayKind(row.date, holidays, day.paidAs), stores: visits.map(storeOf),
      hoursMin: dt.hoursMin, hoursCents: dt.hoursCents, kmTenths: dt.kmTenths, kmCents: dt.kmCents,
      parkingCents: dt.parkingCents, totalCents: dt.totalCents,
      missingKm: dt.missingKm, running: dt.running, wrongTimes: dt.problems.length > 0, planned, uncounted,
      // a running tasting is paid already when its shift times are typed (and right); only one
      // started with no finish time is left out until it is finished
      runningUnpaid: visits.some(v => model.isRunning(v) && (!v.paidStart || !v.paidEnd || pay.visitProblems(day, v).length > 0))
    };
  });
  const daysSumCents = list.reduce((a, d) => a + d.totalCents, 0);

  const first = pred => (list.find(pred) || {}).date || null;
  const pending = [];
  if (t.running) pending.push({ code: "running", count: list.filter(d => d.running).length, date: first(d => d.running), inTotal: !list.some(d => d.runningUnpaid) });
  if (t.problems.length) pending.push({ code: "wrongTimes", count: list.filter(d => d.wrongTimes).length, date: first(d => d.wrongTimes) });
  if (t.missingKm) pending.push({ code: "missingKm", count: t.missingKm, date: first(d => d.missingKm) });
  if (notCounted) pending.push({ code: "notCounted", count: notCounted, date: first(d => d.uncounted) });
  if (toComeShifts) pending.push({ code: "toCome", count: toComeShifts, minutes: toComeMin, date: first(d => d.planned) });
  if (today >= start && today <= end) pending.push({ code: "open", count: pay.daysBetween(today, end), date: end });

  const key = paidKeyOf(start, pp);
  const typed = ((config && config.paid) || {})[key];
  const paidCents = typeof typed === "number" && Number.isFinite(typed) ? typed : null;
  return {
    start, end, periodDays: periodLength(pp),
    isCurrent: today >= start && today <= end, isFuture: start > today,
    lines: t.lines, hoursMin: t.hoursMin, hoursCents: t.hoursCents,
    kmLines: t.kmLines, kmTenths: t.kmTenths, kmCents: t.kmCents, parkingCents: t.parkingCents,
    extrasCents: t.kmCents + t.parkingCents,
    totalCents: t.totalCents,
    days: list, daysSumCents,
    // Pay is rounded once per line for the whole period, each day once for itself: the two can
    // differ by a cent or two. Days + rounding = total, always.
    roundingCents: t.totalCents - daysSumCents,
    pending, final: pending.length === 0,
    paidKey: key, paidCents, verdict: paidVerdict(t.totalCents, paidCents)
  };
}

/** One "not final yet" reason as a sentence (the screen and the text version share it). */
export function pendingText(item, word = "fortnight") {
  const n = item.count;
  if (item.code === "running") {
    return item.inTotal
      ? "A tasting is still running. Its shift hours are already in the total."
      : "A tasting is still running. Its hours are not in the total yet.";
  }
  if (item.code === "wrongTimes") return `${n} ${n === 1 ? "day has" : "days have"} a tasting with wrong times. Those hours are not in the total.`;
  if (item.code === "missingKm") return `${n} ${n === 1 ? "trip has no km yet. It is" : "trips have no km yet. They are"} not in the total.`;
  if (item.code === "notCounted") return `${n} earlier ${n === 1 ? "shift has" : "shifts have"} no counts. ${n === 1 ? "It is" : "They are"} in the total — check that you worked ${n === 1 ? "it" : "them"}.`;
  if (item.code === "toCome") return `${n} ${n === 1 ? "shift is still to work" : "shifts are still to work"} (${pay.hoursDec(item.minutes)} h). ${n === 1 ? "It is" : "They are"} already in the total.`;
  if (item.code === "open") return n === 0 ? `This ${word} ends today.` : `This ${word} ends on ${model.dateText(item.date, false)}.`;
  return "";
}

/** What a day still needs, as short flags for its row: "km missing", "still to work" … */
export function dayFlags(d) {
  return [d.planned ? "still to work" : "", d.uncounted ? "no counts" : "", d.running ? "not finished" : "",
    d.wrongTimes ? "wrong times" : "", d.missingKm ? "km missing" : ""].filter(Boolean);
}

export function payslipText(slip) {
  const word = slip.periodDays === 14 ? "fortnight" : "week";
  const out = [`Payslip — ${model.dateText(slip.start, false)} to ${model.dateText(slip.end)}`];
  if (!slip.final) out.push("NOT FINAL YET — see the end");
  out.push("", "HOURS");
  for (const l of slip.lines) {
    out.push(`${KIND_LABEL[l.kind] || l.kind}: ${pay.hoursDec(l.minutes)} h × ${pay.money(l.rate)} = ${pay.money(l.cents)}`);
  }
  if (!slip.lines.length) out.push("No hours yet");
  out.push(`Total hours: ${pay.hoursDec(slip.hoursMin)} h`, `Pay for hours: ${pay.money(slip.hoursCents)}`, "", "TRAVEL AND PARKING");
  for (const k of slip.kmLines) out.push(`Travel: ${pay.kmText(k.tenths)} km × ${pay.money(k.rate)} = ${pay.money(k.cents)}`);
  if (!slip.kmLines.length) out.push("Travel: 0.0 km = $0.00");
  out.push(`Parking: ${pay.money(slip.parkingCents)}`, "", `TOTAL PAYOUT, BEFORE TAX: ${pay.money(slip.totalCents)}`);
  if (slip.days.length) {
    out.push("", "DAY BY DAY");
    for (const d of slip.days) {
      const flags = dayFlags(d);
      out.push(`${model.dateText(d.date, false)} — ${d.stores.join(", ") || "No tasting"}`);
      out.push(`  ${pay.hoursDec(d.hoursMin)} h = ${pay.money(d.hoursCents)} · travel ${pay.money(d.kmCents)} · parking ${pay.money(d.parkingCents)} · day ${pay.money(d.totalCents)}${flags.length ? " (" + flags.join(", ") + ")" : ""}`);
    }
    if (slip.roundingCents) out.push(`Rounding: ${pay.money(slip.roundingCents)} (the ${word} is rounded once per line, not day by day)`);
  }
  if (!slip.final) {
    out.push("", "NOT FINAL YET");
    for (const p of slip.pending) out.push("- " + pendingText(p, word));
  }
  if (slip.verdict.status !== "unchecked") {
    const v = slip.verdict, m = pay.money(Math.abs(v.diffCents));
    out.push("", `My real payslip says: ${pay.money(slip.paidCents)} — ${v.status === "match" ? "matches" : v.status === "short" ? m + " less than this total" : m + " more than this total"}`);
  }
  return out.join("\n");
}

/** Past pay periods, newest first: what was expected, what the payslip said, and the verdict.
    Finished periods only; a period with no work and nothing typed is left out. */
export function paidHistory(days, config, holidays, today, count = 6) {
  const pp = (config && config.payPeriod) || {}, n = periodLength(pp), out = [];
  let start = pay.addDays(pay.periodOf(today, pp).start, -n);
  for (let i = 0; i < 26 && out.length < count; i++, start = pay.addDays(start, -n)) {
    const end = pay.addDays(start, n - 1);
    const t = pay.periodTotals(days, config, holidays, start, end);
    const typed = ((config && config.paid) || {})[paidKeyOf(start, pp)];
    const paidCents = typeof typed === "number" && Number.isFinite(typed) ? typed : null;
    if (!t.days.length && paidCents == null) continue;
    const v = paidVerdict(t.totalCents, paidCents);
    out.push({
      start, end, expectedCents: t.totalCents, hoursMin: t.hoursMin, paidCents,
      status: v.status, diffCents: v.diffCents,
      notFinal: !!(t.missingKm || t.running || t.problems.length)
    });
  }
  return out;
}

/** The pay periods that can hold today when a period starts on a Monday: the two possible
    fortnights (older first), or the one week. For the "which fortnight are you in?" question. */
export function periodChoices(today, days = 14) {
  const monday = pay.addDays(today, -((pay.weekdayOf(today) + 6) % 7));
  const starts = days === 14 ? [pay.addDays(monday, -7), monday] : [monday];
  return starts.map(start => ({ start, end: pay.addDays(start, days - 1) }));
}
