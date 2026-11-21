// Version 6: the payslip (report.js) and the older report functions that learned about
// "sold", flavours and customer comments.
// Run from the project folder:  node --test
// Also run with TZ=UTC and TZ=America/Los_Angeles: no result may depend on the time zone.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as report from "../public/report.js";
import * as pay from "../public/pay.js";
import * as model from "../public/model.js";
import { holidayMap } from "../public/holidays.js";

const cfg = (over = {}) => model.withConfigDefaults(over);
const hol = () => holidayMap(cfg());

let seq = 0;
/** A finished tasting from before version 6 (no adjB). taps like "SSN" are counted as typed. */
const visit = (placeName, start, end, taps = "", extra = {}) => ({
  id: "v" + (++seq), placeId: "p_" + placeName, placeName,
  startedAt: 1000, endedAt: 2000,
  paidStart: start, paidEnd: end, startManual: true, endManual: true,
  breakMin: 0, tapT: [...taps].map((_, i) => i), tapK: taps, adjS: 0, adjN: 0, note: "", ...extra
});
/** A finished tasting made by version 6: it has a number in adjB, so it tracks sold. */
const visit6 = (placeName, start, end, taps = "", extra = {}) =>
  visit(placeName, start, end, taps, { adjB: 0, ...extra });
const planned = (placeName, start, end, extra = {}) =>
  visit(placeName, start, end, "", { startedAt: null, endedAt: null, ...extra });
const running = (placeName, start, taps = "", extra = {}) =>
  visit(placeName, start, "", taps, { endedAt: null, endManual: false, ...extra });
const leg = (fromName, toName, tenths, extra = {}) => ({
  from: fromName, to: toName, fromName, toName,
  tenths, checkedOn: tenths == null ? null : "2026-11-14", checkedTime: null, via: "", skip: false, ...extra
});
const park = cents => ({ id: "k" + (++seq), cents, note: "", visitId: null });
const day = (date, visits, extra = {}) =>
  ({ v: 1, date, updatedAt: 1, paidAs: null, visits, legs: [], parking: [], ...extra });
const taps = (s, n) => "S".repeat(s) + "N".repeat(n);
const clone = x => JSON.parse(JSON.stringify(x));

/** No output for a person may ever show these words. */
const assertClean = text => {
  for (const bad of ["undefined", "NaN", "null"]) assert.ok(!text.includes(bad), `"${bad}" in:\n${text}`);
};
/** The laws every payslip obeys, whatever is on it. */
const assertLaws = (slip, days, config) => {
  assert.equal(slip.hoursCents + slip.kmCents + slip.parkingCents, slip.totalCents, "hours + km + parking = total");
  assert.equal(slip.daysSumCents + slip.roundingCents, slip.totalCents, "days + rounding = total");
  assert.equal(slip.extrasCents, slip.kmCents + slip.parkingCents);
  assert.equal(slip.daysSumCents, slip.days.reduce((a, d) => a + d.totalCents, 0));
  assert.equal(slip.hoursMin, slip.lines.reduce((a, l) => a + l.minutes, 0));
  assert.equal(slip.hoursCents, slip.lines.reduce((a, l) => a + l.cents, 0));
  assert.equal(slip.kmCents, slip.kmLines.reduce((a, l) => a + l.cents, 0));
  assert.equal(slip.kmTenths, slip.kmLines.reduce((a, l) => a + l.tenths, 0));
  assert.equal(slip.final, slip.pending.length === 0);
  for (const row of slip.days) {
    const stored = days.find(d => d.date === row.date);
    const dt = pay.dayTotals(stored, config, hol());
    assert.equal(row.totalCents, dt.totalCents, row.date + " total");
    assert.equal(row.hoursMin, dt.hoursMin, row.date + " minutes");
    assert.equal(row.hoursCents, dt.hoursCents, row.date + " hours pay");
    assert.equal(row.kmTenths, dt.kmTenths, row.date + " km");
    assert.equal(row.kmCents, dt.kmCents, row.date + " km pay");
    assert.equal(row.parkingCents, dt.parkingCents, row.date + " parking");
    assert.equal(row.missingKm, dt.missingKm, row.date + " missing km");
    assert.equal(row.running, dt.running, row.date + " running");
    assert.equal(row.wrongTimes, dt.problems.length > 0, row.date + " wrong times");
    assert.ok(row.date >= slip.start && row.date <= slip.end);
  }
  assert.deepEqual(clone(slip), slip, "survives a JSON round trip");
};

// The default pay period: fortnights from Monday 21 Sep 2026.
// … 19 Oct – 1 Nov, 2 Nov – 15 Nov, 16 Nov – 29 Nov, 30 Nov – 13 Dec …
const TODAY = "2026-11-21";                       // a Saturday inside 16–29 Nov
const slipOf = (days, date, today = TODAY, config = cfg()) => report.payslipData(days, config, hol(), date, today);

test("the dates used in these tests are what they claim", () => {
  assert.equal(pay.weekdayOf("2026-09-21"), 1);
  assert.equal(pay.weekdayOf("2026-11-02"), 1);
  assert.equal(pay.weekdayOf("2026-11-16"), 1);
  assert.equal(pay.weekdayOf(TODAY), 6);
  assert.equal(pay.weekdayOf("2026-11-01"), 0);
  assert.equal(pay.weekdayOf("2026-11-15"), 0);
  assert.equal(pay.weekdayOf("2026-09-23"), 3);
  assert.ok(hol().has("2026-11-03"), "Melbourne Cup is a public holiday");
});

/* ── paidVerdict, paidKeyOf ───────────────────────────── */
test("paidVerdict: nothing typed is unchecked", () => {
  assert.equal(report.PAID_TOLERANCE, 5);
  assert.deepEqual(report.paidVerdict(77538, null), { status: "unchecked", diffCents: 0 });
  assert.deepEqual(report.paidVerdict(77538, undefined), { status: "unchecked", diffCents: 0 });
  assert.deepEqual(report.paidVerdict(77538), { status: "unchecked", diffCents: 0 });
  assert.deepEqual(report.paidVerdict(77538, "77538"), { status: "unchecked", diffCents: 0 });
  assert.deepEqual(report.paidVerdict(77538, ""), { status: "unchecked", diffCents: 0 });
  assert.deepEqual(report.paidVerdict(77538, {}), { status: "unchecked", diffCents: 0 });
  assert.deepEqual(report.paidVerdict(77538, true), { status: "unchecked", diffCents: 0 });
});
test("paidVerdict: exact, and 5 cents either way, is a match", () => {
  assert.deepEqual(report.paidVerdict(77538, 77538), { status: "match", diffCents: 0 });
  assert.deepEqual(report.paidVerdict(77538, 77543), { status: "match", diffCents: 5 });
  assert.deepEqual(report.paidVerdict(77538, 77533), { status: "match", diffCents: -5 });
  assert.deepEqual(report.paidVerdict(0, 0), { status: "match", diffCents: 0 });
});
test("paidVerdict: 6 cents short is short, 6 cents over is over", () => {
  assert.deepEqual(report.paidVerdict(77538, 77532), { status: "short", diffCents: -6 });
  assert.deepEqual(report.paidVerdict(77538, 77544), { status: "over", diffCents: 6 });
  assert.deepEqual(report.paidVerdict(77538, 0), { status: "short", diffCents: -77538 });
  assert.deepEqual(report.paidVerdict(0, 12345), { status: "over", diffCents: 12345 });
});
test("paidVerdict: a paid amount that is not a real number is unchecked, never NaN", () => {
  assert.deepEqual(report.paidVerdict(77538, NaN), { status: "unchecked", diffCents: 0 });
});

test("paidKeyOf: the period start, a colon, 7 or 14", () => {
  assert.equal(report.paidKeyOf("2026-11-02", { days: 14, anchor: "2026-09-21" }), "2026-11-02:14");
  assert.equal(report.paidKeyOf("2026-11-02", { days: 7, anchor: "2026-09-21" }), "2026-11-02:7");
  assert.equal(report.paidKeyOf("2026-11-02", cfg().payPeriod), "2026-11-02:14");
  assert.equal(report.paidKeyOf("2026-11-16", cfg({ payPeriod: { days: 7 } }).payPeriod), "2026-11-16:7");
});

/* ── payslipData: a rich fortnight ────────────────────── */
// Saturday pay and the km rate change on Monday 9 Nov, in the middle of 2–15 Nov.
const richConfig = (over = {}) => cfg({
  rateSets: [{ ...pay.DEFAULT_RATE_SET }, { ...pay.DEFAULT_RATE_SET, from: "2026-11-09", saturday: 4300, km: 110 }],
  ...over
});
const richDays = () => [
  // Sun 15 Nov: 3 h 15; one trip with km, one without, one not driven
  day("2026-11-15", [visit("Vintage Cellars", "10:00", "13:15", taps(4, 4))], {
    legs: [leg("Home", "Vintage Cellars", 55), leg("Vintage Cellars", "Depot", null), leg("Depot", "Home", 77, { skip: true })]
  }),
  // Tue 3 Nov, Melbourne Cup: 4 h at the public holiday rate
  day("2026-11-03", [visit("Cup Day Cellars", "10:00", "14:00", taps(9, 2))]),
  // Thu 5 Nov: 3 h less a 30 minute break, two lots of parking
  day("2026-11-05", [visit("Bottle-O", "16:00", "19:00", "", { breakMin: 30 })], { parking: [park(650), park(300)] }),
  // Sat 7 Nov: two tastings (typed out of order), three trips, parking, old rates
  day("2026-11-07", [
    visit("Liquorland Fitzroy", "15:00", "18:00", taps(10, 5)),
    visit("BWS Carlton", "10:00", "14:00", taps(27, 16))
  ], {
    legs: [leg("Home", "BWS Carlton", 124), leg("BWS Carlton", "Liquorland Fitzroy", 87), leg("Liquorland Fitzroy", "Home", 151)],
    parking: [park(650)]
  }),
  // Sun 8 Nov: 3 h 15; one trip has no km
  day("2026-11-08", [visit("Dan Murphy's Kew", "10:00", "13:15")], {
    legs: [leg("Home", "Dan Murphy's Kew", 50), leg("Dan Murphy's Kew", "Home", null)]
  }),
  // Wed 11 Nov, paid as a Sunday: 2 h 30; one km figure for the whole day (a trip without km does not matter)
  day("2026-11-11", [visit("IGA Liquor", "10:00", "12:30")], {
    paidAs: "sunday", kmDay: 233, kmDayOn: "2026-11-11",
    legs: [leg("Home", "IGA Liquor", null), leg("IGA Liquor", "Home", null)]
  }),
  // Sat 14 Nov: two tastings, new Saturday rate and new km rate
  day("2026-11-14", [
    visit("BWS Carlton", "10:00", "14:00", taps(3, 1)),
    visit("Liquorland Fitzroy", "15:00", "18:10", taps(2, 2))
  ], {
    legs: [leg("Home", "BWS Carlton", 124), leg("BWS Carlton", "Liquorland Fitzroy", 87), leg("Liquorland Fitzroy", "Home", 151)]
  }),
  // outside the fortnight on both sides: must not be counted
  day("2026-11-01", [visit("Before", "10:00", "14:00")], { parking: [park(999)] }),
  day("2026-11-16", [visit("After", "10:00", "14:00")], { legs: [leg("Home", "After", null)] }),
  // a stored day with nothing on it is not a row
  day("2026-11-10", [])
];

