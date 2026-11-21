// Run from the project folder:  node --test tests/
// Also run with TZ=UTC and TZ=America/Los_Angeles: no result may depend on the time zone.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as pay from "../public/pay.js";
import * as model from "../public/model.js";
import { HOLIDAYS_VIC, HOLIDAYS_THROUGH, holidayMap } from "../public/holidays.js";

const cfg = (over = {}) => model.withConfigDefaults(over);
const hol = () => holidayMap(cfg());
const place = (id, name) => ({ id, name, address: "", lastUsed: 0, archived: false });
const visit = (start, end, extra = {}) => ({
  id: "v" + start + end, placeId: "a", placeName: "Store A", startedAt: null, endedAt: 1,
  paidStart: start, paidEnd: end, breakMin: 0, tapT: [], tapK: "", adjS: 0, adjN: 0, note: "", ...extra
});
const day = (date, visits, extra = {}) => ({ v: 1, date, updatedAt: 1, paidAs: null, visits, legs: [], parking: [], ...extra });
const cents = lines => lines.reduce((a, l) => a + l.cents, 0);

const SAT = "2026-11-14", SUN = "2026-11-15", FRI = "2026-11-13", XMAS = "2026-12-25";

test("the weekdays used in these tests are what they claim", () => {
  assert.equal(pay.weekdayOf(SAT), 6);
  assert.equal(pay.weekdayOf(SUN), 0);
  assert.equal(pay.weekdayOf(FRI), 5);
});

test("Saturday 4 h = $166.88", () => {
  assert.equal(cents(pay.visitLines(visit("10:00", "14:00"), SAT, cfg(), hol(), null)), 16688);
});
test("Sunday 3 h = $146.01", () => {
  assert.equal(cents(pay.visitLines(visit("10:00", "13:00"), SUN, cfg(), hol(), null)), 14601);
});
test("public holiday 4 h = $278.12", () => {
  const lines = pay.visitLines(visit("10:00", "14:00"), XMAS, cfg(), hol(), null);
  assert.equal(lines[0].kind, "holiday");
  assert.equal(cents(lines), 27812);
});
test("Saturday 4 h 05 = $170.36", () => {
  assert.equal(cents(pay.visitLines(visit("10:00", "14:05"), SAT, cfg(), hol(), null)), 17036);
});

test("Friday 16:00–19:00 is $104.28 with no evening rate and $111.24 with it", () => {
  assert.equal(cents(pay.visitLines(visit("16:00", "19:00"), FRI, cfg(), hol(), null)), 10428);
  const c = cfg({ rateSets: [{ ...pay.DEFAULT_RATE_SET, evening: 4172 }] });
  const lines = pay.visitLines(visit("16:00", "19:00"), FRI, c, hol(), null);
  assert.deepEqual(lines.map(l => [l.kind, l.minutes, l.cents]), [["weekday", 120, 6952], ["evening", 60, 4172]]);
  assert.equal(cents(lines), 11124);
});
test("a weekday tasting that ends at exactly 18:00 has no evening line", () => {
  const c = cfg({ rateSets: [{ ...pay.DEFAULT_RATE_SET, evening: 4172 }] });
  const lines = pay.visitLines(visit("15:00", "18:00"), FRI, c, hol(), null);
  assert.deepEqual(lines.map(l => l.kind), ["weekday"]);
  assert.equal(cents(lines), 10428);
});
test("an unpaid break comes off the daytime part first", () => {
  const c = cfg({ rateSets: [{ ...pay.DEFAULT_RATE_SET, evening: 4172 }] });
  const lines = pay.visitLines(visit("17:00", "20:00", { breakMin: 90 }), FRI, c, hol(), null);
  assert.deepEqual(lines.map(l => [l.kind, l.minutes]), [["evening", 90]]);
});
test("the evening split applies to a day forced to weekday, not to a Saturday", () => {
  const c = cfg({ rateSets: [{ ...pay.DEFAULT_RATE_SET, evening: 4172 }] });
  assert.equal(pay.visitLines(visit("16:00", "19:00"), SAT, c, hol(), "weekday").length, 2);
  assert.equal(pay.visitLines(visit("16:00", "19:00"), SAT, c, hol(), null).length, 1);
});

