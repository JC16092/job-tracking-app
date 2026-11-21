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
/** A finished tasting. taps like "SSN" are counted as typed. */
const visit = (placeName, start, end, taps = "", extra = {}) => ({
  id: "v" + (++seq), placeId: "p_" + placeName, placeName,
  startedAt: 1000, endedAt: 2000,
  paidStart: start, paidEnd: end, startManual: true, endManual: true,
  breakMin: 0, tapT: [...taps].map((_, i) => i), tapK: taps, adjS: 0, adjN: 0, note: "", ...extra
});
const planned = (placeName, start, end, extra = {}) =>
  visit(placeName, start, end, "", { startedAt: null, endedAt: null, ...extra });
const running = (placeName, start, taps = "", extra = {}) =>
  visit(placeName, start, "", taps, { endedAt: null, endManual: false, ...extra });
const leg = (fromName, toName, tenths, extra = {}) => ({
  from: fromName, to: toName, fromName, toName,
  tenths, checkedOn: tenths == null ? null : "2026-11-14", checkedTime: null, via: "", skip: false, ...extra
});
const day = (date, visits, extra = {}) =>
  ({ v: 1, date, updatedAt: 1, paidAs: null, visits, legs: [], parking: [], ...extra });
const taps = (s, n) => "S".repeat(s) + "N".repeat(n);

const FRI = "2026-11-13", SAT = "2026-11-14", SUN = "2026-11-15", MON = "2026-11-16";

/** Saturday: two tastings (typed out of order), three legs, parking. */
const fullSaturday = () => day(SAT, [
  visit("Liquorland Fitzroy", "15:00", "18:00", taps(10, 5)),
  visit("BWS Carlton", "10:00", "14:00", taps(27, 16), { brand: "Jameson" })
], {
  legs: [
    leg("Home", "BWS Carlton", 124),
    leg("BWS Carlton", "Liquorland Fitzroy", 87),
    leg("Liquorland Fitzroy", "Home", 151)
  ],
  parking: [{ id: "k1", cents: 650, note: "", visitId: null }]
});

test("the dates used in these tests are what they claim", () => {
  assert.equal(pay.weekdayOf(FRI), 5);
  assert.equal(pay.weekdayOf(SAT), 6);
  assert.equal(pay.weekdayOf("2026-11-01"), 0);
  assert.equal(pay.weekdayOf("2026-06-01"), 1);
  assert.equal(pay.weekdayOf("2027-02-01"), 1);
});

/* ── conversion, rangeCounts ──────────────────────────── */
test("conversion: counts and the share that took a sample", () => {
  assert.deepEqual(report.conversion(visit("A", "10:00", "14:00", taps(27, 16))),
    { talked: 43, sampled: 27, declined: 16, pct: 63 });
  assert.deepEqual(report.conversion(visit("A", "10:00", "14:00", "SsNn", { adjS: 2 })),
    { talked: 4, sampled: 3, declined: 1, pct: 75 });
  assert.deepEqual(report.conversion(visit("A", "10:00", "14:00")),
    { talked: 0, sampled: 0, declined: 0, pct: null });
});

test("rangeCounts adds up every tasting in the range, ends included", () => {
  const days = [
    day(FRI, [visit("A", "10:00", "14:00", taps(1, 1))]),
    fullSaturday(),
    day(SUN, [visit("B", "10:00", "13:00", taps(3, 0))]),
    day(MON, [visit("C", "10:00", "13:00", taps(50, 50))])
  ];
  assert.deepEqual(report.rangeCounts(days, SAT, SUN),
    { tastings: 3, talked: 61, sampled: 40, declined: 21, sold: 0, pct: 66 });
  assert.deepEqual(report.rangeCounts(days, SAT, SAT),
    { tastings: 2, talked: 58, sampled: 37, declined: 21, sold: 0, pct: 64 });
});
test("rangeCounts with nothing in range: zeros and pct null", () => {
  const empty = { tastings: 0, talked: 0, sampled: 0, declined: 0, sold: 0, pct: null };
  assert.deepEqual(report.rangeCounts([fullSaturday()], "2026-12-01", "2026-12-31"), empty);
  assert.deepEqual(report.rangeCounts([], SAT, SAT), empty);
  assert.deepEqual(report.rangeCounts(undefined, SAT, SAT), empty);
  assert.deepEqual(report.rangeCounts([day(SAT, [planned("A", "10:00", "14:00")])], SAT, SAT),
    { tastings: 1, talked: 0, sampled: 0, declined: 0, sold: 0, pct: null });
});