test("payslip, rich fortnight: the period and its lines", () => {
  const slip = slipOf(richDays(), "2026-11-10", TODAY, richConfig());
  assert.equal(slip.start, "2026-11-02");
  assert.equal(slip.end, "2026-11-15");
  assert.equal(slip.periodDays, 14);
  assert.equal(slip.isCurrent, false);
  assert.equal(slip.isFuture, false);
  // two Saturday lines (one per rate), the three "Sundays" grouped: 540 min × 48.67 = 438.03 exactly
  assert.deepEqual(slip.lines, [
    { kind: "weekday", minutes: 150, rate: 3476, cents: 8690 },
    { kind: "saturday", minutes: 420, rate: 4172, cents: 29204 },
    { kind: "saturday", minutes: 430, rate: 4300, cents: 30817 },
    { kind: "sunday", minutes: 540, rate: 4867, cents: 43803 },
    { kind: "holiday", minutes: 240, rate: 6953, cents: 27812 }
  ]);
  assert.equal(slip.hoursMin, 1780);
  assert.equal(slip.hoursCents, 140326);
  assert.deepEqual(slip.kmLines, [
    { rate: 100, tenths: 412, cents: 4120 },
    { rate: 110, tenths: 650, cents: 7150 }
  ]);
  assert.equal(slip.kmTenths, 1062);
  assert.equal(slip.kmCents, 11270);
  assert.equal(slip.parkingCents, 1600);
  assert.equal(slip.extrasCents, 12870);
  assert.equal(slip.totalCents, 153196);
});
test("payslip, rich fortnight: the three laws", () => {
  const days = richDays(), config = richConfig();
  const slip = slipOf(days, "2026-11-02", TODAY, config);
  assert.equal(slip.hoursCents + slip.kmCents + slip.parkingCents, slip.totalCents);
  assert.equal(slip.daysSumCents + slip.roundingCents, slip.totalCents);
  // each Sunday-rate day rounds up for itself (158.18 + 121.68 + 158.18), the line does not (438.03)
  assert.equal(slip.daysSumCents, 153197);
  assert.equal(slip.roundingCents, -1);
  assertLaws(slip, days, config);
});
test("payslip, rich fortnight: day by day, each day exactly what pay.dayTotals says", () => {
  const days = richDays(), config = richConfig();
  const slip = slipOf(days, "2026-11-15", TODAY, config);
  assert.deepEqual(slip.days.map(d => [d.date, d.kind, d.totalCents]), [
    ["2026-11-03", "holiday", 27812],
    ["2026-11-05", "weekday", 9640],
    ["2026-11-07", "saturday", 33474],
    ["2026-11-08", "sunday", 16318],
    ["2026-11-11", "sunday", 14731],
    ["2026-11-14", "saturday", 34799],
    ["2026-11-15", "sunday", 16423]
  ]);
  for (const row of slip.days) {
    const dt = pay.dayTotals(days.find(d => d.date === row.date), config, hol());
    assert.equal(row.totalCents, dt.totalCents);
    assert.equal(row.hoursCents, dt.hoursCents);
    assert.equal(row.kmCents, dt.kmCents);
    assert.equal(row.parkingCents, dt.parkingCents);
  }
  // one whole row, every field
  assert.deepEqual(slip.days[2], {
    date: "2026-11-07", kind: "saturday", stores: ["BWS Carlton", "Liquorland Fitzroy"],
    hoursMin: 420, hoursCents: 29204, kmTenths: 362, kmCents: 3620, parkingCents: 650, totalCents: 33474,
    missingKm: 0, running: false, wrongTimes: false, planned: 0, uncounted: 0, runningUnpaid: false
  });
  // a whole-day km figure stands for every trip: nothing is missing on that day
  assert.deepEqual([slip.days[4].kmTenths, slip.days[4].kmCents, slip.days[4].missingKm], [233, 2563, 0]);
  assert.deepEqual(slip.days.map(d => d.missingKm), [0, 0, 0, 1, 0, 0, 1]);
});
test("payslip, rich fortnight: only the two trips with no km keep it from being final", () => {
  const slip = slipOf(richDays(), "2026-11-10", TODAY, richConfig());
  assert.deepEqual(slip.pending, [{ code: "missingKm", count: 2, date: "2026-11-08" }]);
  assert.equal(slip.final, false);
});
test("payslipData does not change the days or the config it is given", () => {
  const days = richDays(), config = richConfig({ paid: { "2026-11-02:14": 153196 } });
  const before = clone([days, config]);
  slipOf(days, "2026-11-10", TODAY, config);
  report.paidHistory(days, config, hol(), TODAY);
  assert.deepEqual(clone([days, config]), before);
});
test("payslip: the weekday evening rate is its own line", () => {
  const config = cfg({ rateSets: [{ ...pay.DEFAULT_RATE_SET, evening: 4172 }] });
  const days = [day("2026-11-13", [visit("A", "16:00", "19:00")])];
  const slip = slipOf(days, "2026-11-13", TODAY, config);
  assert.deepEqual(slip.lines.map(l => [l.kind, l.minutes, l.cents]), [["weekday", 120, 6952], ["evening", 60, 4172]]);
  assertLaws(slip, days, config);
  const text = report.payslipText(slip);
  assert.ok(text.includes("\nWeekday: 2.00 h × $34.76 = $69.52\nWeekday after 6 pm: 1.00 h × $41.72 = $41.72\n"));
});