test("the worked Saturday: two tastings, three legs, parking = $334.74", () => {
  const d = day(SAT, [visit("10:00", "14:00"), visit("15:00", "18:00", { id: "v2", placeId: "b" })], {
    legs: [
      { from: "home", to: "a", tenths: 124 }, { from: "a", to: "b", tenths: 87 }, { from: "b", to: "home", tenths: 151 }
    ],
    parking: [{ id: "k", cents: 650 }]
  });
  const t = pay.dayTotals(d, cfg(), hol());
  assert.equal(t.hoursMin, 420);
  assert.equal(t.hoursCents, 29204);
  assert.equal(t.kmTenths, 362);
  assert.equal(t.kmCents, 3620);
  assert.equal(t.parkingCents, 650);
  assert.equal(t.totalCents, 33474);
  assert.equal(t.missingKm, 0);
});

test("a period multiplies once per rate: three Sunday tastings of 3 h 15 = $474.53", () => {
  const days = ["2026-11-01", "2026-11-08", "2026-11-15"].map(d => day(d, [visit("10:00", "13:15")]));
  const t = pay.periodTotals(days, cfg(), hol(), "2026-11-01", "2026-11-30");
  assert.equal(t.lines.length, 1);
  assert.equal(t.lines[0].minutes, 585);
  assert.equal(t.hoursCents, 47453);
});

test("re-pricing: marking a finished day as a public holiday changes its total", () => {
  const d = day(SAT, [visit("10:00", "14:00")]);
  assert.equal(pay.dayTotals(d, cfg(), hol()).totalCents, 16688);
  d.paidAs = "holiday";
  assert.equal(pay.dayTotals(d, cfg(), hol()).totalCents, 27812);
});

test("km and money are read from the characters", () => {
  assert.equal(model.parseKm("19.4"), 194);
  assert.equal(model.parseKm("35.3"), 353);
  assert.equal(model.parseKm("40.3"), 403);
  assert.equal(model.parseKm("8.7"), 87);
  assert.equal(model.parseKm("12,4"), 124);
  assert.equal(model.parseKm("12"), 120);
  assert.equal(model.parseKm("12.45"), 125);
  assert.equal(model.parseKm("abc"), null);
  assert.equal(model.parseKm(""), null);
  assert.equal(model.parseMoney("4.35"), 435);
  assert.equal(model.parseMoney("6.5"), 650);
  assert.equal(model.parseMoney("$6.50"), 650);
  assert.equal(model.parseMoney("6"), 600);
  assert.equal(model.parseMoney("x"), null);
});
test("40.3 km = $40.30 and 8.7 km = $8.70 exactly", () => {
  const leg = tenths => pay.dayTotals(day(SAT, [], { legs: [{ from: "home", to: "a", tenths }] }), cfg(), hol()).kmCents;
  assert.equal(leg(403), 4030);
  assert.equal(leg(87), 870);
  assert.equal(pay.money(4030), "$40.30");
  assert.equal(pay.kmText(362), "36.2");
});

test("public holidays: every date falls on the weekday published", () => {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  for (const h of HOLIDAYS_VIC) assert.equal(names[pay.weekdayOf(h.date)], h.day, `${h.date} ${h.name}`);
  assert.equal(HOLIDAYS_THROUGH, "2027-12-31");
});
test("Christmas week 2026: 25, 26 and 28 December are holidays, 27 is a plain Sunday", () => {
  const h = hol();
  assert.equal(pay.dayKind("2026-12-25", h, null), "holiday");
  assert.equal(pay.dayKind("2026-12-26", h, null), "holiday");
  assert.equal(pay.dayKind("2026-12-27", h, null), "sunday");
  assert.equal(pay.dayKind("2026-12-28", h, null), "holiday");
  assert.equal(pay.dayKind("2026-12-28", h, "weekday"), "weekday");
});
test("the user can add and remove holiday dates", () => {
  const h = holidayMap(cfg({ holidaysAdded: [{ date: "2027-09-24", name: "Grand Final Friday" }], holidaysRemoved: ["2026-11-03"] }));
  assert.equal(h.get("2027-09-24"), "Grand Final Friday");
  assert.equal(h.has("2026-11-03"), false);
});

test("a 9:55 am Saturday stays on its own date", () => {
  const d = new Date(2026, 10, 14, 9, 55);
  assert.equal(pay.todayISO(d), "2026-11-14");
  assert.equal(pay.hhmmOf(d.getTime()), "09:55");
  assert.equal(pay.addDays("2026-11-14", 1), "2026-11-15");
  assert.equal(pay.addDays("2026-10-03", 1), "2026-10-04");   // across the start of daylight saving in Melbourne
  assert.equal(pay.addDays("2027-04-03", 1), "2027-04-04");   // and its end
});