/* ── dayReportText ────────────────────────────────────── */
test("day report: two tastings, three trips and parking, whole text", () => {
  assert.equal(report.dayReportText(fullSaturday(), cfg()), [
    "Tasting day report — Sat 14 Nov 2026",
    "",
    "1. BWS Carlton",
    "Brand: Jameson",
    "Time: 10:00 am – 2:00 pm",
    "Total interactions: 43",
    "Samples given: 27",
    "Rejected or ignored: 16",
    "",
    "2. Liquorland Fitzroy",
    "Time: 3:00 pm – 6:00 pm",
    "Total interactions: 15",
    "Samples given: 10",
    "Rejected or ignored: 5",
    "",
    "Total for the day",
    "Total interactions: 58",
    "Samples given: 37",
    "Rejected or ignored: 21",
    "",
    "Travel (roads with no tolls)",
    "Home → BWS Carlton: 12.4 km",
    "BWS Carlton → Liquorland Fitzroy: 8.7 km",
    "Liquorland Fitzroy → Home: 15.1 km",
    "Total: 36.2 km",
    "",
    "Parking: $6.50"
  ].join("\n"));
});
test("day report has no pay figures", () => {
  const text = report.dayReportText(day(SAT, [visit("A", "10:00", "14:00", "S")]), cfg());
  assert.ok(!text.includes("$"));
  assert.ok(!text.includes("166"));
});
test("day report: a skipped leg is left out, a leg with no km says so, the total is what is known", () => {
  const d = fullSaturday();
  d.legs[1].tenths = null;
  d.legs[2].skip = true;
  d.parking = [];
  const text = report.dayReportText(d, cfg());
  assert.equal(text.split("\n\n")[4], [
    "Travel (roads with no tolls)",
    "Home → BWS Carlton: 12.4 km",
    "BWS Carlton → Liquorland Fitzroy: km not entered",
    "Total: 12.4 km"
  ].join("\n"));
  assert.ok(!text.includes("Parking"));
  assert.ok(!text.includes("Liquorland Fitzroy → Home"));
});
test("day report: no trips means no Travel block; empty brand and missing times are left out", () => {
  const d = day(SAT, [visit("A", "", "", "SN", { brand: "  " }), visit("B", "09:00", "", "S", { brand: "Baileys" })]);
  assert.equal(report.dayReportText(d, cfg()), [
    "Tasting day report — Sat 14 Nov 2026",
    "",
    "1. B",
    "Brand: Baileys",
    "Time: 9:00 am",
    "Total interactions: 1",
    "Samples given: 1",
    "Rejected or ignored: 0",
    "",
    "2. A",
    "Total interactions: 2",
    "Samples given: 1",
    "Rejected or ignored: 1",
    "",
    "Total for the day",
    "Total interactions: 3",
    "Samples given: 2",
    "Rejected or ignored: 1"
  ].join("\n"));
  assert.equal(report.dayReportText(day(SAT, []), cfg()), "Tasting day report — Sat 14 Nov 2026");
});
test("day report: every leg skipped leaves the Travel block out; toll-free wording follows the setting", () => {
  const d = fullSaturday();
  for (const l of d.legs) l.skip = true;
  assert.ok(!report.dayReportText(d, cfg()).includes("Travel"));
  const text = report.dayReportText(fullSaturday(), cfg({ avoidTolls: false }));
  assert.ok(text.includes("\nTravel\nHome → BWS Carlton"));
});

/* ── periodCsv ────────────────────────────────────────── */
const csvDays = () => {
  const fri = day(FRI, [
    visit('Dan\'s "Cellar", Kew', "10:00", "14:00", taps(3, 1), { note: "Busy,\nran out of cups", breakMin: 30 }),
    visit("Bottle-O", "15:00", "14:00", "S")                       // end before start
  ], { legs: [leg("Home", 'Dan\'s "Cellar", Kew', null), leg('Dan\'s "Cellar", Kew', "Home", null)] });
  const sun = day(SUN, [running("Vintage Cellars", "10:00", "SS")], {
    legs: [leg("Home", "Vintage Cellars", 50, { checkedOn: "2026-11-15" }), leg("Vintage Cellars", "Home", null, { skip: true })]
  });
  return [sun, day("2026-11-10", []), fullSaturday(), fri, day("2026-11-20", [visit("Out of range", "10:00", "14:00", "S")])];
};