/* ── rounding ─────────────────────────────────────────── */
// A fortnight holds only two Sundays, so the third "Sunday" is a Saturday paid as one.
const threeSundays = () => [
  day("2026-11-08", [visit("A", "10:00", "13:15")]),
  day("2026-11-14", [visit("B", "10:00", "13:15")], { paidAs: "sunday" }),
  day("2026-11-15", [visit("C", "10:00", "13:15")])
];
test("rounding: three Sunday-rate tastings of 3 h 15 are $474.53, the days add up to $474.54", () => {
  const days = threeSundays();
  const slip = slipOf(days, "2026-11-08");
  assert.deepEqual(slip.lines, [{ kind: "sunday", minutes: 585, rate: 4867, cents: 47453 }]);
  assert.deepEqual(slip.days.map(d => d.totalCents), [15818, 15818, 15818]);
  assert.equal(slip.totalCents, 47453);
  assert.equal(slip.daysSumCents, 47454);
  assert.equal(slip.roundingCents, -1);
  assert.equal(slip.final, true);
  assertLaws(slip, days, cfg());
});
test("rounding can go the other way: two Sundays of 45 minutes", () => {
  // 45 min × 48.67 = 36.5025 → 36.50 each day; 90 min = 73.005 → 73.01 for the fortnight
  const days = [day("2026-11-08", [visit("A", "10:00", "10:45")]), day("2026-11-15", [visit("B", "10:00", "10:45")])];
  const slip = slipOf(days, "2026-11-08");
  assert.equal(slip.daysSumCents, 7300);
  assert.equal(slip.totalCents, 7301);
  assert.equal(slip.roundingCents, 1);
  assertLaws(slip, days, cfg());
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
test("property: 300 random fortnights, default rates, quarter-hour shifts: rounding within 2 cents, laws hold", () => {
  const rnd = mulberry32(20261121);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const config = cfg();
  let nonZero = 0, withHoliday = 0;
  for (let run = 0; run < 300; run++) {
    const start = pay.addDays("2026-09-21", 14 * int(-5, 32));        // Jul 2026 … Dec 2027
    const days = [];
    for (let i = 0; i < 14; i++) {
      if (rnd() < 0.4) continue;
      const date = pay.addDays(start, i);
      if (hol().has(date)) withHoliday++;
      const visits = [];
      const s1 = 540 + 15 * int(0, 8), e1 = s1 + 15 * int(1, 20);
      visits.push(visit("A", pay.fromMin(s1), pay.fromMin(e1), "", rnd() < 0.2 ? { breakMin: 15 * int(0, 2) } : {}));
      if (rnd() < 0.5) {
        const s2 = e1 + 15 * int(0, 4), e2 = s2 + 15 * int(1, 16);
        visits.push(visit("B", pay.fromMin(s2), pay.fromMin(e2)));
      }
      const extra = { legs: [], parking: [] };
      const legCount = int(0, 3);
      for (let l = 0; l < legCount; l++) extra.legs.push(leg("X", "Y", rnd() < 0.15 ? null : int(0, 600), { skip: rnd() < 0.1 }));
      if (legCount && rnd() < 0.2) extra.kmDay = int(0, 900);
      if (rnd() < 0.3) extra.parking.push(park(int(0, 2500)));
      days.push(day(date, visits, extra));
    }
    const slip = report.payslipData(days, config, hol(), pay.addDays(start, int(0, 13)), "2028-06-01");
    const where = `run ${run}, fortnight from ${start}`;
    assert.equal(slip.start, start, where);
    assert.equal(slip.end, pay.addDays(start, 13), where);
    assert.ok(Math.abs(slip.roundingCents) <= 2, `${where}: rounding ${slip.roundingCents}`);
    assert.equal(slip.days.length, days.length, where);
    assert.ok(slip.days.every(d => !d.wrongTimes && !d.running && d.planned === 0), where);
    assertLaws(slip, days, config);
    assertClean(report.payslipText(slip));
    if (slip.roundingCents) nonZero++;
  }
  assert.ok(nonZero > 0, "the generator reaches fortnights whose days do not add up to the total");
  assert.ok(withHoliday > 0, "the generator reaches public holidays");
});

/* ── payslipData: what is still pending ───────────────── */
const PAST = "2026-11-10";                        // inside 2–15 Nov, finished by TODAY

test("pending: nothing at all for a finished, complete fortnight", () => {
  const slip = slipOf([day("2026-11-07", [visit("A", "10:00", "14:00")])], PAST);
  assert.deepEqual(slip.pending, []);
  assert.equal(slip.final, true);
});
test("pending: running alone, counted in days", () => {
  const days = [
    day("2026-11-07", [running("A", "10:00", "SS")]),
    day("2026-11-05", [visit("B", "10:00", "14:00")]),
    day("2026-11-08", [running("C", "10:00"), running("D", "12:00")])
  ];
  const slip = slipOf(days, PAST);
  assert.deepEqual(slip.pending, [{ code: "running", count: 2, date: "2026-11-07", inTotal: false }]);
  assert.equal(report.pendingText(slip.pending[0], "week"), "A tasting is still running. Its hours are not in the total yet.");
  assert.equal(slip.final, false);
  assert.deepEqual(slip.days.map(d => d.running), [false, true, true]);
  assert.equal(slip.hoursMin, 240, "a running tasting pays nothing yet");
  assertLaws(slip, days, cfg());
});
test("pending: wrong times alone, counted in days, the first such day as its date", () => {
  const days = [
    day("2026-11-03", [visit("Fine", "10:00", "14:00")]),
    day("2026-11-07", [visit("A", "15:00", "14:00"), visit("B", "09:00", "")]),     // two on one day = one day
    day("2026-11-08", [visit("C", "10:00", "13:00"), visit("D", "12:00", "15:00")]) // overlap
  ];
  const slip = slipOf(days, PAST);
  assert.deepEqual(slip.pending, [{ code: "wrongTimes", count: 2, date: "2026-11-07" }]);
  assert.deepEqual(slip.days.map(d => d.wrongTimes), [false, true, true]);
  assert.equal(slip.hoursMin, 240, "hours with wrong times are not in the total");
  assertLaws(slip, days, cfg());
});
test("pending: missing km alone, counted in trips; skipped trips and whole-day km do not count", () => {
  const days = [
    day("2026-11-05", [visit("A", "10:00", "14:00")], { legs: [leg("Home", "A", 30), leg("A", "Home", null, { skip: true })] }),
    day("2026-11-07", [visit("B", "10:00", "14:00")], { legs: [leg("Home", "B", null), leg("B", "Home", null)] }),
    day("2026-11-08", [visit("C", "10:00", "14:00")], { legs: [leg("Home", "C", null)] }),
    day("2026-11-09", [visit("D", "10:00", "14:00")], { kmDay: 80, legs: [leg("Home", "D", null), leg("D", "Home", null)] })
  ];
  const slip = slipOf(days, PAST);
  assert.deepEqual(slip.pending, [{ code: "missingKm", count: 3, date: "2026-11-07" }]);
  assert.deepEqual(slip.days.map(d => d.missingKm), [0, 2, 1, 0]);
  assert.equal(slip.kmTenths, 110);
  assertLaws(slip, days, cfg());
});
test("pending: shifts to come alone, in a fortnight that has not begun", () => {
  const days = [
    day("2026-12-05", [planned("A", "10:00", "14:00"), planned("B", "15:00", "18:30")]),
    day("2026-12-06", [planned("C", "10:00", "13:00", { breakMin: 30 })])
  ];
  const slip = slipOf(days, "2026-12-01");
  assert.equal(slip.start, "2026-11-30");
  assert.deepEqual(slip.pending, [{ code: "toCome", count: 3, minutes: 240 + 210 + 150, date: "2026-12-05" }]);
  assert.equal(slip.final, false);
  assert.deepEqual(slip.days.map(d => d.planned), [2, 1]);
  assert.equal(slip.hoursMin, 600, "planned shifts are already in the total");
  assertLaws(slip, days, cfg());
});
test("pending: open alone, counting the days left in the fortnight", () => {
  const at = today => slipOf([], today, today).pending;
  assert.deepEqual(at("2026-11-16"), [{ code: "open", count: 13, date: "2026-11-29" }]);
  assert.deepEqual(at(TODAY), [{ code: "open", count: 8, date: "2026-11-29" }]);
  assert.deepEqual(at("2026-11-28"), [{ code: "open", count: 1, date: "2026-11-29" }]);
  assert.deepEqual(at("2026-11-29"), [{ code: "open", count: 0, date: "2026-11-29" }]);
  assert.equal(slipOf([], TODAY, TODAY).final, false);
  // looked at from outside, the same fortnight is not open
  assert.deepEqual(slipOf([], TODAY, "2026-11-30").pending, []);
  assert.deepEqual(slipOf([], TODAY, "2026-11-15").pending, []);
});
test("pending: a planned tasting dated today is to come; one dated yesterday is an earlier shift with no counts", () => {
  const days = [
    day("2026-11-20", [planned("Yesterday", "10:00", "14:00")]),
    day(TODAY, [planned("Today", "10:00", "13:00")]),
    day("2026-11-22", [planned("Tomorrow", "10:00", "12:00")])
  ];
  const slip = slipOf(days, TODAY);
  assert.deepEqual(slip.pending, [
    { code: "notCounted", count: 1, date: "2026-11-20" },
    { code: "toCome", count: 2, minutes: 300, date: TODAY },
    { code: "open", count: 8, date: "2026-11-29" }
  ]);
  assert.deepEqual(slip.days.map(d => d.planned), [0, 1, 1]);
  assert.deepEqual(slip.days.map(d => d.uncounted), [1, 0, 0]);
  assert.equal(report.pendingText(slip.pending[0], "fortnight"), "1 earlier shift has no counts. It is in the total — check that you worked it.");
  assert.deepEqual(report.dayFlags(slip.days[0]), ["no counts"]);
  // "nobody to count" on that tasting settles it
  days[0].visits[0].zeroOk = true;
  assert.deepEqual(slipOf(days, TODAY).pending.map(p => p.code), ["toCome", "open"]);
  delete days[0].visits[0].zeroOk;
  assert.equal(slip.hoursMin, 540, "all three are paid in the total");
  assertLaws(slip, days, cfg());
});
test("pending: an earlier uncounted shift with wrong times is a wrongTimes item, not a 'no counts' one", () => {
  // two planned shifts on an earlier day whose times overlap — the day is paid 0 hours
  const days = [day("2026-11-20", [planned("A", "10:00", "14:00"), planned("B", "13:00", "17:00")])];
  const slip = slipOf(days, TODAY);
  const codes = slip.pending.map(p => p.code);
  assert.ok(codes.includes("wrongTimes"), "the overlap is reported as wrong times");
  assert.ok(!codes.includes("notCounted"), "and not also called an uncounted shift that is in the total");
  assert.equal(slip.days[0].uncounted, 0);
  assert.equal(slip.hoursMin, 0, "the overlapping hours are left out of the total");
  assertLaws(slip, days, cfg());
});
test("pending: a planned tasting with counts typed by hand is not to come; started or finished ones are not either", () => {
  const days = [day("2026-11-22", [
    planned("Counted", "09:00", "10:00", { adjS: 3 }),
    planned("Rejections only", "10:00", "11:00", { adjN: 1 }),
    planned("Flavour counted", "11:00", "12:00", { flavours: ["Lime"], adjF: [2] }),
    visit("Finished", "12:00", "13:00"),
    running("Started", "13:00"),
    planned("Really to come", "14:00", "16:00")
  ])];
  const slip = slipOf(days, TODAY);
  const toCome = slip.pending.find(p => p.code === "toCome");
  assert.deepEqual(toCome, { code: "toCome", count: 1, minutes: 120, date: "2026-11-22" });
  assert.equal(slip.days[0].planned, 1);
  assert.deepEqual(slip.pending.map(p => p.code), ["running", "toCome", "open"]);
});
test("pending: a planned tasting with wrong times is a shift to come but adds no minutes", () => {
  const days = [
    day("2026-11-22", [planned("Backwards", "15:00", "14:00"), planned("Good", "09:00", "12:00")]),
    day("2026-11-23", [planned("No end", "10:00", "")]),
    day("2026-11-24", [planned("One", "10:00", "13:00"), planned("Two", "12:00", "14:00")])   // they overlap
  ];
  const slip = slipOf(days, TODAY);
  assert.deepEqual(slip.pending, [
    { code: "wrongTimes", count: 3, date: "2026-11-22" },
    { code: "toCome", count: 5, minutes: 180, date: "2026-11-22" },
    { code: "open", count: 8, date: "2026-11-29" }
  ]);
  assert.equal(slip.hoursMin, 180);
  assert.deepEqual(slip.days.map(d => [d.planned, d.wrongTimes]), [[2, true], [1, true], [2, true]]);
  assertLaws(slip, days, cfg());
});
test("pending: every reason together, in a fixed order, each with its own count and date", () => {
  const days = [
    day("2026-11-17", [visit("Wrong", "15:00", "14:00")]),
    day("2026-11-18", [visit("A", "10:00", "14:00")], { legs: [leg("Home", "A", null), leg("A", "Home", null)] }),
    day("2026-11-19", [visit("Wrong again", "10:00", "")]),
    day(TODAY, [running("Now", "10:00", "SSN")], { legs: [leg("Home", "Now", null)] }),
    day("2026-11-25", [planned("Later", "10:00", "13:15")]),
    day("2026-11-28", [planned("Later still", "16:00", "19:00")])
  ];
  const slip = slipOf(days, TODAY);
  assert.deepEqual(slip.pending, [
    { code: "running", count: 1, date: TODAY, inTotal: false },
    { code: "wrongTimes", count: 2, date: "2026-11-17" },
    { code: "missingKm", count: 3, date: "2026-11-18" },
    { code: "toCome", count: 2, minutes: 375, date: "2026-11-25" },
    { code: "open", count: 8, date: "2026-11-29" }
  ]);
  assert.equal(slip.final, false);
  assert.equal(slip.isCurrent, true);
  assertLaws(slip, days, cfg());
  const text = report.payslipText(slip);
  assertClean(text);
  assert.equal(text.split("\n\nNOT FINAL YET\n")[1], [
    "- A tasting is still running. Its hours are not in the total yet.",
    "- 2 days have a tasting with wrong times. Those hours are not in the total.",
    "- 3 trips have no km yet. They are not in the total.",
    "- 2 shifts are still to work (6.25 h). They are already in the total.",
    "- This fortnight ends on Sun 29 Nov."
  ].join("\n"));
});

/* ── payslipData: which period ────────────────────────── */
test("isCurrent and isFuture for a past, the current and a future fortnight", () => {
  const flags = date => { const s = slipOf([], date); return [s.start, s.end, s.isCurrent, s.isFuture]; };
  assert.deepEqual(flags("2026-11-15"), ["2026-11-02", "2026-11-15", false, false]);
  assert.deepEqual(flags("2026-11-16"), ["2026-11-16", "2026-11-29", true, false]);
  assert.deepEqual(flags("2026-11-29"), ["2026-11-16", "2026-11-29", true, false]);
  assert.deepEqual(flags("2026-11-30"), ["2026-11-30", "2026-12-13", false, true]);
  // the edges of "current": today on the first and on the last day
  assert.equal(slipOf([], "2026-11-20", "2026-11-16").isCurrent, true);
  assert.equal(slipOf([], "2026-11-20", "2026-11-29").isCurrent, true);
  assert.equal(slipOf([], "2026-11-20", "2026-11-15").isFuture, true);
  assert.equal(slipOf([], "2026-11-20", "2026-11-30").isCurrent, false);
  assert.equal(slipOf([], "2026-11-20", "2026-11-30").isFuture, false);
});
test("a weekly pay period: seven days, its own key, only that week's work", () => {
  const config = cfg({ payPeriod: { days: 7, anchor: "2026-09-21" }, paid: { "2026-11-09:7": 16688, "2026-11-09:14": 1, "2026-11-02:14": 2 } });
  const days = [
    day("2026-11-08", [visit("Week before", "10:00", "13:00")]),
    day("2026-11-14", [visit("This week", "10:00", "14:00")]),
    day("2026-11-16", [visit("Week after", "10:00", "13:00")])
  ];
  const slip = slipOf(days, "2026-11-12", TODAY, config);
  assert.equal(slip.start, "2026-11-09");
  assert.equal(slip.end, "2026-11-15");
  assert.equal(slip.periodDays, 7);
  assert.equal(slip.paidKey, "2026-11-09:7");
  assert.equal(slip.totalCents, 16688);
  assert.equal(slip.paidCents, 16688);
  assert.deepEqual(slip.verdict, { status: "match", diffCents: 0 });
  assert.deepEqual(slip.days.map(d => d.date), ["2026-11-14"]);
  assertLaws(slip, days, config);
  // the current week: open, with the days left in the week
  const now = slipOf(days, TODAY, TODAY, config);
  assert.deepEqual([now.start, now.end, now.isCurrent], ["2026-11-16", "2026-11-22", true]);
  assert.deepEqual(now.pending, [{ code: "open", count: 1, date: "2026-11-22" }]);
});
test("a fortnight that starts on a Wednesday (the anchor is not a Monday), before and after the anchor", () => {
  const config = cfg({ payPeriod: { days: 14, anchor: "2026-09-23" } });
  const at = date => { const s = slipOf([], date, TODAY, config); return [s.start, s.end, s.paidKey]; };
  assert.deepEqual(at(TODAY), ["2026-11-18", "2026-12-01", "2026-11-18:14"]);
  assert.deepEqual(at("2026-11-18"), ["2026-11-18", "2026-12-01", "2026-11-18:14"]);
  assert.deepEqual(at("2026-11-17"), ["2026-11-04", "2026-11-17", "2026-11-04:14"]);
  assert.deepEqual(at("2026-09-23"), ["2026-09-23", "2026-10-06", "2026-09-23:14"]);
  assert.deepEqual(at("2026-09-22"), ["2026-09-09", "2026-09-22", "2026-09-09:14"]);
  assert.deepEqual(at("2026-09-01"), ["2026-08-26", "2026-09-08", "2026-08-26:14"]);
  const days = [day("2026-11-17", [visit("Old", "10:00", "13:00")]), day("2026-11-18", [visit("New", "10:00", "14:00")])];
  const slip = slipOf(days, TODAY, TODAY, config);
  assert.deepEqual(slip.days.map(d => d.stores), [["New"]]);
  assert.deepEqual(slip.pending, [{ code: "open", count: 10, date: "2026-12-01" }]);
  assertLaws(slip, days, config);
});
test("every day of a year lands in a period that holds it, 14 days long and back to back", () => {
  let prevEnd = null;
  for (let i = 0; i < 400; i++) {
    const date = pay.addDays("2026-06-01", i);
    const s = slipOf([], date);
    assert.ok(s.start <= date && date <= s.end, date);
    assert.equal(pay.daysBetween(s.start, s.end), 13, date);
    assert.equal(pay.weekdayOf(s.start), 1, date);
    if (prevEnd && s.end !== prevEnd) assert.equal(s.start, pay.addDays(prevEnd, 1), date);
    prevEnd = s.end;
  }
});

/* ── payslipData: the amount typed from the real payslip ─ */
const paidDays = () => [day("2026-11-07", [visit("A", "10:00", "14:00")])];       // $166.88
test("paid: read from config.paid under this period's key", () => {
  const at = cents => slipOf(paidDays(), PAST, TODAY, cfg({ paid: { "2026-11-02:14": cents } }));
  assert.equal(at(16688).paidKey, "2026-11-02:14");
  assert.equal(at(16688).paidCents, 16688);
  assert.deepEqual(at(16688).verdict, { status: "match", diffCents: 0 });
  assert.deepEqual(at(16693).verdict, { status: "match", diffCents: 5 });
  assert.deepEqual(at(16683).verdict, { status: "match", diffCents: -5 });
  assert.deepEqual(at(16682).verdict, { status: "short", diffCents: -6 });
  assert.deepEqual(at(16694).verdict, { status: "over", diffCents: 6 });
  assert.deepEqual(at(0).verdict, { status: "short", diffCents: -16688 });
  assert.equal(at(0).paidCents, 0, "a typed 0 is an amount, not nothing");
});
test("paid: ignored under the wrong key, and when it is not a number", () => {
  const unchecked = paid => {
    const slip = slipOf(paidDays(), PAST, TODAY, cfg({ paid }));
    assert.equal(slip.paidCents, null);
    assert.deepEqual(slip.verdict, { status: "unchecked", diffCents: 0 });
    assert.equal(slip.paidKey, "2026-11-02:14");
  };
  unchecked({});
  unchecked({ "2026-11-02:7": 16688 });               // the week of the same start
  unchecked({ "2026-11-16:14": 16688, "2026-10-19:14": 16688 });   // the neighbours
  unchecked({ "2026-11-02": 16688 });
  unchecked({ "2026-11-02:14": "16688" });
  unchecked({ "2026-11-02:14": null });
  // a config with no paid list at all (never passed through withConfigDefaults)
  const bare = report.payslipData(paidDays(), { payPeriod: { days: 14, anchor: "2026-09-21" } }, hol(), PAST, TODAY);
  assert.equal(bare.paidCents, null);
  assert.equal(bare.totalCents, 16688);
});
test("payslip value survives a JSON round trip, with and without a typed amount", () => {
  const config = richConfig({ paid: { "2026-11-02:14": 153000, "2026-11-16:14": 5 } });
  for (const date of ["2026-11-10", TODAY, "2026-12-01", "2026-06-01"]) {
    const days = richDays().concat([day("2026-11-25", [planned("P", "10:00", "13:00")]), day(TODAY, [running("R", "10:00")])]);
    const slip = slipOf(days, date, TODAY, config);
    assert.deepEqual(clone(slip), slip, date);
    for (const p of slip.pending) assert.ok(Object.values(p).every(x => x !== undefined), date);
  }
  const past = slipOf(richDays(), "2026-11-10", TODAY, config);
  assert.deepEqual(past.verdict, { status: "short", diffCents: -196 });
});
test("an empty period: zeros everywhere, final when it is over", () => {
  const slip = slipOf([], PAST);
  assert.deepEqual(slip, {
    start: "2026-11-02", end: "2026-11-15", periodDays: 14, isCurrent: false, isFuture: false,
    lines: [], hoursMin: 0, hoursCents: 0, kmLines: [], kmTenths: 0, kmCents: 0, parkingCents: 0,
    extrasCents: 0, totalCents: 0, days: [], daysSumCents: 0, roundingCents: 0,
    pending: [], final: true, paidKey: "2026-11-02:14", paidCents: null,
    verdict: { status: "unchecked", diffCents: 0 }
  });
  assert.deepEqual(slipOf(undefined, PAST), slip);
  assert.deepEqual(slipOf([null, day("2026-11-10", [])], PAST), slip);
});
test("a day with only parking, or only trips, is a row with no tasting", () => {
  const days = [
    day("2026-11-04", [], { parking: [park(1234)] }),
    day("2026-11-06", [], { legs: [leg("Home", "Depot", 42)] })
  ];
  const slip = slipOf(days, PAST);
  assert.deepEqual(slip.days.map(d => [d.date, d.stores, d.hoursMin, d.totalCents]), [
    ["2026-11-04", [], 0, 1234], ["2026-11-06", [], 0, 420]
  ]);
  assert.equal(slip.totalCents, 1654);
  assertLaws(slip, days, cfg());
  const text = report.payslipText(slip);
  assert.ok(text.includes("Wed 4 Nov — No tasting\n  0.00 h = $0.00 · travel $0.00 · parking $12.34 · day $12.34\n"));
  assertClean(text);
});

/* ── pendingText, dayFlags ────────────────────────────── */
test("pendingText: every reason, one and many", () => {
  const say = (item, word) => report.pendingText(item, word);
  assert.equal(say({ code: "running", count: 1, date: "2026-11-21" }), "A tasting is still running. Its hours are not in the total yet.");
  assert.equal(say({ code: "running", count: 2, date: "2026-11-21" }), "A tasting is still running. Its hours are not in the total yet.");
  assert.equal(say({ code: "running", count: 1, date: "2026-11-21", inTotal: true }), "A tasting is still running. Its shift hours are already in the total.");
  assert.equal(say({ code: "wrongTimes", count: 1, date: "2026-11-21" }), "1 day has a tasting with wrong times. Those hours are not in the total.");
  assert.equal(say({ code: "wrongTimes", count: 2, date: "2026-11-21" }), "2 days have a tasting with wrong times. Those hours are not in the total.");
  assert.equal(say({ code: "missingKm", count: 1, date: "2026-11-21" }), "1 trip has no km yet. It is not in the total.");
  assert.equal(say({ code: "missingKm", count: 4, date: "2026-11-21" }), "4 trips have no km yet. They are not in the total.");
  assert.equal(say({ code: "toCome", count: 1, minutes: 180, date: "2026-11-21" }), "1 shift is still to work (3.00 h). It is already in the total.");
  assert.equal(say({ code: "toCome", count: 2, minutes: 450, date: "2026-11-21" }), "2 shifts are still to work (7.50 h). They are already in the total.");
  assert.equal(say({ code: "toCome", count: 1, minutes: 0, date: "2026-11-21" }), "1 shift is still to work (0.00 h). It is already in the total.");
});
test("pendingText: when the period ends, said with the right word; today is its own sentence", () => {
  const open = count => ({ code: "open", count, date: "2026-11-29" });
  assert.equal(report.pendingText(open(8)), "This fortnight ends on Sun 29 Nov.");
  assert.equal(report.pendingText(open(1)), "This fortnight ends on Sun 29 Nov.");
  assert.equal(report.pendingText(open(0)), "This fortnight ends today.");
  assert.equal(report.pendingText(open(3), "week"), "This week ends on Sun 29 Nov.");
  assert.equal(report.pendingText(open(0), "week"), "This week ends today.");
  assert.equal(report.pendingText({ code: "somethingNew", count: 1, date: "2026-11-29" }), "");
});
test("pendingText: every real pending item reads as a clean sentence", () => {
  const days = [
    day("2026-11-17", [visit("Wrong", "15:00", "14:00")], { legs: [leg("Home", "A", null)] }),
    day(TODAY, [running("Now", "10:00")]),
    day("2026-11-29", [planned("Later", "10:00", "13:00")])
  ];
  for (const today of [TODAY, "2026-11-29"]) {
    const slip = slipOf(days, TODAY, today);
    assert.equal(slip.pending.length, 5);
    for (const p of slip.pending) {
      const s = report.pendingText(p);
      assert.ok(/^[A-Z0-9].*\.$/.test(s), s);
      assertClean(s);
    }
  }
  assert.equal(report.pendingText(slipOf(days, TODAY, "2026-11-29").pending[4]), "This fortnight ends today.");
});
test("dayFlags: what a day still needs, in a fixed order", () => {
  const row = (over = {}) => ({ planned: 0, running: false, wrongTimes: false, missingKm: 0, ...over });
  assert.deepEqual(report.dayFlags(row()), []);
  assert.deepEqual(report.dayFlags(row({ planned: 1 })), ["still to work"]);
  assert.deepEqual(report.dayFlags(row({ planned: 3 })), ["still to work"]);
  assert.deepEqual(report.dayFlags(row({ running: true })), ["not finished"]);
  assert.deepEqual(report.dayFlags(row({ wrongTimes: true })), ["wrong times"]);
  assert.deepEqual(report.dayFlags(row({ missingKm: 2 })), ["km missing"]);
  assert.deepEqual(report.dayFlags(row({ planned: 1, running: true, wrongTimes: true, missingKm: 1 })),
    ["still to work", "not finished", "wrong times", "km missing"]);
});
test("dayFlags of real payslip rows", () => {
  const days = [
    day("2026-11-18", [visit("A", "10:00", "14:00")], { legs: [leg("Home", "A", null)] }),
    day("2026-11-19", [visit("B", "10:00", "14:00")]),
    day(TODAY, [running("C", "10:00")]),
    day("2026-11-22", [planned("D", "15:00", "14:00")])
  ];
  assert.deepEqual(slipOf(days, TODAY).days.map(report.dayFlags),
    [["km missing"], [], ["not finished"], ["still to work", "wrong times"]]);
});

/* ── payslipText ──────────────────────────────────────── */
// 19 Oct – 1 Nov 2026, all done: a Saturday with two tastings, two Sundays, a Friday.
const doneFortnight = () => [
  day("2026-11-01", [visit("Dan Murphy's Kew", "10:00", "13:15", taps(5, 5))]),
  day("2026-10-24", [
    visit("Liquorland Fitzroy", "15:00", "18:00", taps(10, 5)),
    visit("BWS Carlton", "10:00", "14:00", taps(27, 16))
  ], {
    legs: [leg("Home", "BWS Carlton", 124), leg("BWS Carlton", "Liquorland Fitzroy", 87), leg("Liquorland Fitzroy", "Home", 151)],
    parking: [park(650)]
  }),
  day("2026-10-25", [visit("Dan Murphy's Kew", "10:00", "13:15")]),
  day("2026-10-30", [visit("Bottle-O", "16:00", "19:00")], { kmDay: 200, legs: [leg("Home", "Bottle-O", null), leg("Bottle-O", "Home", null)] })
];
const DONE_TEXT = [
  "Payslip — Mon 19 Oct to Sun 1 Nov 2026",
  "",
  "HOURS",
  "Weekday: 3.00 h × $34.76 = $104.28",
  "Saturday: 7.00 h × $41.72 = $292.04",
  "Sunday: 6.50 h × $48.67 = $316.36",
  "Total hours: 16.50 h",
  "Pay for hours: $712.68",
  "",
  "TRAVEL AND PARKING",
  "Travel: 56.2 km × $1.00 = $56.20",
  "Parking: $6.50",
  "",
  "TOTAL PAYOUT, BEFORE TAX: $775.38",
  "",
  "DAY BY DAY",
  "Sat 24 Oct — BWS Carlton, Liquorland Fitzroy",
  "  7.00 h = $292.04 · travel $36.20 · parking $6.50 · day $334.74",
  "Sun 25 Oct — Dan Murphy's Kew",
  "  3.25 h = $158.18 · travel $0.00 · parking $0.00 · day $158.18",
  "Fri 30 Oct — Bottle-O",
  "  3.00 h = $104.28 · travel $20.00 · parking $0.00 · day $124.28",
  "Sun 1 Nov — Dan Murphy's Kew",
  "  3.25 h = $158.18 · travel $0.00 · parking $0.00 · day $158.18"
].join("\n");

test("payslip text: one complete past fortnight, the whole text", () => {
  const slip = slipOf(doneFortnight(), "2026-10-28");
  assert.equal(slip.final, true);
  assert.equal(slip.roundingCents, 0);
  assert.equal(slip.totalCents, 77538);
  assert.equal(report.payslipText(slip), DONE_TEXT);
  assertLaws(slip, doneFortnight(), cfg());
});
test("payslip text is the same after the payslip went through JSON", () => {
  const slip = slipOf(doneFortnight(), "2026-10-28", TODAY, cfg({ paid: { "2026-10-19:14": 77000 } }));
  assert.equal(report.payslipText(clone(slip)), report.payslipText(slip));
});
test("payslip text: the NOT FINAL lines appear with a reason and go when it is fixed", () => {
  const days = doneFortnight();
  days[3].kmDay = null;                               // the Friday now has two trips with no km
  const open = slipOf(days, "2026-10-28");
  const text = report.payslipText(open);
  const lines = text.split("\n");
  assert.equal(lines[0], "Payslip — Mon 19 Oct to Sun 1 Nov 2026");
  assert.equal(lines[1], "NOT FINAL YET — see the end");
  assert.equal(lines[2], "");
  assert.equal(lines[3], "HOURS");
  assert.ok(text.endsWith("\n\nNOT FINAL YET\n- 2 trips have no km yet. They are not in the total."));
  assert.ok(text.includes("Fri 30 Oct — Bottle-O\n  3.00 h = $104.28 · travel $0.00 · parking $0.00 · day $104.28 (km missing)\n"));
  assert.ok(text.includes("TOTAL PAYOUT, BEFORE TAX: $755.38"));
  assertClean(text);

  days[3].legs[0].tenths = 100; days[3].legs[1].tenths = 100;
  const fixed = report.payslipText(slipOf(days, "2026-10-28"));
  assert.equal(fixed, DONE_TEXT);
  assert.ok(!fixed.includes("NOT FINAL"));
});
test("payslip text: the current fortnight says when it ends; flags sit on the day rows", () => {
  const days = [
    day("2026-11-17", [visit("Done", "10:00", "14:00")]),
    day(TODAY, [running("Now", "10:00", "S")]),
    day("2026-11-28", [planned("Later", "10:00", "13:00"), planned("Wrong", "15:00", "14:00")], { legs: [leg("Home", "Later", null)] })
  ];
  const text = report.payslipText(slipOf(days, TODAY));
  assert.equal(text, [
    "Payslip — Mon 16 Nov to Sun 29 Nov 2026",
    "NOT FINAL YET — see the end",
    "",
    "HOURS",
    "Weekday: 4.00 h × $34.76 = $139.04",
    "Saturday: 3.00 h × $41.72 = $125.16",
    "Total hours: 7.00 h",
    "Pay for hours: $264.20",
    "",
    "TRAVEL AND PARKING",
    "Travel: 0.0 km = $0.00",
    "Parking: $0.00",
    "",
    "TOTAL PAYOUT, BEFORE TAX: $264.20",
    "",
    "DAY BY DAY",
    "Tue 17 Nov — Done",
    "  4.00 h = $139.04 · travel $0.00 · parking $0.00 · day $139.04",
    "Sat 21 Nov — Now",
    "  0.00 h = $0.00 · travel $0.00 · parking $0.00 · day $0.00 (not finished)",
    "Sat 28 Nov — Later, Wrong",
    "  3.00 h = $125.16 · travel $0.00 · parking $0.00 · day $125.16 (still to work, wrong times, km missing)",
    "",
    "NOT FINAL YET",
    "- A tasting is still running. Its hours are not in the total yet.",
    "- 1 day has a tasting with wrong times. Those hours are not in the total.",
    "- 1 trip has no km yet. It is not in the total.",
    "- 2 shifts are still to work (3.00 h). They are already in the total.",
    "- This fortnight ends on Sun 29 Nov."
  ].join("\n"));
  const last = report.payslipText(slipOf(days, TODAY, "2026-11-29"));
  assert.ok(last.endsWith("\n- This fortnight ends today."));
});
test("payslip text: a week says week", () => {
  const config = cfg({ payPeriod: { days: 7, anchor: "2026-09-21" } });
  const days = [day("2026-11-22", [visit("A", "10:00", "10:45")]), day("2026-11-21", [visit("B", "10:00", "10:45")], { paidAs: "sunday" })];
  const text = report.payslipText(slipOf(days, TODAY, TODAY, config));
  assert.equal(text.split("\n")[0], "Payslip — Mon 16 Nov to Sun 22 Nov 2026");
  assert.ok(text.includes("\nRounding: $0.01 (the week is rounded once per line, not day by day)\n"));
  assert.ok(text.endsWith("\n- This week ends on Sun 22 Nov."));
  assert.ok(report.payslipText(slipOf(days, TODAY, "2026-11-22", config)).endsWith("\n- This week ends today."));
});
test("payslip text: the Rounding line only when the days do not add up to the total", () => {
  const minus = report.payslipText(slipOf(threeSundays(), "2026-11-08"));
  assert.ok(minus.endsWith([
    "Sun 15 Nov — C",
    "  3.25 h = $158.18 · travel $0.00 · parking $0.00 · day $158.18",
    "Rounding: -$0.01 (the fortnight is rounded once per line, not day by day)"
  ].join("\n")));
  assert.ok(minus.includes("\nSunday: 9.75 h × $48.67 = $474.53\n"));
  assert.ok(minus.includes("\nTOTAL PAYOUT, BEFORE TAX: $474.53\n"));

  const plus = report.payslipText(slipOf(
    [day("2026-11-08", [visit("A", "10:00", "10:45")]), day("2026-11-15", [visit("B", "10:00", "10:45")])], "2026-11-08"));
  assert.ok(plus.endsWith("\nRounding: $0.01 (the fortnight is rounded once per line, not day by day)"));

  assert.ok(!DONE_TEXT.includes("Rounding"));
  assert.ok(!report.payslipText(slipOf(doneFortnight(), "2026-10-28")).includes("Rounding"));
});
test("payslip text: two rates of one kind and two km rates each get a line; thousands have a comma", () => {
  const text = report.payslipText(slipOf(richDays(), "2026-11-10", TODAY, richConfig()));
  const block = text.split("\n\n");
  assert.equal(block[0], "Payslip — Mon 2 Nov to Sun 15 Nov 2026\nNOT FINAL YET — see the end");
  assert.equal(block[1], [
    "HOURS",
    "Weekday: 2.50 h × $34.76 = $86.90",
    "Saturday: 7.00 h × $41.72 = $292.04",
    "Saturday: 7.17 h × $43.00 = $308.17",
    "Sunday: 9.00 h × $48.67 = $438.03",
    "Public holiday: 4.00 h × $69.53 = $278.12",
    "Total hours: 29.67 h",
    "Pay for hours: $1,403.26"
  ].join("\n"));
  assert.equal(block[2], [
    "TRAVEL AND PARKING",
    "Travel: 41.2 km × $1.00 = $41.20",
    "Travel: 65.0 km × $1.10 = $71.50",
    "Parking: $16.00"
  ].join("\n"));
  assert.equal(block[3], "TOTAL PAYOUT, BEFORE TAX: $1,531.96");
  assert.ok(block[4].startsWith("DAY BY DAY\nTue 3 Nov — Cup Day Cellars\n  4.00 h = $278.12 · travel $0.00 · parking $0.00 · day $278.12\n"));
  assert.ok(block[4].includes("\nWed 11 Nov — IGA Liquor\n  2.50 h = $121.68 · travel $25.63 · parking $0.00 · day $147.31\n"));
  assert.ok(block[4].endsWith("\nRounding: -$0.01 (the fortnight is rounded once per line, not day by day)"));
  assert.equal(block[5], "NOT FINAL YET\n- 2 trips have no km yet. They are not in the total.");
  assert.equal(block.length, 6);
  assertClean(text);
});
test("payslip text: \"My real payslip says\" for a match, short and over; absent when nothing was typed", () => {
  const says = cents => {
    const text = report.payslipText(slipOf(doneFortnight(), "2026-10-28", TODAY, cfg({ paid: { "2026-10-19:14": cents } })));
    assert.ok(text.startsWith(DONE_TEXT + "\n\nMy real payslip says: "), text);
    assertClean(text);
    return text.slice(DONE_TEXT.length + 2);
  };
  assert.equal(says(77538), "My real payslip says: $775.38 — matches");
  assert.equal(says(77541), "My real payslip says: $775.41 — matches");
  assert.equal(says(77533), "My real payslip says: $775.33 — matches");
  assert.equal(says(77000), "My real payslip says: $770.00 — $5.38 less than this total");
  assert.equal(says(77532), "My real payslip says: $775.32 — $0.06 less than this total");
  assert.equal(says(80000), "My real payslip says: $800.00 — $24.62 more than this total");
  assert.equal(says(0), "My real payslip says: $0.00 — $775.38 less than this total");
  assert.ok(!DONE_TEXT.includes("My real payslip"));
  assert.ok(!report.payslipText(slipOf(doneFortnight(), "2026-10-28", TODAY, cfg({ paid: { "2026-10-19:7": 77538 } }))).includes("My real payslip"));
});
test("payslip text: the typed amount comes after the NOT FINAL lines", () => {
  const days = [day("2026-11-17", [visit("A", "10:00", "14:00")])];
  const text = report.payslipText(slipOf(days, TODAY, TODAY, cfg({ paid: { "2026-11-16:14": 13904 } })));
  assert.ok(text.endsWith("\n\nNOT FINAL YET\n- This fortnight ends on Sun 29 Nov.\n\nMy real payslip says: $139.04 — matches"));
});
test("payslip text: an empty period still prints the hours, travel and total headings", () => {
  const past = report.payslipText(slipOf([], PAST));
  assert.equal(past.split("\n")[0], "Payslip — Mon 2 Nov to Sun 15 Nov 2026");
  for (const want of ["\nHOURS\nNo hours yet\nTotal hours: 0.00 h\nPay for hours: $0.00\n",
    "\nTRAVEL AND PARKING\nTravel: 0.0 km = $0.00\nParking: $0.00\n", "\nTOTAL PAYOUT, BEFORE TAX: $0.00"]) {
    assert.ok(past.includes(want), want + " missing in:\n" + past);
  }
  assert.ok(!past.includes("NOT FINAL"));
  assert.ok(!past.includes("Rounding"));
  assert.ok(!past.includes("My real payslip"));
  assertClean(past);

  const now = report.payslipText(slipOf([], TODAY));
  assert.ok(now.startsWith("Payslip — Mon 16 Nov to Sun 29 Nov 2026\nNOT FINAL YET — see the end\n\nHOURS\n"));
  assert.ok(now.endsWith("\n\nNOT FINAL YET\n- This fortnight ends on Sun 29 Nov."));
  assertClean(now);

  const typed = report.payslipText(slipOf([], PAST, TODAY, cfg({ paid: { "2026-11-02:14": 5000 } })));
  assert.ok(typed.endsWith("\n\nMy real payslip says: $50.00 — $50.00 more than this total"));
  assertClean(typed);
});
test("payslip text never says undefined, NaN or null, whatever the days look like", () => {
  const odd = [
    day("2026-11-16", [{ id: "x1", placeName: "", paidStart: "10:00", paidEnd: "12:00" }]),              // a bare tasting
    day("2026-11-17", [visit("", "", "")]),
    day("2026-11-18", [visit("A", "10:00", "14:00", "", { breakMin: 500 })]),
    day("2026-11-19", [planned("B", "", "")], { legs: [leg("", "", null)], parking: [{ id: "k", cents: null }] }),
    day("2026-11-20", [running("C", "")], { kmDay: 0, legs: [leg("Home", "C", null)] }),
    { date: "2026-11-22", visits: [visit("D", "23:00", "23:59")] },                                      // no legs, no parking list
    day("2026-11-23", [visit("E", "00:00", "23:59")]),                                                   // too long
    day("2026-11-24", [planned("F", "09:00", "17:00", { breakMin: 30, brand: "Jameson", flavours: ["Lime"] })])
  ];
  for (const config of [cfg(), cfg({ payPeriod: { days: 7, anchor: "2026-09-21" } }), cfg({ paid: { "2026-11-16:14": 1 } })]) {
    for (const today of ["2026-11-01", "2026-11-16", TODAY, "2026-11-29", "2026-12-25"]) {
      for (const date of ["2026-11-16", "2026-11-23"]) {
        const slip = report.payslipData(odd, config, hol(), date, today);
        assertLaws(slip, odd, config);
        assertClean(report.payslipText(slip));
        for (const p of slip.pending) assertClean(report.pendingText(p, slip.periodDays === 14 ? "fortnight" : "week"));
      }
    }
  }
});

/* ── paidHistory ──────────────────────────────────────── */
const historyDays = () => [
  day("2026-11-17", [visit("Current", "10:00", "14:00")]),                         // 16–29 Nov, the current one
  day("2026-11-07", [visit("A", "10:00", "14:00")]),                               // 2–15 Nov: $166.88
  // 19 Oct – 1 Nov: nothing
  // 5–18 Oct: nothing, but an amount was typed
  day("2026-09-26", [visit("B", "10:00", "13:00")], { legs: [leg("Home", "B", null)] }),   // 21 Sep – 4 Oct: km missing
  day("2026-09-13", [visit("C", "10:00", "13:15")]),                               // 7–20 Sep: Sunday 3 h 15
  day("2026-08-29", [visit("D", "10:00", "14:00")])                                // 24 Aug – 6 Sep
];
const historyConfig = () => cfg({ paid: { "2026-11-02:14": 16000, "2026-10-05:14": 2500, "2026-09-07:14": 15820, "2026-11-16:14": 99, "2026-10-19:7": 77 } });

test("paid history: finished periods, newest first, with what was expected and what was paid", () => {
  const h = report.paidHistory(historyDays(), historyConfig(), hol(), TODAY);
  assert.deepEqual(h, [
    { start: "2026-11-02", end: "2026-11-15", expectedCents: 16688, hoursMin: 240, paidCents: 16000, status: "short", diffCents: -688, notFinal: false },
    { start: "2026-10-05", end: "2026-10-18", expectedCents: 0, hoursMin: 0, paidCents: 2500, status: "over", diffCents: 2500, notFinal: false },
    { start: "2026-09-21", end: "2026-10-04", expectedCents: 12516, hoursMin: 180, paidCents: null, status: "unchecked", diffCents: 0, notFinal: true },
    { start: "2026-09-07", end: "2026-09-20", expectedCents: 15818, hoursMin: 195, paidCents: 15820, status: "match", diffCents: 2, notFinal: false },
    { start: "2026-08-24", end: "2026-09-06", expectedCents: 16688, hoursMin: 240, paidCents: null, status: "unchecked", diffCents: 0, notFinal: false }
  ]);
  assert.deepEqual(clone(h), h);
});
test("paid history: the current period is never in it, even on its last day; the day after it is", () => {
  const starts = today => report.paidHistory(historyDays(), historyConfig(), hol(), today).map(p => p.start);
  assert.ok(!starts(TODAY).includes("2026-11-16"));
  assert.ok(!starts("2026-11-16").includes("2026-11-16"));
  assert.ok(!starts("2026-11-29").includes("2026-11-16"));
  assert.equal(starts("2026-11-30")[0], "2026-11-16");
  assert.deepEqual(report.paidHistory(historyDays(), historyConfig(), hol(), "2026-11-30")[0],
    { start: "2026-11-16", end: "2026-11-29", expectedCents: 13904, hoursMin: 240, paidCents: 99, status: "short", diffCents: -13805, notFinal: false });
});
test("paid history: an empty period with nothing typed is left out; one with a typed amount is kept", () => {
  const starts = report.paidHistory(historyDays(), historyConfig(), hol(), TODAY).map(p => p.start);
  assert.ok(!starts.includes("2026-10-19"), "empty, and the only amount is under the weekly key");
  assert.ok(starts.includes("2026-10-05"));
  assert.deepEqual(report.paidHistory([], cfg(), hol(), TODAY), []);
  assert.deepEqual(report.paidHistory(undefined, cfg(), hol(), TODAY), []);
  assert.deepEqual(report.paidHistory([day("2026-11-07", [])], cfg(), hol(), TODAY), [], "a stored day with nothing on it is no work");
  assert.deepEqual(report.paidHistory([], cfg({ paid: { "2026-11-02:14": 0 } }), hol(), TODAY).map(p => [p.start, p.paidCents, p.status]),
    [["2026-11-02", 0, "match"]]);
});
test("paid history: stops at count (6 unless told otherwise)", () => {
  const starts = count => report.paidHistory(historyDays(), historyConfig(), hol(), TODAY, count).map(p => p.start);
  assert.deepEqual(starts(1), ["2026-11-02"]);
  assert.deepEqual(starts(2), ["2026-11-02", "2026-10-05"]);
  assert.deepEqual(starts(3), ["2026-11-02", "2026-10-05", "2026-09-21"]);
  assert.deepEqual(starts(0), []);
  // nine worked fortnights in a row: the default is the newest six
  const many = [];
  for (let i = 1; i <= 9; i++) many.push(day(pay.addDays("2026-11-16", -14 * i + 5), [visit("S" + i, "10:00", "14:00")]));
  const six = report.paidHistory(many, cfg(), hol(), TODAY);
  assert.deepEqual(six.map(p => p.start), ["2026-11-02", "2026-10-19", "2026-10-05", "2026-09-21", "2026-09-07", "2026-08-24"]);
  assert.equal(report.paidHistory(many, cfg(), hol(), TODAY, 9).length, 9);
  assert.ok(six.every(p => p.expectedCents === 16688 && p.end === pay.addDays(p.start, 13)));
});
test("paid history: notFinal for missing km, a tasting left running and wrong times", () => {
  const flag = d => report.paidHistory([d], cfg(), hol(), TODAY)[0].notFinal;
  assert.equal(flag(day("2026-11-07", [visit("A", "10:00", "14:00")])), false);
  assert.equal(flag(day("2026-11-07", [visit("A", "10:00", "14:00")], { legs: [leg("Home", "A", null)] })), true);
  assert.equal(flag(day("2026-11-07", [visit("A", "10:00", "14:00")], { legs: [leg("Home", "A", null, { skip: true })] })), false);
  assert.equal(flag(day("2026-11-07", [visit("A", "10:00", "14:00")], { kmDay: 50, legs: [leg("Home", "A", null)] })), false);
  assert.equal(flag(day("2026-11-07", [running("A", "10:00")])), true);
  assert.equal(flag(day("2026-11-07", [visit("A", "15:00", "14:00")])), true);
});
test("paid history agrees with the payslip of each period", () => {
  const days = richDays().concat(doneFortnight()), config = richConfig({ paid: { "2026-11-02:14": 153196, "2026-10-19:14": 70000 } });
  const h = report.paidHistory(days, config, hol(), TODAY);
  assert.deepEqual(h.map(p => p.start), ["2026-11-02", "2026-10-19"]);
  for (const p of h) {
    const slip = report.payslipData(days, config, hol(), p.start, TODAY);
    assert.equal(p.end, slip.end);
    assert.equal(p.expectedCents, slip.totalCents);
    assert.equal(p.hoursMin, slip.hoursMin);
    assert.equal(p.paidCents, slip.paidCents);
    assert.deepEqual({ status: p.status, diffCents: p.diffCents }, slip.verdict);
    assert.equal(p.notFinal, !slip.final);
  }
  assert.deepEqual(h.map(p => p.status), ["match", "short"]);
});
test("paid history by the week: seven-day periods and the weekly keys", () => {
  const config = cfg({ payPeriod: { days: 7, anchor: "2026-09-21" }, paid: { "2026-11-09:7": 16688, "2026-11-02:14": 5 } });
  const days = [day("2026-11-14", [visit("A", "10:00", "14:00")]), day("2026-11-07", [visit("B", "10:00", "14:00")]), day("2026-11-17", [visit("Now", "10:00", "14:00")])];
  assert.deepEqual(report.paidHistory(days, config, hol(), TODAY).map(p => [p.start, p.end, p.paidCents, p.status]), [
    ["2026-11-09", "2026-11-15", 16688, "match"],
    ["2026-11-02", "2026-11-08", null, "unchecked"]
  ]);
});

/* ── periodChoices ────────────────────────────────────── */
test("periodChoices, fortnight: the two Monday fortnights that hold today, older first", () => {
  const both = [{ start: "2026-11-09", end: "2026-11-22" }, { start: "2026-11-16", end: "2026-11-29" }];
  assert.deepEqual(report.periodChoices("2026-11-16", 14), both, "a Monday");
  assert.deepEqual(report.periodChoices("2026-11-18", 14), both, "a Wednesday");
  assert.deepEqual(report.periodChoices("2026-11-22", 14), both, "a Sunday");
  assert.deepEqual(report.periodChoices("2026-11-18"), both, "14 unless told otherwise");
  assert.deepEqual(report.periodChoices("2026-11-23", 14),
    [{ start: "2026-11-16", end: "2026-11-29" }, { start: "2026-11-23", end: "2026-12-06" }]);
  assert.deepEqual(report.periodChoices("2026-11-15", 14),
    [{ start: "2026-11-02", end: "2026-11-15" }, { start: "2026-11-09", end: "2026-11-22" }]);
});
test("periodChoices, week: the one Monday-to-Sunday week", () => {
  assert.deepEqual(report.periodChoices("2026-11-16", 7), [{ start: "2026-11-16", end: "2026-11-22" }]);
  assert.deepEqual(report.periodChoices("2026-11-18", 7), [{ start: "2026-11-16", end: "2026-11-22" }]);
  assert.deepEqual(report.periodChoices("2026-11-22", 7), [{ start: "2026-11-16", end: "2026-11-22" }]);
  assert.deepEqual(report.periodChoices("2026-11-01", 7), [{ start: "2026-10-26", end: "2026-11-01" }]);
});
test("periodChoices: every choice starts on a Monday and holds today, across month, year and clock changes", () => {
  for (let i = 0; i < 500; i++) {
    const today = pay.addDays("2026-03-01", i);
    for (const n of [14, 7]) {
      const list = report.periodChoices(today, n);
      assert.equal(list.length, n === 14 ? 2 : 1);
      for (const p of list) {
        assert.equal(pay.weekdayOf(p.start), 1, today);
        assert.equal(pay.weekdayOf(p.end), 0, today);
        assert.equal(pay.daysBetween(p.start, p.end), n - 1, today);
        assert.ok(p.start <= today && today <= p.end, today);
      }
      if (n === 14) assert.equal(list[1].start, pay.addDays(list[0].start, 7), today);
    }
  }
});
test("periodChoices: a chosen start used as the anchor gives that period back", () => {
  for (const today of ["2026-11-16", "2026-11-18", "2026-11-22"]) {
    for (const n of [14, 7]) {
      for (const choice of report.periodChoices(today, n)) {
        const slip = report.payslipData([], cfg({ payPeriod: { days: n, anchor: choice.start, confirmed: true } }), hol(), today, today);
        assert.deepEqual([slip.start, slip.end, slip.isCurrent], [choice.start, choice.end, true]);
      }
    }
  }
});

/* ── rangeCounts with sold ────────────────────────────── */
// Lime and Mango. Taps: 3 Lime, 2 Mango and 1 plain sample, 2 rejected, 2 Lime sold, 1 plain sold.
// By hand: 1 more Lime sample, 1 Mango sold.  → samples 7 (Lime 4, Mango 2, plain 1), rejected 2, sold 4 (Lime 2, Mango 1, plain 1)
const flavoured = (placeName = "BWS Carlton", extra = {}) => visit6(placeName, "10:00", "14:00", "SSSSSSNNBBB", {
  brand: "Smirnoff", flavours: ["Lime", "Mango"], tapF: "00011---00-", adjF: [1, 0], adjBF: [0, 1], ...extra
});

test("rangeCounts: sold is added up, and never adds to the interactions", () => {
  const days = [
    day("2026-11-13", [visit6("A", "10:00", "14:00", "SSNBB", { adjB: 3 })]),
    day("2026-11-14", [flavoured(), visit("Old", "15:00", "18:00", taps(10, 5))]),
    day("2026-11-15", [visit6("C", "10:00", "13:00", "BbB")]),
    day("2026-11-16", [visit6("Out", "10:00", "13:00", "BBBB")])
  ];
  assert.deepEqual(report.rangeCounts(days, "2026-11-14", "2026-11-14"),
    { tastings: 2, talked: 24, sampled: 17, declined: 7, sold: 4, pct: 71 });
  assert.deepEqual(report.rangeCounts(days, "2026-11-13", "2026-11-15"),
    { tastings: 4, talked: 27, sampled: 19, declined: 8, sold: 11, pct: 70 });
  assert.deepEqual(report.rangeCounts(days, "2026-11-15", "2026-11-15"),
    { tastings: 1, talked: 0, sampled: 0, declined: 0, sold: 2, pct: null });
});
test("rangeCounts: every sample is one interaction, flavour by flavour; a correction cannot push a part below 0", () => {
  // one customer tries both flavours = 2 samples = 2 interactions
  const two = visit6("A", "10:00", "14:00", "SS", { flavours: ["Lime", "Mango"], tapF: "01" });
  assert.deepEqual(report.rangeCounts([day("2026-11-14", [two])], "2026-11-14", "2026-11-14"),
    { tastings: 1, talked: 2, sampled: 2, declined: 0, sold: 0, pct: 100 });
  // Lime −5 by hand with 1 tap is 0, not −4: Mango's 2 and its 3 sold still count
  const floor = visit6("A", "10:00", "14:00", "SSSBBB", { flavours: ["Lime", "Mango"], tapF: "011111", adjF: [-5, 0], adjBF: [-2, 0], adjB: -4 });
  assert.deepEqual(report.rangeCounts([day("2026-11-14", [floor])], "2026-11-14", "2026-11-14"),
    { tastings: 1, talked: 2, sampled: 2, declined: 0, sold: 3, pct: 100 });
});

/* ── dayReportText with flavours, sold and comments ───── */
test("day report: flavours, sold and customer comments; an old tasting beside it has no Sold line", () => {
  const d = day("2026-11-14", [
    visit("Liquorland Fitzroy", "15:00", "18:00", taps(10, 5)),
    flavoured("BWS Carlton", { comments: "  Loved the  Lime.\nWanted a bigger bottle  " })
  ]);
  assert.equal(report.dayReportText(d, cfg()), [
    "Tasting day report — Sat 14 Nov 2026",
    "",
    "1. BWS Carlton",
    "Brand: Smirnoff",
    "Time: 10:00 am – 2:00 pm",
    "Total interactions: 9",
    "Samples given: 7",
    "  Lime: 4",
    "  Mango: 2",
    "  No flavour: 1",
    "Rejected or ignored: 2",
    "Sold: 4",
    "  Lime: 2",
    "  Mango: 1",
    "  No flavour: 1",
    "Customer comments: Loved the Lime. Wanted a bigger bottle",
    "",
    "2. Liquorland Fitzroy",
    "Time: 3:00 pm – 6:00 pm",
    "Total interactions: 15",
    "Samples given: 10",
    "Rejected or ignored: 5",
    "",
    "Total for the day",
    "Total interactions: 24",
    "Samples given: 17",
    "Rejected or ignored: 7",
    "Sold: 4"
  ].join("\n"));
});
test("day report: each tasting's lines are exactly model.countLines", () => {
  const a = flavoured("A", { comments: "Nice" }), b = visit6("B", "15:00", "18:00", "SNB");
  const blocks = report.dayReportText(day("2026-11-14", [a, b]), cfg()).split("\n\n");
  assert.equal(blocks[1], ["1. A", "Brand: Smirnoff", "Time: 10:00 am – 2:00 pm", ...model.countLines(a)].join("\n"));
  assert.equal(blocks[2], ["2. B", "Time: 3:00 pm – 6:00 pm", ...model.countLines(b)].join("\n"));
});
test("day report: one tasting has no \"Total for the day\" block; no \"No flavour\" lines when that part is 0", () => {
  const v = visit6("BWS Carlton", "10:00", "14:00", "SSSNB", { flavours: ["Lime", "Mango"], tapF: "001-1" });
  const text = report.dayReportText(day("2026-11-14", [v]), cfg());
  assert.equal(text, [
    "Tasting day report — Sat 14 Nov 2026",
    "",
    "1. BWS Carlton",
    "Time: 10:00 am – 2:00 pm",
    "Total interactions: 4",
    "Samples given: 3",
    "  Lime: 2",
    "  Mango: 1",
    "Rejected or ignored: 1",
    "Sold: 1",
    "  Lime: 0",
    "  Mango: 1"
  ].join("\n"));
  assert.ok(!text.includes("Total for the day"));
  assert.ok(!text.includes("Customer comments"));
});
test("day report: the day's Sold line only when a tasting tracks sold", () => {
  const total = visits => {
    const blocks = report.dayReportText(day("2026-11-14", visits), cfg()).split("\n\n");
    const last = blocks[blocks.length - 1].split("\n");
    assert.equal(last[0], "Total for the day");
    return last.slice(1);
  };
  // two old tastings: sales were not counted, so no Sold anywhere
  const old = [visit("A", "10:00", "13:00", taps(3, 1)), visit("B", "14:00", "17:00", taps(2, 2))];
  assert.deepEqual(total(old), ["Total interactions: 8", "Samples given: 5", "Rejected or ignored: 3"]);
  assert.ok(!report.dayReportText(day("2026-11-14", old), cfg()).includes("Sold"));
  // two new tastings with nothing sold: Sold: 0 is the truth and is printed
  assert.deepEqual(total([visit6("A", "10:00", "13:00", taps(3, 1)), visit6("B", "14:00", "17:00", taps(2, 2))]),
    ["Total interactions: 8", "Samples given: 5", "Rejected or ignored: 3", "Sold: 0"]);
  // an old tasting whose log has a sale in it tracks sold
  assert.deepEqual(total([visit("A", "10:00", "13:00", "SSB"), visit("B", "14:00", "17:00", "SN")]),
    ["Total interactions: 4", "Samples given: 3", "Rejected or ignored: 1", "Sold: 1"]);
  // a sale that was taken off again still means sales were being counted
  assert.deepEqual(total([visit("A", "10:00", "13:00", "SSb"), visit("B", "14:00", "17:00", "SN")]),
    ["Total interactions: 4", "Samples given: 3", "Rejected or ignored: 1", "Sold: 0"]);
  // three tastings, sold by hand and per flavour
  assert.deepEqual(total([flavoured("A"), visit6("B", "14:30", "17:00", "S", { adjB: 5 }), visit("C", "18:00", "19:00", "N")]),
    ["Total interactions: 11", "Samples given: 8", "Rejected or ignored: 3", "Sold: 9"]);
});
test("day report: comments that are only spaces, or not text, print nothing; pay never shows", () => {
  for (const comments of ["", "   \n ", null, 5, undefined]) {
    const text = report.dayReportText(day("2026-11-14", [flavoured("A", { comments })]), cfg());
    assert.ok(!text.includes("Customer comments"), String(comments));
    assertClean(text);
    assert.ok(!text.includes("$"));
  }
});

/* ── periodCsv: Flavours block, Sold and Customer comments columns ── */
const csvBlock = (csv, i) => csv.split("\r\n\r\n")[i].split("\r\n").slice(2);
const csvV6Days = () => [
  day("2026-11-14", [
    visit("Liquorland Fitzroy", "15:00", "18:00", taps(10, 5)),                                   // old, no flavours
    flavoured("BWS Carlton", { comments: "Loved the Lime, \"best yet\"\nWanted a bigger bottle" })
  ]),
  day("2026-11-15", [
    visit6("Dan Murphy's Kew", "10:00", "13:00", "SSNBB", { brand: "Gordon's", flavours: ["Pink", "Lime, salted", "\"Zero\""], tapF: "01-01", comments: "Fine" })
  ]),
  day("2026-11-13", [visit6("Bottle-O", "10:00", "14:00", "SB", { adjB: 2 })])                     // new, no flavours
];

test("CSV flavours: one row per flavour of each tasting, a \"No flavour\" row only when needed", () => {
  const csv = report.periodCsv(csvV6Days(), cfg(), hol(), "2026-11-09", "2026-11-15");
  assert.deepEqual(csv.split("\r\n\r\n")[3].split("\r\n").slice(0, 2), ["Flavours", "Date,Store,Brand,Flavour,Samples given,Sold"]);
  assert.deepEqual(csvBlock(csv, 3), [
    "2026-11-14,BWS Carlton,Smirnoff,Lime,4,2",
    "2026-11-14,BWS Carlton,Smirnoff,Mango,2,1",
    "2026-11-14,BWS Carlton,Smirnoff,No flavour,1,1",
    "2026-11-15,Dan Murphy's Kew,Gordon's,Pink,1,1",
    '2026-11-15,Dan Murphy\'s Kew,Gordon\'s,"Lime, salted",1,1',
    '2026-11-15,Dan Murphy\'s Kew,Gordon\'s,"""Zero""",0,0'
  ]);
});
test("CSV flavours: \"No flavour\" for plain samples alone, for plain sold alone, and not for neither", () => {
  const rows = v => csvBlock(report.periodCsv([day("2026-11-14", [v])], cfg(), hol(), "2026-11-09", "2026-11-15"), 3);
  const base = (k, f, extra = {}) => visit6("A", "10:00", "14:00", k, { flavours: ["Lime"], tapF: f, ...extra });
  assert.deepEqual(rows(base("SS", "00")), ["2026-11-14,A,,Lime,2,0"]);
  assert.deepEqual(rows(base("SS", "0-")), ["2026-11-14,A,,Lime,1,0", "2026-11-14,A,,No flavour,1,0"]);
  assert.deepEqual(rows(base("SB", "0-")), ["2026-11-14,A,,Lime,1,0", "2026-11-14,A,,No flavour,0,1"]);
  assert.deepEqual(rows(base("S", "0", { adjS: 2, adjB: 3 })), ["2026-11-14,A,,Lime,1,0", "2026-11-14,A,,No flavour,2,3"]);
  // a flavour with nothing counted still has its row; rejections are not a flavour
  assert.deepEqual(rows(base("NN", "--")), ["2026-11-14,A,,Lime,0,0"]);
  // old taps with no tapF at all are plain; a flavour number that is not in the list is plain too
  assert.deepEqual(rows(visit6("A", "10:00", "14:00", "SS", { flavours: ["Lime"] })), ["2026-11-14,A,,Lime,0,0", "2026-11-14,A,,No flavour,2,0"]);
  assert.deepEqual(rows(base("SS", "07")), ["2026-11-14,A,,Lime,1,0", "2026-11-14,A,,No flavour,1,0"]);
  // a tasting with no flavours has no rows here
  assert.deepEqual(rows(visit6("A", "10:00", "14:00", "SSB")), []);
  assert.deepEqual(rows(visit6("A", "10:00", "14:00", "SSB", { flavours: [] })), []);
});
test("CSV flavours: the rows of a tasting add up to its Samples given and Sold", () => {
  const csv = report.periodCsv(csvV6Days(), cfg(), hol(), "2026-11-09", "2026-11-15");
  const sum = (store, col) => csvBlock(csv, 3).filter(r => r.includes("," + store + ",")).reduce((a, r) => a + Number(r.split(",").at(col)), 0);
  assert.deepEqual([sum("BWS Carlton", -2), sum("BWS Carlton", -1)], [7, 4]);
  assert.deepEqual([sum("Dan Murphy's Kew", -2), sum("Dan Murphy's Kew", -1)], [2, 2]);
});
test("CSV days and tastings: the Sold column and the Customer comments column", () => {
  const csv = report.periodCsv(csvV6Days(), cfg(), hol(), "2026-11-09", "2026-11-15");
  assert.deepEqual(csvBlock(csv, 1), [
    "2026-11-13,Fri,Weekday,1,1,1,0,3,4.00,139.04,0.0,0.00,0.00,139.04,",
    "2026-11-14,Sat,Saturday,2,24,17,7,4,7.00,292.04,0.0,0.00,0.00,292.04,",
    "2026-11-15,Sun,Sunday,1,3,2,1,2,3.00,146.01,0.0,0.00,0.00,146.01,"
  ]);
  assert.equal(csvBlock(csv, 2).join("\r\n"), [
    "2026-11-13,Bottle-O,,10:00,14:00,0,4.00,1,1,0,3,139.04,,",
    '2026-11-14,BWS Carlton,Smirnoff,10:00,14:00,0,4.00,9,7,2,4,166.88,,"Loved the Lime, ""best yet""\nWanted a bigger bottle"',
    "2026-11-14,Liquorland Fitzroy,,15:00,18:00,0,3.00,15,10,5,0,125.16,,",
    "2026-11-15,Dan Murphy's Kew,Gordon's,10:00,13:00,0,3.00,3,2,1,2,146.01,,Fine"
  ].join("\r\n"));
  assert.ok(!csv.includes("$"));
  assertClean(csv);
});
test("CSV: comments that are not text leave the column empty; five blocks stay five", () => {
  const days = [day("2026-11-14", [visit6("A", "10:00", "14:00", "S", { comments: 7 }), visit6("B", "15:00", "16:00", "S", { comments: null })])];
  const csv = report.periodCsv(days, cfg(), hol(), "2026-11-09", "2026-11-15");
  assert.deepEqual(csvBlock(csv, 2), [
    "2026-11-14,A,,10:00,14:00,0,4.00,1,1,0,0,166.88,,",
    "2026-11-14,B,,15:00,16:00,0,1.00,1,1,0,0,41.72,,"
  ]);
  assert.equal(csv.split("\r\n\r\n").length, 5);
  assertClean(csv);
});
test("CSV summary and the payslip agree on every figure", () => {
  const days = richDays(), config = richConfig();
  const slip = slipOf(days, "2026-11-10", TODAY, config);
  const rows = csvBlock(report.periodCsv(days, config, hol(), slip.start, slip.end), 0);
  assert.deepEqual(rows, [
    "Weekday,2.50,34.76,86.90",
    "Saturday,7.00,41.72,292.04",
    "Saturday,7.17,43.00,308.17",
    "Sunday,9.00,48.67,438.03",
    "Public holiday,4.00,69.53,278.12",
    "Total hours,29.67,,",
    "Pay for hours,,,1403.26",
    "Travel,41.2,1.00,41.20",
    "Travel,65.0,1.10,71.50",
    "Parking,,,16.00",
    "Total payout before tax,,,1531.96"
  ]);
  assert.equal(rows.at(-1), `Total payout before tax,,,${(slip.totalCents / 100).toFixed(2)}`);
});


/* ── added after the version-6 review ─────────────────── */
test("pending: a running tasting with typed shift times is already in the total, and the payslip says so", () => {
  // the normal case: the shift times were typed when the tasting was added, then counting was started
  const typed = running("Typed", "10:00", "SS", { paidEnd: "14:00", endManual: true });
  const days = [day("2026-11-07", [typed])];
  const slip = slipOf(days, PAST);
  assert.equal(slip.hoursMin, 240, "its four hours are paid");
  assert.deepEqual(slip.pending, [{ code: "running", count: 1, date: "2026-11-07", inTotal: true }]);
  assert.equal(slip.days[0].runningUnpaid, false);
  assert.equal(report.pendingText(slip.pending[0], "week"), "A tasting is still running. Its shift hours are already in the total.");
  assert.ok(report.payslipText(slip).includes("Its shift hours are already in the total."));
  // one running tasting without a finish time beside it: the sentence goes back to "not in the total yet"
  const both = [day("2026-11-07", [typed, running("Open", "15:00", "S")])];
  const slip2 = slipOf(both, PAST);
  assert.equal(slip2.pending[0].inTotal, false);
  assert.equal(slip2.days[0].runningUnpaid, true);
  assertLaws(slip, days, cfg());
  assertLaws(slip2, both, cfg());
});