test("times never wrap past midnight; a finish at or before the start pays nothing", () => {
  assert.equal(pay.minutesBetween("15:00", "09:15"), 0);
  assert.equal(pay.minutesBetween("10:00", "10:00"), 0);
  const d = day(SAT, [visit("15:00", "09:15")]);
  const t = pay.dayTotals(d, cfg(), hol());
  assert.equal(t.hoursCents, 0);
  assert.deepEqual(t.problems, ["endBeforeStart"]);
  assert.equal(pay.addMinutes("23:50", 30), "23:59");
});
test("problems: too long and overlapping tastings are flagged and pay nothing until fixed", () => {
  const long = day(SAT, [visit("07:00", "18:30")]);
  assert.deepEqual(pay.dayTotals(long, cfg(), hol()).problems, ["tooLong"]);
  const over = day(SAT, [visit("10:00", "14:00"), visit("13:30", "16:00", { id: "v2" })]);
  const t = pay.dayTotals(over, cfg(), hol());
  assert.deepEqual(t.problems, ["overlap"]);
  assert.equal(t.hoursCents, 0);
});

test("pay period: weeks and fortnights counted from the anchor", () => {
  assert.deepEqual(pay.periodOf("2026-11-14", { days: 7, anchor: "2026-09-21" }), { start: "2026-11-09", end: "2026-11-15" });
  assert.deepEqual(pay.periodOf("2026-11-14", { days: 14, anchor: "2026-09-21" }), { start: "2026-11-02", end: "2026-11-15" });
  assert.deepEqual(pay.periodOf("2026-09-20", { days: 7, anchor: "2026-09-21" }), { start: "2026-09-14", end: "2026-09-20" });
});

test("rate sets: a day uses the latest set that started on or before it", () => {
  const c = cfg({ rateSets: [pay.DEFAULT_RATE_SET, { ...pay.DEFAULT_RATE_SET, from: "2027-07-05", saturday: 4300 }] });
  assert.equal(cents(pay.visitLines(visit("10:00", "14:00"), "2027-07-03", c, hol(), null)), 16688);
  assert.equal(cents(pay.visitLines(visit("10:00", "14:00"), "2027-07-10", c, hol(), null)), 17200);
});

/* ── model ────────────────────────────────────────────── */

/** The five numbers a tasting had before version 6 (counts() now returns more beside them). */
const five = n => ({ sampled: n.sampled, declined: n.declined, talked: n.talked, tapS: n.tapS, tapN: n.tapN });

test("undo and put back", () => {
  const v = model.newVisit(place("a", "Store A"), 1_000_000, 15);
  model.addTap(v, "S", 1_012_000); model.addTap(v, "N", 1_031_000); model.addTap(v, "S", 1_040_000);
  assert.equal(v.tapK, "SNS");
  assert.deepEqual(v.tapT, [12, 31, 40]);
  model.undoTap(v); assert.equal(v.tapK, "SNs");
  model.undoTap(v); assert.equal(v.tapK, "Sns");
  assert.deepEqual(five(model.counts(v)), { sampled: 1, declined: 0, talked: 1, tapS: 1, tapN: 0 });
  model.redoTap(v); assert.equal(v.tapK, "SNs");
  model.redoTap(v); assert.equal(v.tapK, "SNS");
  assert.equal(model.redoTap(v), null);
  model.undoTap(v);                                   // "SNs"
  model.addTap(v, "N", 1_050_000);                    // a new count ends the chance to put back
  assert.equal(v.tapK, "SNsN");
  assert.equal(model.peekRedo(v), null);
  assert.equal(model.counts(v).talked, 3);
});

test("a minus takes one off its own count only, and that tap can be put back", () => {
  const v = model.newVisit(place("a", "Store A"), 1_000_000, 15);
  for (const [k, s] of [["S", 5], ["N", 9], ["S", 14], ["N", 20]]) model.addTap(v, k, 1_000_000 + s * 1000);
  assert.equal(v.tapK, "SNSN");

  const a = model.undoKind(v, "S");                   // the newest S, not the newest tap
  assert.deepEqual(a, { kind: "S", flavour: -1, t: 14, index: 2 });
  assert.equal(v.tapK, "SNsN");
  assert.deepEqual([model.counts(v).sampled, model.counts(v).declined, model.counts(v).talked], [1, 2, 3]);

  assert.equal(model.undoKind(v, "S").index, 0);
  assert.equal(v.tapK, "sNsN");
  assert.equal(model.undoKind(v, "S"), null);         // none left of that kind
  assert.equal(model.undoKind(v, "x"), null);
  assert.equal(model.counts(v).sampled, 0);

  assert.deepEqual(model.redoAt(v, 2), { kind: "S", flavour: -1, t: 14, index: 2 });
  assert.equal(v.tapK, "sNSN");
  assert.equal(model.redoAt(v, 2), null);             // already counted again
  assert.equal(model.redoAt(v, 9), null);             // not a tap
  assert.deepEqual(v.tapT, [5, 9, 14, 20]);           // the log itself never shrinks
});