test("CSV: five blocks with their titles and headers, CRLF lines", () => {
  const csv = report.periodCsv(csvDays(), cfg(), hol(), "2026-11-09", "2026-11-15");
  assert.ok(!/[^\r]\n/.test(csv.replace(/"[^"]*"/g, "")), "every line break outside quotes is CRLF");
  const blocks = csv.split("\r\n\r\n");
  assert.equal(blocks.length, 5);
  const head = b => b.split("\r\n").slice(0, 2);
  assert.deepEqual(head(blocks[0]), ["Tastings summary,2026-11-09,2026-11-15", "Line,Hours,Rate,Amount"]);
  assert.deepEqual(head(blocks[1]), ["Days",
    "Date,Day,Paid as,Tastings,Total interactions,Samples given,Rejected or ignored,Sold,Paid hours,Hours pay,Km,Km pay,Parking,Day total,To fix"]);
  assert.deepEqual(head(blocks[2]), ["Tastings",
    "Date,Store,Brand,Shift start,Shift end,Unpaid break (min),Paid hours,Total interactions,Samples given,Rejected or ignored,Sold,Pay,Note,Customer comments"]);
  assert.deepEqual(head(blocks[3]), ["Flavours", "Date,Store,Brand,Flavour,Samples given,Sold"]);
  assert.deepEqual(head(blocks[4]), ["Trips", "Date,From,To,Km,Checked on,Not driven"]);
  assert.ok(!csv.includes("Out of range"));
  assert.ok(!csv.includes("$"));
});

test("CSV summary: one row per pay line, total hours, pay for hours, travel, parking, total payout", () => {
  const csv = report.periodCsv(csvDays(), cfg(), hol(), "2026-11-09", "2026-11-15");
  // Friday 3 h 30 at 34.76 = 121.66; Saturday 7 h at 41.72 = 292.04; km 36.2 + 5.0 = 41.2
  assert.deepEqual(csv.split("\r\n\r\n")[0].split("\r\n").slice(2), [
    "Weekday,3.50,34.76,121.66",
    "Saturday,7.00,41.72,292.04",
    "Total hours,10.50,,",
    "Pay for hours,,,413.70",
    "Travel,41.2,1.00,41.20",
    "Parking,,,6.50",
    "Total payout before tax,,,461.40"
  ]);
});
test("CSV summary: evening, Sunday and public holiday labels", () => {
  const c = cfg({ rateSets: [{ ...pay.DEFAULT_RATE_SET, evening: 4172 }] });
  const days = [
    day(FRI, [visit("A", "16:00", "19:00")]),
    day(SUN, [visit("A", "10:00", "13:00")]),
    day("2026-12-25", [visit("A", "10:00", "14:00")])
  ];
  const rows = report.periodCsv(days, c, hol(), "2026-11-01", "2026-12-31").split("\r\n\r\n")[0].split("\r\n").slice(2);
  assert.deepEqual(rows, [
    "Weekday,2.00,34.76,69.52",
    "Weekday after 6 pm,1.00,41.72,41.72",
    "Sunday,3.00,48.67,146.01",
    "Public holiday,4.00,69.53,278.12",
    "Total hours,10.00,,",
    "Pay for hours,,,535.37",
    "Parking,,,0.00",
    "Total payout before tax,,,535.37"
  ]);
});

test("CSV days: one row per day with something on it, in date order, with what to fix", () => {
  const csv = report.periodCsv(csvDays(), cfg(), hol(), "2026-11-09", "2026-11-15");
  assert.deepEqual(csv.split("\r\n\r\n")[1].split("\r\n").slice(2), [
    "2026-11-13,Fri,Weekday,2,5,4,1,0,3.50,121.66,0.0,0.00,0.00,121.66,2 trips need km; wrong times",
    "2026-11-14,Sat,Saturday,2,58,37,21,0,7.00,292.04,36.2,36.20,6.50,334.74,",
    "2026-11-15,Sun,Sunday,1,2,2,0,0,0.00,0.00,5.0,5.00,0.00,5.00,tasting not finished"
  ]);
});
test("CSV days: one missing trip is singular; Paid as follows the day's own setting and the holidays", () => {
  const days = [
    day(FRI, [visit("A", "10:00", "14:00")], { paidAs: "holiday", legs: [leg("Home", "A", null), leg("A", "Home", 30)] }),
    day("2026-12-25", [], { parking: [{ id: "k", cents: 1234, note: "", visitId: null }] })
  ];
  const rows = report.periodCsv(days, cfg(), hol(), "2026-11-01", "2026-12-31").split("\r\n\r\n")[1].split("\r\n").slice(2);
  assert.deepEqual(rows, [
    "2026-11-13,Fri,Public holiday,1,0,0,0,0,4.00,278.12,3.0,3.00,0.00,281.12,1 trip needs km",
    "2026-12-25,Fri,Public holiday,0,0,0,0,0,0.00,0.00,0.0,0.00,12.34,12.34,"
  ]);
});

test("CSV tastings: quoting of commas, quotes and line breaks; no pay for a time problem", () => {
  const csv = report.periodCsv(csvDays(), cfg(), hol(), "2026-11-09", "2026-11-15");
  assert.equal(csv.split("\r\n\r\n")[2].split("\r\n").slice(2).join("\r\n"), [
    '2026-11-13,"Dan\'s ""Cellar"", Kew",,10:00,14:00,30,3.50,4,3,1,0,121.66,"Busy,\nran out of cups",',
    "2026-11-13,Bottle-O,,15:00,14:00,0,,1,1,0,0,,,",
    "2026-11-14,BWS Carlton,Jameson,10:00,14:00,0,4.00,43,27,16,0,166.88,,",
    "2026-11-14,Liquorland Fitzroy,,15:00,18:00,0,3.00,15,10,5,0,125.16,,",
    "2026-11-15,Vintage Cellars,,10:00,,0,0.00,2,2,0,0,0.00,,"
  ].join("\r\n"));
});

test("CSV trips: one row per leg, empty km when not entered, yes when not driven", () => {
  const csv = report.periodCsv(csvDays(), cfg(), hol(), "2026-11-09", "2026-11-15");
  assert.deepEqual(csv.split("\r\n\r\n")[4].split("\r\n").slice(2), [
    '2026-11-13,Home,"Dan\'s ""Cellar"", Kew",,,',
    '2026-11-13,"Dan\'s ""Cellar"", Kew",Home,,,',
    "2026-11-14,Home,BWS Carlton,12.4,2026-11-14,",
    "2026-11-14,BWS Carlton,Liquorland Fitzroy,8.7,2026-11-14,",
    "2026-11-14,Liquorland Fitzroy,Home,15.1,2026-11-14,",
    "2026-11-15,Home,Vintage Cellars,5.0,2026-11-15,",
    "2026-11-15,Vintage Cellars,Home,,,yes"
  ]);
});

test("CSV with nothing in range still has every block", () => {
  assert.equal(report.periodCsv([], cfg(), hol(), "2026-11-09", "2026-11-15"), [
    "Tastings summary,2026-11-09,2026-11-15", "Line,Hours,Rate,Amount", "Total hours,0.00,,", "Pay for hours,,,0.00", "Parking,,,0.00", "Total payout before tax,,,0.00",
    "",
    "Days", "Date,Day,Paid as,Tastings,Total interactions,Samples given,Rejected or ignored,Sold,Paid hours,Hours pay,Km,Km pay,Parking,Day total,To fix",
    "",
    "Tastings", "Date,Store,Brand,Shift start,Shift end,Unpaid break (min),Paid hours,Total interactions,Samples given,Rejected or ignored,Sold,Pay,Note,Customer comments",
    "",
    "Flavours", "Date,Store,Brand,Flavour,Samples given,Sold",
    "",
    "Trips", "Date,From,To,Km,Checked on,Not driven"
  ].join("\r\n"));
});

/* ── monthGrid ────────────────────────────────────────── */
test("month that starts on a Sunday: six leading blanks, Monday first", () => {
  const g = report.monthGrid("2026-11", [], cfg(), hol());
  assert.equal(g.ym, "2026-11");
  assert.equal(g.label, "November 2026");
  assert.equal(g.prev, "2026-10");
  assert.equal(g.next, "2026-12");
  assert.equal(g.weeks.length, 6);
  assert.ok(g.weeks.every(w => w.length === 7));
  assert.deepEqual(g.weeks[0].map(c => c && c.dayNum), [null, null, null, null, null, null, 1]);
  assert.deepEqual(g.weeks[1].map(c => c.dayNum), [2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(g.weeks[5].map(c => c && c.dayNum), [30, null, null, null, null, null, null]);
  assert.equal(g.weeks[0][6].date, "2026-11-01");
  assert.equal(g.weeks[0][6].kind, "sunday");
  assert.equal(g.weeks[2][5].date, SAT);
  assert.equal(g.weeks[2][5].kind, "saturday");
});
test("month that starts on a Monday: no leading blanks", () => {
  const june = report.monthGrid("2026-06", [], cfg(), hol());
  assert.equal(june.label, "June 2026");
  assert.deepEqual(june.weeks[0].map(c => c.dayNum), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(june.weeks.length, 5);
  assert.deepEqual(june.weeks[4].map(c => c && c.dayNum), [29, 30, null, null, null, null, null]);

  const feb = report.monthGrid("2027-02", [], cfg(), hol());
  assert.equal(feb.weeks.length, 4);
  assert.ok(feb.weeks.flat().every(c => c !== null));
  assert.equal(feb.weeks[3][6].date, "2027-02-28");
});
test("month: year ends, leap February", () => {
  const dec = report.monthGrid("2026-12", [], cfg(), hol());
  assert.equal(dec.prev, "2026-11");
  assert.equal(dec.next, "2027-01");
  const jan = report.monthGrid("2027-01", [], cfg(), hol());
  assert.equal(jan.prev, "2026-12");
  assert.equal(jan.label, "January 2027");
  const count = ym => report.monthGrid(ym, [], cfg(), hol()).weeks.flat().filter(Boolean).length;
  assert.equal(count("2028-02"), 29);
  assert.equal(count("2027-02"), 28);
  assert.equal(count("2026-12"), 31);
});
test("month cells: an empty date, a worked day, a planned tasting, a public holiday", () => {
  const days = [
    fullSaturday(),
    day(SUN, [planned("A", "10:00", "13:00"), running("B", "14:00", "S")], { legs: [leg("Home", "A", null)] }),
    day(MON, [visit("A", "15:00", "14:00")]),
    day("2026-11-05", [visit("A", "10:00", "14:00")], { paidAs: "sunday" }),
    day("2026-12-01", [visit("Next month", "10:00", "14:00", "S")])
  ];
  const g = report.monthGrid("2026-11", days, cfg(), hol());
  const cell = date => g.weeks.flat().find(c => c && c.date === date);

  assert.deepEqual(cell(FRI), {
    date: FRI, dayNum: 13, kind: "weekday", holidayName: null,
    tastings: 0, planned: 0, hoursMin: 0, totalCents: 0, missingKm: 0, running: false, problems: false
  });
  assert.deepEqual(cell(SAT), {
    date: SAT, dayNum: 14, kind: "saturday", holidayName: null,
    tastings: 2, planned: 0, hoursMin: 420, totalCents: 33474, missingKm: 0, running: false, problems: false
  });
  assert.deepEqual(cell(SUN), {
    date: SUN, dayNum: 15, kind: "sunday", holidayName: null,
    tastings: 2, planned: 1, hoursMin: 180, totalCents: 14601, missingKm: 1, running: true, problems: false
  });
  assert.equal(cell(MON).problems, true);
  assert.equal(cell(MON).totalCents, 0);
  assert.equal(cell("2026-11-05").kind, "sunday");

  const cup = cell("2026-11-03");
  assert.equal(cup.kind, "holiday");
  assert.equal(cup.holidayName, "Melbourne Cup");
  assert.equal(cup.tastings, 0);
});
test("month: a holiday the user removed is an ordinary day; a Set of dates works too", () => {
  const c = cfg({ holidaysRemoved: ["2026-11-03"] });
  const g = report.monthGrid("2026-11", [], c, holidayMap(c));
  assert.equal(g.weeks[1][1].date, "2026-11-03");
  assert.equal(g.weeks[1][1].kind, "weekday");
  assert.equal(g.weeks[1][1].holidayName, null);
  const s = report.monthGrid("2026-11", [], cfg(), new Set(["2026-11-04"]));
  assert.equal(s.weeks[1][2].kind, "holiday");
  assert.equal(s.weeks[1][2].holidayName, "Public holiday");
  assert.equal(report.monthGrid("2026-11", [], cfg(), null).weeks[1][1].kind, "weekday");
});
test("month totals: the pay period totals for the whole month plus the counts", () => {
  const days = [
    fullSaturday(),
    day("2026-11-30", [visit("A", "10:00", "14:00", taps(2, 2))]),
    day("2026-10-31", [visit("Last month", "10:00", "14:00", "S")]),
    day("2026-12-01", [visit("Next month", "10:00", "14:00", "S")])
  ];
  const g = report.monthGrid("2026-11", days, cfg(), hol());
  const expected = pay.periodTotals(days, cfg(), hol(), "2026-11-01", "2026-11-30");
  for (const key of Object.keys(expected)) assert.deepEqual(g.totals[key], expected[key], key);
  assert.equal(g.totals.totalCents, 33474 + 13904);
  assert.equal(g.totals.tastings, 3);
  assert.equal(g.totals.talked, 62);
  assert.equal(g.totals.sampled, 39);
  assert.equal(g.totals.declined, 23);
  assert.equal(g.totals.pct, 63);
  assert.equal(report.monthGrid("2026-09", days, cfg(), hol()).totals.pct, null);
});

/* ── todoList ─────────────────────────────────────────── */
test("to fix: missing km, a time problem, left running yesterday, counts not entered; newest first", () => {
  const today = SAT;
  const days = [
    day("2026-11-10", [visit("A", "10:00", "14:00", "S")], {
      legs: [leg("Home", "A", null), leg("A", "Home", null, { skip: true })]
    }),
    day("2026-11-11", [visit("A", "10:00", "14:00", "S")], { legs: [leg("Home", "A", null), leg("A", "Home", null)] }),
    day("2026-11-12", [visit("A", "15:00", "14:00", "S")]),
    day(FRI, [running("B", "10:00", "SN")]),
    day("2026-11-09", [visit("Dan's", "10:00", "14:00"), visit("Fine", "15:00", "18:00", "N")]),
    day("2026-11-08", [visit("All good", "10:00", "14:00", "S")], { legs: [leg("Home", "All good", 10)] }),
    day(SAT, [running("C", "10:00"), planned("D", "15:00", "18:00")]),
    day(SUN, [visit("Tomorrow", "15:00", "14:00")], { legs: [leg("Home", "Tomorrow", null)] })
  ];
  assert.deepEqual(report.todoList(days, cfg(), hol(), today), [
    { date: FRI, issues: ["A tasting was not finished"] },
    { date: "2026-11-12", issues: ["A tasting has wrong times"] },
    { date: "2026-11-11", issues: ["2 trips need km"] },
    { date: "2026-11-10", issues: ["1 trip needs km"] },
    { date: "2026-11-09", issues: ["Counts not entered for Dan's"] }
  ]);
});
test("to fix: today's missing km and time problems are listed, but not its running tasting or empty counts", () => {
  const days = [day(SAT, [running("C", "10:00"), visit("D", "15:00", "14:00")], { legs: [leg("Home", "C", null)] })];
  assert.deepEqual(report.todoList(days, cfg(), hol(), SAT),
    [{ date: SAT, issues: ["1 trip needs km", "A tasting has wrong times"] }]);
});
test("to fix: several problems on one day keep a fixed order", () => {
  const days = [day(FRI, [running("B", "10:00"), visit("E", "15:00", "14:00", "S")], { legs: [leg("Home", "B", null)] })];
  assert.deepEqual(report.todoList(days, cfg(), hol(), SAT), [{
    date: FRI,
    issues: ["1 trip needs km", "A tasting has wrong times", "A tasting was not finished"]
  }]);
});
test("to fix: only looks back as far as asked", () => {
  const bad = date => day(date, [visit("A", "10:00", "14:00", "S")], { legs: [leg("Home", "A", null)] });
  const days = [bad("2026-09-14"), bad("2026-09-15"), bad("2026-11-07"), bad("2026-11-06")];
  assert.equal(pay.addDays(SAT, -60), "2026-09-15");
  assert.deepEqual(report.todoList(days, cfg(), hol(), SAT).map(x => x.date), ["2026-11-07", "2026-11-06", "2026-09-15"]);
  assert.deepEqual(report.todoList(days, cfg(), hol(), SAT, 7).map(x => x.date), ["2026-11-07"]);
  assert.deepEqual(report.todoList([], cfg(), hol(), SAT), []);
});

/* ── financialYearOf ──────────────────────────────────── */
test("financial year: either side of 1 July", () => {
  const fy = { start: "2026-07-01", end: "2027-06-30", label: "2026–27" };
  assert.deepEqual(report.financialYearOf("2026-07-01"), fy);
  assert.deepEqual(report.financialYearOf("2026-11-14"), fy);
  assert.deepEqual(report.financialYearOf("2027-01-01"), fy);
  assert.deepEqual(report.financialYearOf("2027-06-30"), fy);
  assert.deepEqual(report.financialYearOf("2026-06-30"), { start: "2025-07-01", end: "2026-06-30", label: "2025–26" });
  assert.deepEqual(report.financialYearOf("2027-07-01"), { start: "2027-07-01", end: "2028-06-30", label: "2027–28" });
  assert.equal(report.financialYearOf("2099-12-31").label, "2099–00");
});

/* ── backupText ───────────────────────────────────────── */
test("backup: readable JSON with the days in date order, nothing changed", () => {
  const config = cfg({ homeAddress: "somewhere" });
  const days = [fullSaturday(), day(FRI, []), day(SUN, [])];
  const before = JSON.stringify(days);
  const text = report.backupText(config, days, "2026-11-14T03:00:00.000Z");
  assert.equal(JSON.stringify(days), before, "the list passed in is not reordered");
  assert.ok(text.startsWith('{\n  "app": "tastings",\n  "backupVersion": 1,\n  "exportedAt": "2026-11-14T03:00:00.000Z",\n  "config": {'));
  const back = JSON.parse(text);
  assert.deepEqual(Object.keys(back), ["app", "backupVersion", "exportedAt", "config", "days"]);
  assert.deepEqual(back.config, config);
  assert.deepEqual(back.days.map(d => d.date), [FRI, SAT, SUN]);
  assert.deepEqual(back.days[1], JSON.parse(JSON.stringify(days[0])));
  assert.equal(back.days[1].visits[1].brand, "Jameson");
  assert.deepEqual(JSON.parse(report.backupText(config, [], "x")).days, []);
});


/* ── v5: one km figure for the whole day; "nobody to count" ── */
test("whole-day km: the day report shows the route once with its total", () => {
  const d = fullSaturday();
  d.kmDay = 372; d.kmDayOn = SAT; d.kmDayFor = "x";
  const text = report.dayReportText(d, cfg());
  assert.ok(text.includes("Home → BWS Carlton → Liquorland Fitzroy → Home: 37.2 km"), text);
  assert.ok(text.includes("Total: 37.2 km"));
  assert.ok(!text.includes("Home → BWS Carlton: 12.4 km"));
});
test("whole-day km: the CSV has one trip row for the day, and the day's km is the typed figure", () => {
  const d = fullSaturday();
  d.kmDay = 372; d.kmDayOn = SAT;
  const csv = report.periodCsv([d], cfg(), hol(), SAT, SAT);
  assert.ok(csv.includes(`${SAT},Home,BWS Carlton → Liquorland Fitzroy → Home,37.2,${SAT},`), csv);
  assert.ok(!csv.includes(`${SAT},Home,BWS Carlton,12.4`));
  assert.ok(csv.includes("Travel,37.2,1.00,37.20"));
});
test("whole-day km: nothing is missing even when the trips have no figures of their own", () => {
  const d = day(FRI, [visit("A", "10:00", "14:00", "S")], { legs: [leg("Home", "A", null), leg("A", "Home", null)] });
  assert.deepEqual(report.todoList([d], cfg(), hol(), SAT), [{ date: FRI, issues: ["2 trips need km"] }]);
  d.kmDay = 250;
  assert.deepEqual(report.todoList([d], cfg(), hol(), SAT), []);
  assert.equal(pay.dayTotals(d, cfg(), hol()).kmTenths, 250);
  assert.equal(pay.dayTotals(d, cfg(), hol()).missingKm, 0);
});
test("to fix: a past tasting marked 'nobody to count' is not asked for counts again", () => {
  const d = day(FRI, [visit("Quiet", "10:00", "14:00"), visit("Busy", "15:00", "18:00", "S")]);
  assert.deepEqual(report.todoList([d], cfg(), hol(), SAT), [{ date: FRI, issues: ["Counts not entered for Quiet"] }]);
  d.visits[0].zeroOk = true;
  assert.deepEqual(report.todoList([d], cfg(), hol(), SAT), []);
});