test("a planned tasting: typed shift times, paid and on the route before any counting, then started and stopped", () => {
  const c = cfg({ places: [place("a", "Store A"), place("b", "Store B")] });
  const a = model.plannedVisit(place("a", "Store A"), "10:00", "14:00", 1000);
  const b = model.plannedVisit(place("b", "Store B"), "15:00", "18:00", 2000);
  assert.equal(model.isPlanned(a), true);
  assert.equal(model.isRunning(a), false);
  assert.deepEqual([a.startManual, a.endManual, a.startedAt, a.endedAt], [true, true, null, null]);

  const d = day(SAT, [b, a]);
  model.rebuildLegs(d, c);
  assert.deepEqual(d.legs.map(l => `${l.from}>${l.to}`), ["home>a", "a>b", "b>home"]);   // the route is known before the day starts
  const t = pay.dayTotals(d, c, hol());
  assert.equal(t.hoursCents, 29204);                  // 7 h on a Saturday, from the typed times alone
  assert.equal(t.running, false);
  assert.deepEqual(t.problems, []);

  const at = (h, m) => new Date(2026, 10, 14, h, m).getTime();
  model.startVisit(a, at(9, 52));                      // tapped eight minutes early
  assert.equal(model.isRunning(a), true);
  assert.equal(a.paidStart, "10:00");                  // the typed time is kept, not the tap
  model.addTap(a, "S", at(10, 5));
  model.finishVisit(a, at(14, 9), 15);                 // tapped nine minutes late
  assert.equal(a.paidEnd, "14:00");
  assert.equal(pay.dayTotals(d, c, hol()).hoursCents, 29204);

  model.startVisit(b, at(15, 0));
  model.addTap(b, "N", at(15, 1));
  model.unstartVisit(b);                               // wrong store: back to planned, nothing counted
  assert.equal(model.isPlanned(b), true);
  assert.deepEqual([b.tapT, b.tapK, b.paidStart, b.paidEnd], [[], "", "15:00", "18:00"]);
  assert.deepEqual(model.withConfigDefaults({}).usualShifts, []);
});

test("stop counting clears hand corrections too, so the next real counts show", () => {
  const v = model.plannedVisit(place("a", "Store A"), "10:00", "14:00", 1000);
  model.startVisit(v, 2000);
  model.addTap(v, "S", 3000); model.addTap(v, "S", 4000);
  v.adjS = -2; v.adjN = 3;                             // corrected on the sheet against those two taps
  model.unstartVisit(v);
  assert.deepEqual([v.adjS, v.adjN, v.tapK], [0, 0, ""]);
  model.startVisit(v, 9000);
  model.addTap(v, "S", 10000); model.addTap(v, "S", 11000);
  assert.deepEqual(five(model.counts(v)), { sampled: 2, declined: 0, talked: 2, tapS: 2, tapN: 0 });
});

test("counts: hand corrections never push a number below zero; talked is the sum", () => {
  const v = visit("10:00", "14:00", { tapK: "SSN", tapT: [1, 2, 3], adjS: -5, adjN: 4 });
  assert.deepEqual(five(model.counts(v)), { sampled: 0, declined: 5, talked: 5, tapS: 2, tapN: 1 });
});

test("every leg is counted: home → A → B → home is three legs, three stores make four", () => {
  const c = cfg({ places: [place("a", "Store A"), place("b", "Store B"), place("c", "Store C")] });
  const d = day(SAT, [
    visit("15:00", "18:00", { id: "v2", placeId: "b", placeName: "Store B" }),
    visit("10:00", "14:00", { id: "v1", placeId: "a", placeName: "Store A" })
  ]);
  model.rebuildLegs(d, c);
  assert.deepEqual(d.legs.map(l => `${l.from}>${l.to}`), ["home>a", "a>b", "b>home"]);
  assert.equal(pay.dayTotals(d, c, hol()).missingKm, 3);
  d.visits.push(visit("18:30", "20:00", { id: "v3", placeId: "c", placeName: "Store C" }));
  model.rebuildLegs(d, c);
  assert.deepEqual(d.legs.map(l => `${l.from}>${l.to}`), ["home>a", "a>b", "b>c", "c>home"]);
});

test("legs: same store twice in a row makes no leg; km is remembered per direction; a day keeps its own copy", () => {
  const c = cfg({ places: [place("a", "Store A")] });
  const d = day(SAT, [visit("10:00", "12:00", { id: "v1" }), visit("13:00", "15:00", { id: "v2" })]);
  model.rebuildLegs(d, c);
  assert.deepEqual(d.legs.map(l => `${l.from}>${l.to}`), ["home>a", "a>home"]);
  model.setLegKm(d, c, 0, 124, { date: SAT, time: "09:40", remember: true });
  assert.equal(c.kmMemory["home>a"].tenths, 124);
  assert.equal(c.kmMemory["a>home"], undefined);

  const d2 = day(SUN, [visit("10:00", "12:00")]);
  model.rebuildLegs(d2, c);
  assert.equal(d2.legs[0].tenths, 124);
  assert.equal(d2.legs[1].tenths, null);

  model.setLegKm(d2, c, 0, 140, { date: SUN, time: "10:00", remember: false });    // just this day
  assert.equal(c.kmMemory["home>a"].tenths, 124);
  model.rebuildLegs(d, c);
  assert.equal(d.legs[0].tenths, 124);                                               // the earlier day is untouched
});

test("legs: a skipped leg counts nothing and is not missing; a changed address marks the km for re-checking", () => {
  const c = cfg({ homeAddress: "1 Old St", places: [place("a", "Store A")], kmMemory: { "home>a": { tenths: 124, checkedOn: SAT, stale: false } } });
  const d = day(SAT, [visit("10:00", "12:00")]);
  model.rebuildLegs(d, c);
  model.setLegSkip(d, 1, true);
  const t = pay.dayTotals(d, c, hol());
  assert.equal(t.missingKm, 0);
  assert.equal(t.kmTenths, 124);
  model.rebuildLegs(d, c);
  assert.equal(d.legs[1].skip, true);

  model.setAddress(c, "home", "2 New St");
  assert.equal(c.kmMemory["home>a"].stale, true);
  const d2 = day(SUN, [visit("10:00", "12:00")]);
  model.rebuildLegs(d2, c);
  assert.equal(d2.legs[0].tenths, null);
});

test("Maps link: driving, toll-free by default, addresses encoded", () => {
  const u = model.mapsUrl("1 High St, Northcote VIC 3070", "Shop 2/5 Station Rd & Co, Fairfield");
  assert.ok(u.startsWith("https://www.google.com/maps/dir/?api=1&origin=1%20High%20St%2C%20Northcote%20VIC%203070&destination="));
  assert.ok(u.includes("Station%20Rd%20%26%20Co"));
  assert.ok(u.includes("&travelmode=driving"));
  assert.ok(u.endsWith("&avoid=tolls"));
  assert.ok(!model.mapsUrl("a", "b", false).includes("avoid"));
  assert.equal(model.mapsUrl("", "b"), null);
  assert.equal(model.mapsUrl("a", "  "), null);
  assert.equal(model.defaultConfig().avoidTolls, true);
});

test("paid time: started earlier, the finish suggestion, and a manual time that is never overwritten", () => {
  const at = (h, m) => new Date(2026, 10, 14, h, m).getTime();
  const v = model.newVisit(place("a", "Store A"), at(10, 40), 15);
  assert.equal(v.paidStart, "10:45");
  model.startedEarlier(v, 45, 15);
  assert.equal(v.paidStart, "10:00");
  assert.equal(v.startManual, true);

  model.addTap(v, "S", at(12, 58));
  assert.deepEqual(model.suggestPaidEnd(v, at(13, 5), 15), { paidEnd: "13:00", from: "now" });
  assert.deepEqual(model.suggestPaidEnd(v, at(15, 5), 15), { paidEnd: "13:00", from: "lastCount" });

  const w = model.newVisit(place("a", "Store A"), at(10, 0), 15);
  w.paidEnd = "14:00"; w.endManual = true;
  model.finishVisit(w, at(15, 5), 15);
  assert.equal(w.paidEnd, "14:00");
  assert.equal(w.endedAt, at(15, 5));
  model.reopenVisit(w);
  assert.equal(w.endedAt, null);
  assert.equal(w.paidEnd, "14:00");

  const x = model.newVisit(place("a", "Store A"), at(10, 0), 15);
  model.finishVisit(x, at(10, 2), 15);
  assert.equal(x.paidEnd, "10:15");                   // always after the start
});

test("late taps: a few counts after a long gap can be dropped; a long run after a quiet spell is left alone", () => {
  const v = model.newVisit(place("a", "Store A"), 0, 15);
  for (const s of [60, 120, 180]) model.addTap(v, "S", s * 1000);
  model.addTap(v, "N", (180 + 27 * 60) * 1000);
  model.addTap(v, "N", (180 + 27 * 60 + 5) * 1000);
  assert.equal(model.lateTaps(v), 2);
  assert.equal(model.lateTapInfo(v).gapMin, 27);
  assert.equal(model.dropLateTaps(v), 2);
  assert.equal(v.tapK, "SSS");
  for (let i = 0; i < 8; i++) model.addTap(v, "S", (180 + 40 * 60 + i) * 1000);
  assert.equal(model.lateTaps(v), 0);
});

test("report text", () => {
  const v = visit("10:00", "14:00", { placeName: "BWS Northcote", tapK: "S".repeat(27) + "N".repeat(16), tapT: Array(43).fill(1) });
  assert.equal(model.reportText(day(SAT, [v]), v), [
    "Tasting report — Sat 14 Nov 2026", "Store: BWS Northcote", "Time: 10:00 am – 2:00 pm",
    "Total interactions: 43", "Samples given: 27", "Rejected or ignored: 16"
  ].join("\n"));
});

test("config defaults fill in what is missing and keep what they do not know", () => {
  const c = model.withConfigDefaults({ homeAddress: "x", extra: 1, payPeriod: { days: 14 } });
  assert.equal(c.homeAddress, "x");
  assert.equal(c.extra, 1);
  assert.deepEqual(c.payPeriod, { days: 14, anchor: "2026-09-21", confirmed: false });
  // version 6: a new setup starts on the fortnight; a stored week stays a week; "confirmed" is only ever true or false
  assert.deepEqual(model.withConfigDefaults({}).payPeriod, { days: 14, anchor: "2026-09-21", confirmed: false });
  assert.deepEqual(model.withConfigDefaults({ payPeriod: { days: 7, anchor: "2026-11-09" } }).payPeriod, { days: 7, anchor: "2026-11-09", confirmed: false });
  assert.equal(model.withConfigDefaults({ payPeriod: { days: 7, anchor: "2026-11-09", confirmed: true } }).payPeriod.confirmed, true);
  assert.equal(model.withConfigDefaults({ payPeriod: { days: 9, confirmed: "yes" } }).payPeriod.days, 7);
  assert.equal(model.withConfigDefaults({ payPeriod: { days: 9, confirmed: "yes" } }).payPeriod.confirmed, false);
  assert.deepEqual(model.withConfigDefaults({}).brands, []);
  assert.deepEqual(model.withConfigDefaults({ brands: [{ name: "Jameson", flavours: ["Original"] }, null, { name: " " }, 7] }).brands, [{ name: "Jameson", flavours: ["Original"] }]);
  assert.equal(c.rateSets[0].weekday, 3476);
  assert.deepEqual(JSON.parse(JSON.stringify(c)), c);   // survives a JSON round trip (Firestore-safe)
});


/* ── v5 ───────────────────────────────────────────────── */
test("v5: one km figure for the whole day replaces the trips, and is tied to its route", () => {
  const c = model.withConfigDefaults({});
  const a = model.newPlace("A", 1), b = model.newPlace("B", 2);
  c.places.push(a, b);
  const d = model.emptyDay("2026-11-14");
  d.visits.push(model.plannedVisit(a, "10:00", "14:00", 10), model.plannedVisit(b, "15:00", "18:00", 20));
  model.rebuildLegs(d, c);
  assert.equal(d.legs.length, 3);
  assert.equal(model.routeKey(d), `home>${a.id}>${b.id}>home`);
  assert.equal(pay.dayTotals(d, c, new Map()).missingKm, 3);

  model.setDayKm(d, 412, { date: "2026-11-14", time: "19:05" });
  assert.equal(model.hasDayKm(d), true);
  let t = pay.dayTotals(d, c, new Map());
  assert.equal(t.kmTenths, 412);
  assert.equal(t.kmCents, 4120);
  assert.equal(t.missingKm, 0);
  assert.equal(t.kmWhole, true);

  // per-trip figures are ignored while the whole-day figure is there
  model.setLegKm(d, c, 0, 100, { date: "2026-11-14" });
  assert.equal(pay.dayTotals(d, c, new Map()).kmTenths, 412);

  // the same route rebuilt: the figure stays
  model.rebuildLegs(d, c);
  assert.equal(d.kmDay, 412);

  // a trip not driven: the whole-day figure no longer fits
  model.setLegSkip(d, 1, true);
  assert.equal(d.kmDay, null);
  model.setLegSkip(d, 1, false);

  // a different route (a store removed): the figure goes
  model.setDayKm(d, 412, { date: "2026-11-14" });
  d.visits.pop();
  model.rebuildLegs(d, c);
  assert.equal(d.kmDay, null);
  assert.equal(model.hasDayKm(d), false);
  t = pay.dayTotals(d, c, new Map());
  assert.equal(t.kmWhole, false);
  assert.equal(t.kmTenths, 100);

  // removing it by hand, and refusing it on a day with no trips
  model.setDayKm(d, 300);
  model.setDayKm(d, null);
  assert.equal(d.kmDay, null);
  const empty = model.emptyDay("2026-11-15");
  model.setDayKm(empty, 300);
  assert.equal(model.hasDayKm(empty), false);
  // the day still survives a JSON round trip (Firestore: no undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
});

test("v5: the whole-day Maps link goes home → every store → home, toll-free", () => {
  const u = model.mapsDayUrl(["1 Home St, Southbank VIC", "250 High St, Northcote VIC 3070", "90 Station St & Co, Fairfield", "1 Home St, Southbank VIC"]);
  const q = new URL(u).searchParams;
  assert.equal(q.get("api"), "1");
  assert.equal(q.get("origin"), "1 Home St, Southbank VIC");
  assert.equal(q.get("destination"), "1 Home St, Southbank VIC");
  assert.equal(q.get("waypoints"), "250 High St, Northcote VIC 3070|90 Station St & Co, Fairfield");
  assert.equal(q.get("travelmode"), "driving");
  assert.equal(q.get("avoid"), "tolls");
  assert.ok(!model.mapsDayUrl(["a", "b", "a"], false).includes("avoid"));
  assert.equal(model.mapsDayUrl(["a", "", "a"]), null);
  assert.equal(model.mapsDayUrl(["a", "b"]), null);
  assert.equal(new URL(model.mapsDayUrl(["a", "b|c", "a"])).searchParams.get("waypoints"), "b c");
});

test("v5: the single-tasting report names the brand when there is one", () => {
  const p = { id: "p1", name: "BWS Carlton" };
  const v = model.manualVisit(p, "10:00", "14:00", 5);
  const d = { ...model.emptyDay("2026-11-14"), visits: [v] };
  assert.ok(!model.reportText(d, v).includes("Brand"));
  v.brand = "  Jameson ";
  const lines = model.reportText(d, v).split("\n");
  assert.equal(lines[1], "Store: BWS Carlton");
  assert.equal(lines[2], "Brand: Jameson");
  assert.equal(lines[3], "Time: 10:00 am – 2:00 pm");
});

test("v5: rates that change on a date leave earlier days at the old rate", () => {
  const c = model.withConfigDefaults({});
  c.rateSets.push({ ...c.rateSets[0], from: "2027-07-01", weekday: 3600, saturday: 4320, km: 110 });
  const p = { id: "p1", name: "A" };
  const before = { ...model.emptyDay("2027-06-30"), visits: [model.manualVisit(p, "10:00", "14:00", 1)],
    legs: [{ from: "home", to: "p1", fromName: "Home", toName: "A", tenths: 100, skip: false }] };
  const after = { ...before, date: "2027-07-01" };
  assert.equal(pay.weekdayOf("2027-06-30"), 3);
  const tb = pay.dayTotals(before, c, new Map()), ta = pay.dayTotals(after, c, new Map());
  assert.equal(tb.hoursCents, 4 * 3476);
  assert.equal(ta.hoursCents, 4 * 3600);
  assert.equal(tb.kmCents, 1000);
  assert.equal(ta.kmCents, 1100);
  // a period that spans the change shows one line per rate
  const t = pay.periodTotals([before, after], c, new Map(), "2027-06-28", "2027-07-04");
  assert.deepEqual(t.lines.map(l => [l.kind, l.rate, l.minutes]), [["weekday", 3476, 240], ["weekday", 3600, 240]]);
  assert.deepEqual(t.kmLines.map(k => [k.rate, k.tenths]), [[100, 100], [110, 100]]);
});

test("v5: a backup day is checked before it is taken back", () => {
  const p = { id: "p1", name: "A" };
  const v = model.manualVisit(p, "10:00", "14:00", 5);
  model.addTap(v, "S", 6000);
  const good = { ...model.emptyDay("2026-11-14"), visits: [v], parking: [{ id: "k1", cents: 650, note: "" }] };
  const back = model.cleanBackupDay(JSON.parse(JSON.stringify(good)));
  assert.equal(back.date, "2026-11-14");
  assert.deepEqual(model.counts(back.visits[0]), model.counts(v));
  assert.equal(back.parking[0].cents, 650);
  assert.equal(model.dayHasContent(back), true);
  assert.equal(model.dayHasContent(model.emptyDay("2026-11-14")), false);

  for (const bad of [null, 7, "x", [], {}, { date: "14/11/2026" }, { date: "2026-13-45" },
    { date: "2026-11-14", visits: "none" }, { date: "2026-11-14", visits: [{ placeName: "no id" }] },
    { date: "2026-11-14", legs: [{ from: 1, to: 2 }] }]) {
    assert.equal(model.cleanBackupDay(bad), null, JSON.stringify(bad));
  }
  // a tasting saved while it was running comes back finished, never running
  const live = { date: "2026-11-14", visits: [{ id: "v1", startedAt: 1000, endedAt: null, tapT: [1, 2], tapK: "SN" }] };
  const fixed = model.cleanBackupDay(live);
  assert.equal(model.isRunning(fixed.visits[0]), false);
  assert.equal(model.counts(fixed.visits[0]).talked, 2);
  // a tap log whose two halves disagree is dropped rather than trusted
  const odd = model.cleanBackupDay({ date: "2026-11-14", visits: [{ id: "v1", tapT: [1], tapK: "SSN" }] });
  assert.equal(model.counts(odd.visits[0]).talked, 0);
  // a planned tasting stays planned
  const plan = model.cleanBackupDay({ date: "2026-11-14", visits: [{ id: "v1", paidStart: "10:00", paidEnd: "14:00" }] });
  assert.equal(model.isPlanned(plan.visits[0]), true);
});

/* ── v5 review fixes ──────────────────────────────────── */
test("v5: money typed with a thousands comma is read as thousands, a lone comma as a decimal point", () => {
  assert.equal(model.parseMoney("1,234"), 123400);
  assert.equal(model.parseMoney("$1,234"), 123400);
  assert.equal(model.parseMoney("12,345,678"), null, "more than six digits of dollars is refused");
  assert.equal(model.parseMoney("123,456"), 12345600);
  assert.equal(model.parseMoney("1,234.50"), 123450);
  assert.equal(model.parseMoney("512,40"), 51240);
  assert.equal(model.parseMoney("6,5"), 650);
  assert.equal(model.parseMoney("6.50"), 650);
  assert.equal(model.parseMoney("1,23"), 123);
  assert.equal(model.parseMoney("1,2345"), 123, "extra decimals are rounded, as before");
});

test("v5: a first address for a store marks its remembered km for checking, the same as a changed one", () => {
  const c = model.withConfigDefaults({});
  const a = model.newPlace("BWS", 1);
  c.places.push(a);
  c.kmMemory[`home>${a.id}`] = { tenths: 124, checkedOn: "2026-11-07", checkedTime: null, via: "", stale: false };
  model.setAddress(c, a.id, "");                       // still no address: nothing changes
  assert.equal(c.kmMemory[`home>${a.id}`].stale, false);
  model.setAddress(c, a.id, "250 High St, Northcote VIC 3070");
  assert.equal(c.kmMemory[`home>${a.id}`].stale, true);
  // and a remembered km marked for checking is not filled into a new day's trips
  const d = model.emptyDay("2026-11-14");
  d.visits.push(model.plannedVisit(a, "10:00", "14:00", 5));
  model.rebuildLegs(d, c);
  assert.equal(d.legs[0].tenths, null);
  // the same address typed again changes nothing
  c.kmMemory[`home>${a.id}`].stale = false;
  model.setAddress(c, a.id, "250 High St, Northcote VIC 3070");
  assert.equal(c.kmMemory[`home>${a.id}`].stale, false);
});
