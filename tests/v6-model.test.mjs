// Run from the project folder:  node --test
// Version 6 of the model: sold, flavours, the three-list tap log, hand corrections per flavour,
// remembered brands, the report lines — and the rule in store.js that a tap's flavour mark
// travels with the tap when local taps are carried onto a newer remote copy.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as M from "../public/model.js";
import { createStore } from "../public/store.js";

/* ── builders ─────────────────────────────────────────── */
const PLACE = { id: "a", name: "Store A" };
const D = "2026-11-14";                                     // a Saturday
const at = (h, m = 0) => new Date(2026, 10, 14, h, m).getTime();
const T0 = at(10, 0);

const json = x => JSON.parse(JSON.stringify(x));
/** Everything that is stored must come back from JSON exactly as it went in. */
const survives = x => assert.deepEqual(json(x), x, "survives a JSON round trip");

/** A running version-6 tasting, started at 10:00. */
function v6(flavours = [], extra = {}) {
  const v = M.newVisit(PLACE, T0, 15);
  if (flavours.length) M.setFlavours(v, flavours);
  return Object.assign(v, extra);
}
/** A tasting as version 5 stored it: no flavours, no tapF, no sold. */
function oldVisit(taps = "", times = null, extra = {}) {
  return {
    id: "v_old", placeId: "a", placeName: "Store A", startedAt: T0, endedAt: T0 + 4 * 3600000,
    paidStart: "10:00", paidEnd: "14:00", startManual: false, endManual: false, breakMin: 0,
    tapT: times || [...taps].map((_, i) => (i + 1) * 10), tapK: taps, adjS: 0, adjN: 0, note: "", ...extra
  };
}
/** Taps from a short script, ten seconds apart: "S0 S1 N B0 S B" (a digit = the flavour). */
function tap(v, script, startSec = null) {
  let sec = startSec != null ? startSec : (v.tapT.length ? v.tapT[v.tapT.length - 1] : 0) + 10;
  for (const word of script.trim().split(/\s+/)) {
    M.addTap(v, word[0], v.startedAt + sec * 1000, word.length > 1 ? Number(word[1]) : null);
    sec += 10;
  }
  return v;
}
/** tapF as the model reads it: exactly as long as tapK, "-" for a missing end. */
function aligned(v) {
  const k = v.tapK || "", f = typeof v.tapF === "string" ? v.tapF : "";
  return f.length >= k.length ? f.slice(0, k.length) : f + "-".repeat(k.length - f.length);
}
/** The numbers of a tasting in one comparable value. */
function numbers(v) {
  const n = M.counts(v);
  return {
    sampled: n.sampled, declined: n.declined, talked: n.talked, sold: n.sold,
    plain: [n.plain.sampled, n.plain.sold],
    flav: n.flav.map(f => [f.name, f.sampled, f.sold])
  };
}
/** The laws every tasting obeys, whatever was done to it. */
function lawful(v, label = "") {
  const k = v.tapK || "";
  assert.equal(v.tapT.length, k.length, `tapT and tapK in step ${label}`);
  assert.equal(aligned(v).length, k.length, `tapF in step ${label}`);
  const n = M.counts(v);
  const all = [n.sampled, n.declined, n.talked, n.sold, n.tapS, n.tapN,
    n.plain.sampled, n.plain.sold, n.plain.tapS, n.plain.tapB,
    ...n.flav.flatMap(f => [f.sampled, f.sold, f.tapS, f.tapB])];
  for (const x of all) assert.ok(Number.isInteger(x) && x >= 0, `a whole number, 0 or more ${label}: ${x}`);
  assert.equal(n.talked, n.sampled + n.declined, `total interactions = samples + rejected ${label}`);
  assert.equal(n.sampled, n.plain.sampled + n.flav.reduce((a, f) => a + f.sampled, 0), `samples = sum of parts ${label}`);
  assert.equal(n.sold, n.plain.sold + n.flav.reduce((a, f) => a + f.sold, 0), `sold = sum of parts ${label}`);
  assert.equal(n.flav.length, M.flavoursOf(v).length);
  return n;
}

/* ── config ───────────────────────────────────────────── */
test("config: a new config is paid by the fortnight from 21 Sep 2026, not yet confirmed, with no brands", () => {
  const c = M.defaultConfig();
  assert.deepEqual(c.payPeriod, { days: 14, anchor: "2026-09-21", confirmed: false });
  assert.deepEqual(c.brands, []);
  assert.deepEqual(M.withConfigDefaults(undefined).payPeriod, { days: 14, anchor: "2026-09-21", confirmed: false });
  assert.deepEqual(M.withConfigDefaults({}).brands, []);
  survives(c);
  survives(M.withConfigDefaults({}));
});

test("config: a stored 7 or 14 days is kept, and a stored anchor with it", () => {
  assert.equal(M.withConfigDefaults({ payPeriod: { days: 7, anchor: "2026-10-05" } }).payPeriod.days, 7);
  assert.equal(M.withConfigDefaults({ payPeriod: { days: 14, anchor: "2026-10-05" } }).payPeriod.days, 14);
  assert.equal(M.withConfigDefaults({ payPeriod: { days: 7, anchor: "2026-10-05" } }).payPeriod.anchor, "2026-10-05");
  // a pay period stored without a length takes the default length and keeps its anchor
  assert.deepEqual(M.withConfigDefaults({ payPeriod: { anchor: "2026-10-05" } }).payPeriod,
    { days: 14, anchor: "2026-10-05", confirmed: false });
  // whatever was stored, the length is one the app can show
  for (const days of [0, 30, "14", null, NaN]) {
    assert.ok([7, 14].includes(M.withConfigDefaults({ payPeriod: { days } }).payPeriod.days), `days ${days}`);
  }
});

test("config: confirmed is only ever true or false", () => {
  const conf = x => M.withConfigDefaults({ payPeriod: { days: 14, confirmed: x } }).payPeriod.confirmed;
  assert.equal(conf(true), true);
  for (const x of [false, undefined, null, "yes", "true", 1, {}, []]) assert.equal(conf(x), false, String(x));
  assert.equal(M.withConfigDefaults({ payPeriod: "fortnight" }).payPeriod.confirmed, false);
});

test("config: brands is always a list, and entries without a name are dropped", () => {
  for (const brands of [undefined, null, "Jameson", { a: 1 }, 5]) {
    assert.deepEqual(M.withConfigDefaults({ brands }).brands, [], String(brands));
  }
  const kept = M.withConfigDefaults({ brands: [null, { name: "  " }, { name: 5 }, { name: "Vok", flavours: ["Lime"], lastUsed: 1 }] }).brands;
  assert.deepEqual(kept, [{ name: "Vok", flavours: ["Lime"], lastUsed: 1 }]);
  // a config from before version 6 keeps everything it had
  const before = { v: 1, updatedAt: 9, homeAddress: "1 Home St", places: [{ id: "a", name: "Store A" }], extra: "kept" };
  const after = M.withConfigDefaults(before);
  assert.equal(after.homeAddress, "1 Home St");
  assert.equal(after.extra, "kept");
  assert.deepEqual(after.places, before.places);
  survives(after);
});

/* ── brands ───────────────────────────────────────────── */
test("brands: a remembered brand gives its flavours back, whatever the capitals; an unknown one gives null", () => {
  const c = M.defaultConfig();
  M.rememberBrand(c, "Vok Cocktails", ["Lime", "Mango"], 100);
  assert.deepEqual(c.brands, [{ name: "Vok Cocktails", flavours: ["Lime", "Mango"], lastUsed: 100 }]);
  assert.deepEqual(M.brandFlavours(c, "vok cocktails"), ["Lime", "Mango"]);
  assert.deepEqual(M.brandFlavours(c, "  VOK COCKTAILS "), ["Lime", "Mango"]);
  assert.equal(M.brandFlavours(c, "Vok"), null);
  assert.equal(M.brandFlavours(c, ""), null);
  assert.equal(M.brandFlavours(M.defaultConfig(), "Vok Cocktails"), null);
  assert.equal(M.brandFlavours({}, "Vok Cocktails"), null);
  assert.equal(M.brandFlavours(null, "Vok Cocktails"), null);
  // a brand with no flavours is known, with an empty list
  M.rememberBrand(c, "Jameson", [], 200);
  assert.deepEqual(M.brandFlavours(c, "JAMESON"), []);
  // what comes back is a copy: changing it does not change what is remembered
  M.brandFlavours(c, "Vok Cocktails").push("Hacked");
  assert.deepEqual(M.brandFlavours(c, "Vok Cocktails"), ["Lime", "Mango"]);
  survives(c);
});

test("brands: newest first; remembering a brand again updates it in place of the old entry", () => {
  const c = M.defaultConfig();
  M.rememberBrand(c, "Alpha", ["One"], 1);
  M.rememberBrand(c, "Beta", [], 2);
  M.rememberBrand(c, "Gamma", ["X", "Y"], 3);
  assert.deepEqual(c.brands.map(b => b.name), ["Gamma", "Beta", "Alpha"]);
  M.rememberBrand(c, "  alpha ", ["One", "Two"], 4);
  // retyped in a different case: it keeps its first spelling ("Alpha"), updates its flavours, moves to the front
  assert.deepEqual(c.brands.map(b => b.name), ["Alpha", "Gamma", "Beta"]);
  assert.deepEqual(M.brandFlavours(c, "Alpha"), ["One", "Two"]);
  assert.equal(c.brands[0].lastUsed, 4);
  survives(c);
});

test("brandName: a brand already known keeps its first spelling; a new one is just cleaned", () => {
  const c = M.defaultConfig();
  M.rememberBrand(c, "Vok Cocktails", ["Lime", "Mango"], 1);
  assert.equal(M.brandName(c, "vok cocktails"), "Vok Cocktails");
  assert.equal(M.brandName(c, "  VOK   COCKTAILS  "), "Vok Cocktails");
  assert.equal(M.brandName(c, "  Jim  Beam "), "Jim Beam");   // not known: cleaned, spelling as typed
  assert.equal(M.brandName(c, ""), "");
  assert.equal(M.brandName(M.defaultConfig(), "Vok"), "Vok");
  assert.equal(M.brandName(null, "Vok"), "Vok");
});

test("brands: at most 30 are kept, the oldest go first; an empty name is not remembered", () => {
  const c = M.defaultConfig();
  for (let i = 1; i <= 35; i++) M.rememberBrand(c, "Brand " + i, ["F" + i], i);
  assert.equal(c.brands.length, 30);
  assert.equal(c.brands[0].name, "Brand 35");
  assert.equal(c.brands[29].name, "Brand 6");
  assert.equal(M.brandFlavours(c, "Brand 5"), null);
  assert.deepEqual(M.brandFlavours(c, "brand 6"), ["F6"]);
  M.rememberBrand(c, "   ", ["Lime"], 99);
  M.rememberBrand(c, "", ["Lime"], 99);
  M.rememberBrand(c, null, ["Lime"], 99);
  assert.equal(c.brands.length, 30);
  assert.equal(c.brands[0].name, "Brand 35");
  survives(c);
});

test("brands: the flavours are stored clean (no repeats, no empties, at most the maximum), and a config with no list yet gets one", () => {
  const c = { v: 1 };
  M.rememberBrand(c, "  Vok   Cocktails ", [" Lime ", "lime", "", "A", "B", "C", "D", "E", "F"], 5);
  assert.equal(c.brands[0].name, "Vok Cocktails");
  assert.deepEqual(c.brands[0].flavours, ["Lime", "A", "B", "C", "D", "E"]);
  assert.equal(c.brands[0].flavours.length, M.MAX_FLAVOURS);
  M.rememberBrand(c, "Jameson", null, 6);
  assert.deepEqual(M.brandFlavours(c, "jameson"), []);
  survives(c);
});

test("brands: a flavour is remembered as the one flavour it was on the tasting, even with a comma in its name",
  () => {
    const v = v6();
    assert.equal(M.addFlavour(v, "Gin, lime"), 0);
    const c = M.defaultConfig();
    M.rememberBrand(c, "Vok", M.flavoursOf(v), 1);
    // whichever way it is settled, the brand must offer the same flavours the tasting had
    assert.deepEqual(M.brandFlavours(c, "Vok"), M.flavoursOf(v));
  });

/* ── flavour names ────────────────────────────────────── */
test("flavour names: trimmed, inner spaces collapsed, at most 24 characters", () => {
  assert.equal(M.cleanFlavourName("  Passion \t  Fruit \n"), "Passion Fruit");
  assert.equal(M.cleanFlavourName("x".repeat(40)), "x".repeat(24));
  assert.equal(M.cleanFlavourName("x".repeat(24)), "x".repeat(24));
  assert.equal(M.cleanFlavourName(null), "");
  assert.equal(M.cleanFlavourName(undefined), "");
  assert.equal(M.cleanFlavourName("   "), "");
  assert.equal(M.cleanFlavourName(7), "7");
  assert.equal(M.MAX_FLAVOURS, 6);
});

test("parseFlavours: commas, semicolons and new lines, odd spacing, no empties", () => {
  assert.deepEqual(M.parseFlavours("Lime, Mango"), ["Lime", "Mango"]);
  assert.deepEqual(M.parseFlavours("  Lime ;Mango\nPassion    Fruit\r\n , ,, ;\n Berry  "), ["Lime", "Mango", "Passion Fruit", "Berry"]);
  assert.deepEqual(M.parseFlavours(""), []);
  assert.deepEqual(M.parseFlavours(" , ;\n"), []);
  assert.deepEqual(M.parseFlavours(null), []);
  assert.deepEqual(M.parseFlavours(undefined), []);
  assert.deepEqual(M.parseFlavours("Original"), ["Original"]);
});

test("parseFlavours: no repeats ignoring case (the first spelling wins), and never more than the maximum", () => {
  assert.deepEqual(M.parseFlavours("Lime, lime, LIME , Mango,mango"), ["Lime", "Mango"]);
  assert.deepEqual(M.parseFlavours("A,B,C,D,E,F,G,H"), ["A", "B", "C", "D", "E", "F"]);
  // repeats do not use up places
  assert.deepEqual(M.parseFlavours("A,a,B,b,C,c,D,d,E,e,F,f,G"), ["A", "B", "C", "D", "E", "F"]);
  // names that only differ after the 24th character are the same name once cleaned
  const long = "y".repeat(24);
  assert.deepEqual(M.parseFlavours(`${long}1, ${long}2`), [long]);
});

test("flavoursOf: [] for a tasting with none, an old tasting, or a damaged field; never more than the maximum", () => {
  assert.deepEqual(M.flavoursOf(v6()), []);
  assert.deepEqual(M.flavoursOf(oldVisit("SS")), []);
  assert.deepEqual(M.flavoursOf({ flavours: "Lime" }), []);
  assert.deepEqual(M.flavoursOf(null), []);
  assert.deepEqual(M.flavoursOf({ flavours: ["A", "B", "C", "D", "E", "F", "G", "H"] }), ["A", "B", "C", "D", "E", "F"]);
  const v = v6(["Lime", "Mango"]);
  assert.deepEqual(M.flavoursOf(v), ["Lime", "Mango"]);
  M.flavoursOf(v).push("Hacked");
  assert.deepEqual(v.flavours, ["Lime", "Mango"], "the list handed out is a copy");
});

test("setFlavours: sets the clean list and a zero correction for each flavour", () => {
  const v = v6();
  M.setFlavours(v, [" Lime ", "lime", "", "Mango"]);
  assert.deepEqual(v.flavours, ["Lime", "Mango"]);
  assert.deepEqual(v.adjF, [0, 0]);
  assert.deepEqual(v.adjBF, [0, 0]);
  M.setFlavours(v, ["A", "B", "C", "D", "E", "F", "G"]);
  assert.equal(v.flavours.length, 6);
  assert.deepEqual(v.adjF, [0, 0, 0, 0, 0, 0]);
  M.setFlavours(v, []);
  assert.deepEqual([v.flavours, v.adjF, v.adjBF], [[], [], []]);
  M.setFlavours(v, null);
  assert.deepEqual(v.flavours, []);
  lawful(v); survives(v);
});

test("addFlavour: gives the new place, or -1 for an empty name, a name already there, or a full list", () => {
  const v = v6();
  assert.equal(M.addFlavour(v, "  Lime "), 0);
  assert.equal(M.addFlavour(v, "Mango"), 1);
  assert.equal(M.addFlavour(v, "lime"), -1);
  assert.equal(M.addFlavour(v, " MANGO  "), -1);
  assert.equal(M.addFlavour(v, "   "), -1);
  assert.equal(M.addFlavour(v, null), -1);
  assert.deepEqual(v.flavours, ["Lime", "Mango"]);
  assert.deepEqual([v.adjF, v.adjBF], [[0, 0], [0, 0]]);
  for (const name of ["C", "D", "E", "F"]) assert.ok(M.addFlavour(v, name) >= 2);
  assert.equal(M.addFlavour(v, "G"), -1, "the list is full");
  assert.equal(v.flavours.length, M.MAX_FLAVOURS);
  assert.equal(v.adjF.length, 6);
  // on an old tasting, which has no flavour fields at all
  const old = oldVisit("SS");
  assert.equal(M.addFlavour(old, "Lime"), 0);
  assert.deepEqual([old.flavours, old.adjF, old.adjBF], [["Lime"], [0], [0]]);
  assert.equal(M.counts(old).sampled, 2);
  lawful(v); survives(v); lawful(old); survives(old);
});

test("addFlavour: keeps the corrections of the flavours already there", () => {
  const v = v6(["Lime"]);
  tap(v, "S0 S0 B0");
  M.setCount(v, "S", 0, 7);
  M.setCount(v, "B", 0, 4);
  assert.equal(M.addFlavour(v, "Mango"), 1);
  assert.deepEqual(numbers(v).flav, [["Lime", 7, 4], ["Mango", 0, 0]]);
  lawful(v); survives(v);
});

test("renameFlavour: a new spelling of itself is fine, another flavour's name is refused whatever the capitals", () => {
  const v = v6(["Lime", "Mango", "Berry"]);
  tap(v, "S0 S1 S1 B1 S2");
  const before = numbers(v);
  assert.equal(M.renameFlavour(v, 0, "LIME"), true, "differs from itself only by case");
  assert.deepEqual(v.flavours, ["LIME", "Mango", "Berry"]);
  assert.equal(M.renameFlavour(v, 0, "mango"), false, "differs from another only by case");
  assert.equal(M.renameFlavour(v, 0, "  BERRY "), false);
  assert.equal(M.renameFlavour(v, 0, "   "), false, "an empty name");
  assert.equal(M.renameFlavour(v, 0, null), false);
  assert.equal(M.renameFlavour(v, 3, "Peach"), false, "no such flavour");
  assert.equal(M.renameFlavour(v, -1, "Peach"), false);
  assert.deepEqual(v.flavours, ["LIME", "Mango", "Berry"]);
  assert.equal(M.renameFlavour(v, 1, "  Passion   Fruit "), true);
  assert.equal(M.renameFlavour(v, 2, "Berry"), true, "its own name again");
  assert.deepEqual(v.flavours, ["LIME", "Passion Fruit", "Berry"]);
  // the numbers stay with the place, only the names changed
  const after = numbers(v);
  assert.deepEqual(after.flav.map(f => f.slice(1)), before.flav.map(f => f.slice(1)));
  assert.deepEqual(after.flav.map(f => f[0]), ["LIME", "Passion Fruit", "Berry"]);
  lawful(v); survives(v);
});

/* ── counts ───────────────────────────────────────────── */
test("counts: an old tasting (no tapF, no flavours, no sold fields) still adds up", () => {
  const v = oldVisit("SSNsSnN", null, { adjS: 2, adjN: -1 });
  const n = lawful(v);
  assert.deepEqual([n.sampled, n.declined, n.talked, n.sold], [5, 1, 6, 0]);
  assert.deepEqual(n.plain, { sampled: 5, sold: 0, tapS: 3, tapB: 0 });
  assert.deepEqual(n.flav, []);
  assert.deepEqual([n.tapS, n.tapN], [3, 2]);
  assert.equal(v.tapF, undefined, "reading an old tasting does not change it");
  survives(v);
});

test("counts: every sample is one interaction, rejected is one number, sold never adds to interactions", () => {
  const v = v6(["Lime", "Mango"]);
  // one customer tries both flavours and buys two of one; one tries Lime only; one walks past; one buys without tasting
  tap(v, "S0 S1 B1 B1 S0 N B");
  const n = lawful(v);
  assert.equal(n.sampled, 3, "two flavours tried by one customer are two samples");
  assert.equal(n.declined, 1);
  assert.equal(n.talked, 4, "total interactions = samples + rejected; sold adds nothing");
  assert.equal(n.sold, 3);
  assert.deepEqual(n.flav, [
    { name: "Lime", sampled: 2, sold: 0, tapS: 2, tapB: 0 },
    { name: "Mango", sampled: 1, sold: 2, tapS: 1, tapB: 2 }
  ]);
  assert.deepEqual(n.plain, { sampled: 0, sold: 1, tapS: 0, tapB: 1 });
  assert.deepEqual([n.tapS, n.tapN], [0, 1]);
  survives(v);
});

test("counts: a tapF shorter than tapK reads as no flavour for the missing end", () => {
  const v = v6(["Lime", "Mango"], { tapT: [1, 2, 3, 4, 5, 6], tapK: "SSBSBN", tapF: "01" });
  const n = lawful(v);
  assert.deepEqual(n.flav.map(f => [f.sampled, f.sold]), [[1, 0], [1, 0]]);
  assert.deepEqual(n.plain, { sampled: 1, sold: 2, tapS: 1, tapB: 2 });
  assert.deepEqual([n.sampled, n.sold, n.declined, n.talked], [3, 2, 1, 4]);
  assert.equal(v.tapF, "01", "reading does not change the log");
});

test("counts: a tapF longer than tapK is ignored past the end", () => {
  const v = v6(["Lime", "Mango"], { tapT: [1, 2], tapK: "SB", tapF: "011100" });
  const n = lawful(v);
  assert.deepEqual(n.flav.map(f => [f.sampled, f.sold]), [[1, 0], [0, 1]]);
  assert.deepEqual([n.sampled, n.sold, n.talked], [1, 1, 1]);
  // the next tap lines up with its own mark, not with the stray end
  M.addTap(v, "S", T0 + 60000, 0);
  assert.equal(v.tapK, "SBS");
  assert.equal(v.tapF, "010");
  assert.deepEqual(M.counts(v).flav.map(f => f.sampled), [2, 0]);
  lawful(v); survives(v);
});

test("counts: a flavour mark that points past the list, or is not a mark at all, reads as no flavour", () => {
  const v = v6(["Lime", "Mango"], { tapT: [1, 2, 3, 4, 5, 6, 7], tapK: "SSSSBBS", tapF: "0129x5 " });
  const n = lawful(v);
  assert.deepEqual(n.flav.map(f => [f.sampled, f.sold]), [[1, 0], [1, 0]]);
  assert.deepEqual(n.plain, { sampled: 3, sold: 2, tapS: 3, tapB: 2 });
  assert.equal(n.sampled, 5);
  // a tasting with no flavours at all: every mark is "no flavour"
  const plain = v6([], { tapT: [1, 2], tapK: "SB", tapF: "01" });
  assert.deepEqual(numbers(plain), { sampled: 1, declined: 0, talked: 1, sold: 1, plain: [1, 1], flav: [] });
  // and a rejection is one number whatever its mark says
  const odd = v6(["Lime"], { tapT: [1, 2], tapK: "NN", tapF: "0-" });
  assert.deepEqual([M.counts(odd).declined, M.counts(odd).sampled], [2, 0]);
});

test("counts: taps that were taken off (lower case) are kept in the log and not counted", () => {
  const v = v6(["Lime", "Mango"], { tapT: [1, 2, 3, 4, 5, 6], tapK: "SsbBnN", tapF: "0011--" });
  const n = lawful(v);
  assert.deepEqual([n.sampled, n.sold, n.declined, n.talked], [1, 1, 1, 2]);
  assert.deepEqual(n.flav.map(f => [f.tapS, f.tapB]), [[1, 0], [0, 1]]);
});

test("counts: flavours added after counting started — the earlier samples stay 'no flavour'", () => {
  const v = v6();
  tap(v, "S S S B N");
  assert.equal(M.addFlavour(v, "Lime"), 0);
  assert.equal(M.addFlavour(v, "Mango"), 1);
  tap(v, "S0 S1 S1 B1 S");
  const n = lawful(v);
  assert.deepEqual(n.plain, { sampled: 4, sold: 1, tapS: 4, tapB: 1 });
  assert.deepEqual(n.flav.map(f => [f.name, f.sampled, f.sold]), [["Lime", 1, 0], ["Mango", 2, 1]]);
  assert.deepEqual([n.sampled, n.declined, n.talked, n.sold], [7, 1, 8, 2]);
  assert.equal(v.tapF, "-----0111-");
  // the same from an old tasting, which has no tapF for its first taps
  const old = oldVisit("SSN", [10, 20, 30], { endedAt: null });
  M.addFlavour(old, "Lime");
  tap(old, "S0 B0");
  assert.equal(old.tapF, "---00");
  assert.deepEqual(numbers(old), { sampled: 3, declined: 1, talked: 4, sold: 1, plain: [2, 0], flav: [["Lime", 1, 1]] });
  survives(v); lawful(old); survives(old);
});

test("counts: each part is floored at 0 on its own — a correction below zero in one part takes nothing from another", () => {
  const v = v6(["Lime", "Mango"]);
  tap(v, "S S S0 S0 S0 S1 B B0 N N");
  v.adjS = -5;            // would be -3 with no floor
  v.adjF = [0, -4];       // Mango would be -3
  v.adjB = -9;
  v.adjBF = [2, -1];
  v.adjN = -7;
  const n = lawful(v);
  assert.equal(n.plain.sampled, 0);
  assert.deepEqual(n.flav.map(f => f.sampled), [3, 0]);
  assert.equal(n.sampled, 3, "the plain part's -3 is not taken off Lime's 3");
  assert.equal(n.plain.sold, 0);
  assert.deepEqual(n.flav.map(f => f.sold), [3, 0]);
  assert.equal(n.sold, 3);
  assert.equal(n.declined, 0);
  assert.equal(n.talked, 3);
  // the taps themselves are still reported as they are
  assert.deepEqual([n.plain.tapS, n.plain.tapB, n.tapS, n.tapN], [2, 1, 2, 2]);
  assert.deepEqual(n.flav.map(f => [f.tapS, f.tapB]), [[3, 1], [1, 0]]);
  survives(v);
});

test("counts: missing or damaged correction fields never give NaN", () => {
  const v = v6(["Lime", "Mango"], {
    tapT: [1, 2, 3], tapK: "SSB", tapF: "01-",
    adjS: "x", adjN: null, adjB: undefined, adjF: "nope", adjBF: [null, "2", 9, 9]
  });
  const n = lawful(v);
  assert.deepEqual([n.sampled, n.declined, n.talked, n.sold], [2, 0, 2, 3]);
  delete v.adjF; delete v.adjBF; delete v.adjS; delete v.adjN;
  assert.deepEqual(numbers(v), { sampled: 2, declined: 0, talked: 2, sold: 1, plain: [0, 1], flav: [["Lime", 1, 0], ["Mango", 1, 0]] });
  // fractions typed into a file are rounded, not carried as fractions
  v.adjS = 1.4; v.adjF = [0.6, 0];
  assert.deepEqual(numbers(v).plain[0], 1);
  assert.deepEqual(numbers(v).flav[0], ["Lime", 2, 0]);
  lawful(v);
});

/* ── addTap ───────────────────────────────────────────── */
test("addTap: writes one entry to each of the three lists; a rejection never has a flavour", () => {
  const v = v6(["Lime", "Mango"]);
  M.addTap(v, "S", T0 + 5000, 0);
  M.addTap(v, "B", T0 + 6000, 1);
  M.addTap(v, "N", T0 + 7000, 1);          // a flavour given for a rejection is dropped
  M.addTap(v, "S", T0 + 8000);             // left out = none
  M.addTap(v, "S", T0 + 9000, null);
  M.addTap(v, "B", T0 + 9400, -1);
  assert.deepEqual(v.tapT, [5, 6, 7, 8, 9, 9]);
  assert.equal(v.tapK, "SBNSSB");
  assert.equal(v.tapF, "01----");
  lawful(v); survives(v);
});

test("addTap: a flavour that is not in the list is recorded as no flavour; anything that is not S, N or B is ignored", () => {
  const v = v6(["Lime", "Mango"]);
  M.addTap(v, "S", T0 + 1000, 2);
  M.addTap(v, "S", T0 + 2000, 9);
  M.addTap(v, "B", T0 + 3000, 1.5);
  M.addTap(v, "S", T0 + 4000, "1");
  assert.equal(v.tapK, "SSBS");
  assert.equal(v.tapF.length, 4);
  const n = lawful(v);
  assert.equal(n.sampled, 3);
  assert.equal(n.sold, 1);
  assert.equal(n.flav[0].sampled, 0);
  for (const bad of ["s", "b", "n", "X", "", "SB", null, undefined, 5]) M.addTap(v, bad, T0 + 5000, 0);
  assert.equal(v.tapK, "SSBS");
  assert.equal(v.tapT.length, 4);
  // a tasting with no flavours never records one
  const p = v6();
  M.addTap(p, "S", T0 + 1000, 0);
  M.addTap(p, "B", T0 + 2000, 0);
  assert.equal(p.tapF, "--");
  lawful(p); survives(v); survives(p);
});

test("addTap: on a log whose tapF is missing or short, the new mark still lines up with its tap", () => {
  const old = oldVisit("SNS", [10, 20, 30], { endedAt: null, flavours: ["Lime", "Mango"] });
  M.addTap(old, "S", T0 + 40000, 1);
  assert.equal(old.tapK, "SNSS");
  assert.equal(old.tapF, "---1");
  const short = v6(["Lime", "Mango"], { tapT: [1, 2, 3], tapK: "SSS", tapF: "0" });
  M.addTap(short, "B", T0 + 4000, 0);
  assert.equal(short.tapF, "0--0");
  assert.deepEqual(numbers(short).flav, [["Lime", 1, 1], ["Mango", 0, 0]]);
  // the tap times never go backwards, whatever the clock does
  M.addTap(short, "S", T0 + 1000, 1);
  assert.deepEqual(short.tapT, [1, 2, 3, 4, 4]);
  lawful(old); lawful(short); survives(old); survives(short);
});

/* ── removeTapAt ──────────────────────────────────────── */
test("removeTapAt: takes one tap out of all three lists — at the start, in the middle, at the end", () => {
  const build = () => tap(v6(["Lime", "Mango"]), "S0 B1 N S1 S");
  let v = build();
  assert.deepEqual([v.tapT, v.tapK, v.tapF], [[10, 20, 30, 40, 50], "SBNSS", "01-1-"]);

  assert.equal(M.removeTapAt(v, 0), true);
  assert.deepEqual([v.tapT, v.tapK, v.tapF], [[20, 30, 40, 50], "BNSS", "1-1-"]);
  assert.deepEqual(numbers(v), { sampled: 2, declined: 1, talked: 3, sold: 1, plain: [1, 0], flav: [["Lime", 0, 0], ["Mango", 1, 1]] });

  v = build();
  assert.equal(M.removeTapAt(v, 2), true);
  assert.deepEqual([v.tapT, v.tapK, v.tapF], [[10, 20, 40, 50], "SBSS", "011-"]);
  assert.deepEqual(numbers(v), { sampled: 3, declined: 0, talked: 3, sold: 1, plain: [1, 0], flav: [["Lime", 1, 0], ["Mango", 1, 1]] });

  v = build();
  assert.equal(M.removeTapAt(v, 4), true);
  assert.deepEqual([v.tapT, v.tapK, v.tapF], [[10, 20, 30, 40], "SBNS", "01-1"]);
  lawful(v); survives(v);

  for (const i of [-1, 4, 99, NaN, undefined]) assert.equal(M.removeTapAt(v, i), false, String(i));
  assert.equal(v.tapK, "SBNS");
});

test("removeTapAt: on a log with a short or missing tapF the marks of the other taps stay with their taps", () => {
  const v = v6(["Lime", "Mango"], { tapT: [1, 2, 3, 4], tapK: "SSSB", tapF: "01" });
  assert.equal(M.removeTapAt(v, 3), true);
  assert.deepEqual(numbers(v).flav, [["Lime", 1, 0], ["Mango", 1, 0]]);
  assert.equal(M.removeTapAt(v, 0), true);
  assert.deepEqual(numbers(v), { sampled: 2, declined: 0, talked: 2, sold: 0, plain: [1, 0], flav: [["Lime", 0, 0], ["Mango", 1, 0]] });
  lawful(v);
  const old = oldVisit("SNS", [10, 20, 30]);
  assert.equal(M.removeTapAt(old, 1), true);
  assert.deepEqual([old.tapT, old.tapK], [[10, 30], "SS"]);
  lawful(old); survives(old);
  const empty = v6();
  assert.equal(M.removeTapAt(empty, 0), false);
});

/* ── undo ─────────────────────────────────────────────── */
test("undoKind: takes off the newest counted tap of exactly that kind and flavour, wherever it sits", () => {
  const v = v6(["Lime", "Mango", "Berry"]);
  //         0  1  2  3  4  5 6  7  8 9
  tap(v, "S0 S1 B0 S1 S2 B1 S N B S0");
  assert.equal(v.tapK, "SSBSSBSNBS");
  assert.equal(v.tapF, "010121---0");

  assert.deepEqual(M.undoKind(v, "S", 1), { kind: "S", flavour: 1, t: 40, index: 3 });
  assert.equal(v.tapK, "SSBsSBSNBS");
  assert.deepEqual(M.undoKind(v, "S", 1), { kind: "S", flavour: 1, t: 20, index: 1 }, "the next newest, skipping the one already off");
  assert.equal(M.undoKind(v, "S", 1), null, "none left of that flavour");
  assert.equal(v.tapK, "SsBsSBSNBS", "no other flavour was touched");

  assert.deepEqual(M.undoKind(v, "B", 0), { kind: "B", flavour: 0, t: 30, index: 2 });
  assert.equal(M.undoKind(v, "B", 0), null);
  assert.deepEqual(M.undoKind(v, "B"), { kind: "B", flavour: -1, t: 90, index: 8 }, "left out = sold with no flavour");
  assert.equal(M.undoKind(v, "B", -1), null, "Mango's sale is not a sale with no flavour");
  assert.deepEqual(M.undoKind(v, "S", -1), { kind: "S", flavour: -1, t: 70, index: 6 });
  assert.equal(M.undoKind(v, "S"), null, "samples of a flavour are not samples with no flavour");
  assert.equal(v.tapK, "SsbsSBsNbS");
  assert.equal(v.tapF, "010121---0", "undo never changes a mark");
  assert.deepEqual(v.tapT, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.deepEqual(numbers(v), {
    sampled: 3, declined: 1, talked: 4, sold: 1, plain: [0, 0],
    flav: [["Lime", 2, 0], ["Mango", 0, 1], ["Berry", 1, 0]]
  });
  lawful(v); survives(v);
});

test("undoKind: a rejection ignores the flavour; a flavour or kind that does not exist gives null and changes nothing", () => {
  const v = v6(["Lime", "Mango"]);
  tap(v, "N S0 N B1");
  assert.deepEqual(M.undoKind(v, "N", 1), { kind: "N", flavour: -1, t: 30, index: 2 });
  assert.deepEqual(M.undoKind(v, "N"), { kind: "N", flavour: -1, t: 10, index: 0 });
  assert.equal(M.undoKind(v, "N"), null);
  const k = v.tapK;
  assert.equal(M.undoKind(v, "S", 2), null);
  assert.equal(M.undoKind(v, "S", 9), null);
  assert.equal(M.undoKind(v, "B", 0), null);
  assert.equal(M.undoKind(v, "S", 1), null);
  for (const bad of ["s", "X", "", null, undefined, "SB"]) assert.equal(M.undoKind(v, bad, 0), null, String(bad));
  assert.equal(v.tapK, k);
  assert.equal(M.undoKind(v6(), "S"), null, "an empty log");
  assert.equal(M.undoKind(oldVisit(""), "S"), null);
  // null means "no flavour", as it does for addTap
  tap(v, "S");
  assert.deepEqual(M.undoKind(v, "S", null), { kind: "S", flavour: -1, t: 50, index: 4 });
  lawful(v); survives(v);
});

test("undoKind: on an old tasting (no tapF) every sample is a sample with no flavour", () => {
  const v = oldVisit("SNS", [10, 20, 30]);
  assert.deepEqual(M.undoKind(v, "S"), { kind: "S", flavour: -1, t: 30, index: 2 });
  assert.equal(M.undoKind(v, "S", 0), null);
  assert.equal(v.tapK, "SNs");
  assert.equal(M.undoKind(v, "B"), null);
  lawful(v); survives(v);
});

test("redoAt: puts a taken-off tap back — sold taps too — and nothing else", () => {
  const v = v6(["Lime", "Mango"]);
  tap(v, "B1 S0 B B1 N");
  const offB1 = M.undoKind(v, "B", 1);
  const offB = M.undoKind(v, "B");
  const offN = M.undoKind(v, "N");
  assert.equal(v.tapK, "BSbbn");
  assert.equal(M.counts(v).sold, 1);

  assert.deepEqual(M.redoAt(v, offB1.index), { kind: "B", flavour: 1, t: 40, index: 3 });
  assert.deepEqual(M.redoAt(v, offB.index), { kind: "B", flavour: -1, t: 30, index: 2 });
  assert.deepEqual(M.redoAt(v, offN.index), { kind: "N", flavour: -1, t: 50, index: 4 });
  assert.equal(v.tapK, "BSBBN");
  assert.deepEqual(numbers(v), { sampled: 1, declined: 1, talked: 2, sold: 3, plain: [0, 1], flav: [["Lime", 1, 0], ["Mango", 0, 2]] });

  assert.equal(M.redoAt(v, 3), null, "a counted tap is not put back twice");
  for (const i of [-1, 5, 99, undefined, NaN]) assert.equal(M.redoAt(v, i), null, String(i));
  assert.equal(v.tapK, "BSBBN");
  // a sample put back keeps its flavour
  const s = M.undoKind(v, "S", 0);
  assert.deepEqual(M.redoAt(v, s.index), { kind: "S", flavour: 0, t: 20, index: 1 });
  assert.equal(v.tapF, "10-1-");
  lawful(v); survives(v);
});

test("undoTap / redoTap / peekUndo / peekRedo: a sold tap is a counted tap like the others, and its flavour comes with it", () => {
  const v = v6(["Lime", "Mango"]);
  tap(v, "S0 N B1");
  assert.deepEqual(M.peekUndo(v), { kind: "B", t: 30, flavour: 1 });
  assert.equal(M.peekRedo(v), null);
  assert.deepEqual(M.undoTap(v), { kind: "B", t: 30, flavour: 1 });
  assert.equal(v.tapK, "SNb");
  assert.equal(M.counts(v).sold, 0);
  assert.deepEqual(M.peekUndo(v), { kind: "N", t: 20, flavour: -1 });
  assert.deepEqual(M.peekRedo(v), { kind: "B", t: 30, flavour: 1 });
  assert.deepEqual(M.undoTap(v), { kind: "N", t: 20, flavour: -1 });
  assert.deepEqual(M.undoTap(v), { kind: "S", t: 10, flavour: 0 });
  assert.equal(M.undoTap(v), null);
  assert.equal(M.peekUndo(v), null);
  assert.equal(v.tapK, "snb");
  assert.deepEqual(M.redoTap(v), { kind: "S", t: 10, flavour: 0 });
  assert.deepEqual(M.redoTap(v), { kind: "N", t: 20, flavour: -1 });
  assert.deepEqual(M.redoTap(v), { kind: "B", t: 30, flavour: 1 });
  assert.equal(M.redoTap(v), null);
  assert.equal(v.tapK, "SNB");
  assert.equal(v.tapF, "0-1");
  // a log of sold taps only: Undo still has something to take off
  const b = tap(v6(), "B B");
  assert.deepEqual(M.peekUndo(b), { kind: "B", t: 20, flavour: -1 });
  assert.deepEqual(M.undoTap(b), { kind: "B", t: 20, flavour: -1 });
  assert.equal(M.counts(b).sold, 1);
  lawful(v); survives(v); lawful(b);
});

/* ── countOf / setCount / bumpCount ───────────────────── */
test("countOf: the number each count shows", () => {
  const v = v6(["Lime", "Mango"]);
  tap(v, "S S0 S0 S1 B B1 B1 B1 N N N N");
  assert.equal(M.countOf(v, "S"), 1);
  assert.equal(M.countOf(v, "S", -1), 1);
  assert.equal(M.countOf(v, "S", 0), 2);
  assert.equal(M.countOf(v, "S", 1), 1);
  assert.equal(M.countOf(v, "B"), 1);
  assert.equal(M.countOf(v, "B", 0), 0);
  assert.equal(M.countOf(v, "B", 1), 3);
  assert.equal(M.countOf(v, "N"), 4);
  assert.equal(M.countOf(v, "N", 1), 4, "rejected is one number for the whole tasting");
  v.adjF = [-9, 2]; v.adjBF = [1, -1]; v.adjS = 3; v.adjB = -4; v.adjN = -1;
  assert.deepEqual(["S", "B"].flatMap(k => [-1, 0, 1].map(f => M.countOf(v, k, f))), [4, 0, 3, 0, 1, 2]);
  assert.equal(M.countOf(v, "N"), 3);
  const old = oldVisit("SSN");
  assert.deepEqual([M.countOf(old, "S"), M.countOf(old, "N"), M.countOf(old, "B")], [2, 1, 0]);
});

test("setCount: every kind and every flavour — stored as a correction, the tap log is never rewritten", () => {
  const v = v6(["Lime", "Mango"]);
  tap(v, "S S0 S0 S1 B B1 B1 N N");
  const log = json([v.tapT, v.tapK, v.tapF]);

  M.setCount(v, "S", -1, 6);
  M.setCount(v, "S", 0, 0);
  M.setCount(v, "S", 1, 19);
  M.setCount(v, "B", -1, 0);
  M.setCount(v, "B", 0, 4);
  M.setCount(v, "B", 1, 1);
  M.setCount(v, "N", -1, 12);
  assert.deepEqual([v.tapT, v.tapK, v.tapF], log, "the log is untouched");
  assert.deepEqual([v.adjS, v.adjB, v.adjN, v.adjF, v.adjBF], [5, -1, 10, [-2, 18], [4, -1]]);
  assert.deepEqual(numbers(v), {
    sampled: 25, declined: 12, talked: 37, sold: 5, plain: [6, 0],
    flav: [["Lime", 0, 4], ["Mango", 19, 1]]
  });
  for (const [k, f, want] of [["S", -1, 6], ["S", 0, 0], ["S", 1, 19], ["B", -1, 0], ["B", 0, 4], ["B", 1, 1], ["N", -1, 12]]) {
    assert.equal(M.countOf(v, k, f), want, `${k} ${f}`);
  }
  // setting a count again replaces the correction, it does not add to it
  M.setCount(v, "S", 1, 3);
  assert.equal(M.countOf(v, "S", 1), 3);
  // and the taps made afterwards count on top
  tap(v, "S1 B0 N");
  assert.deepEqual([M.countOf(v, "S", 1), M.countOf(v, "B", 0), M.countOf(v, "N")], [4, 5, 13]);
  lawful(v); survives(v);
});

test("setCount: below zero becomes 0, a fraction is rounded, something that is not a number becomes 0", () => {
  const v = v6(["Lime"]);
  tap(v, "S S0 B N");
  M.setCount(v, "S", 0, -4);
  assert.equal(M.countOf(v, "S", 0), 0);
  M.setCount(v, "S", -1, 2.6);
  assert.equal(M.countOf(v, "S"), 3);
  M.setCount(v, "B", -1, "7");
  assert.equal(M.countOf(v, "B"), 7);
  M.setCount(v, "N", -1, "abc");
  assert.equal(M.countOf(v, "N"), 0);
  M.setCount(v, "B", 0, NaN);
  assert.equal(M.countOf(v, "B", 0), 0);
  M.setCount(v, "S", 0, undefined);
  assert.equal(M.countOf(v, "S", 0), 0);
  assert.equal(v.tapK, "SSBN");
  lawful(v); survives(v);
});

test("setCount: on an old tasting the missing correction fields are made as needed", () => {
  const v = oldVisit("SSN");
  M.setCount(v, "S", -1, 5);
  assert.equal(v.adjS, 3);
  assert.equal(M.tracksSold(v), false, "typing a sample count does not start tracking sold");
  M.setCount(v, "B", -1, 2);
  assert.equal(v.adjB, 2);
  assert.equal(M.tracksSold(v), true);
  v.flavours = ["Lime", "Mango"];                 // flavours set with no adjF / adjBF beside them
  M.setCount(v, "S", 1, 4);
  M.setCount(v, "B", 0, 1);
  assert.deepEqual([v.adjF, v.adjBF], [[0, 4], [1, 0]]);
  assert.deepEqual(numbers(v), { sampled: 9, declined: 1, talked: 10, sold: 3, plain: [5, 2], flav: [["Lime", 0, 1], ["Mango", 4, 0]] });
  lawful(v); survives(v);
});

test("bumpCount: moves every kind of count by a delta, never below 0", () => {
  const v = v6(["Lime", "Mango"]);
  tap(v, "S S0 B1 N");
  M.bumpCount(v, "S", -1, 2);
  M.bumpCount(v, "S", 0, 1);
  M.bumpCount(v, "S", 1, 3);
  M.bumpCount(v, "B", -1, 1);
  M.bumpCount(v, "B", 0, 2);
  M.bumpCount(v, "B", 1, -1);
  M.bumpCount(v, "N", -1, 5);
  assert.deepEqual(numbers(v), { sampled: 8, declined: 6, talked: 14, sold: 3, plain: [3, 1], flav: [["Lime", 2, 2], ["Mango", 3, 0]] });
  assert.equal(v.tapK, "SSBN", "the log is not rewritten");

  M.bumpCount(v, "S", 0, -50);
  M.bumpCount(v, "B", 1, -1);
  M.bumpCount(v, "N", -1, -6);
  M.bumpCount(v, "N", -1, -1);
  assert.deepEqual([M.countOf(v, "S", 0), M.countOf(v, "B", 1), M.countOf(v, "N")], [0, 0, 0]);
  // after hitting the floor, the next +1 shows as 1 (the floor did not leave a debt behind)
  M.bumpCount(v, "S", 0, 1);
  M.bumpCount(v, "N", -1, 1);
  M.bumpCount(v, "B", 1, 1);
  assert.deepEqual([M.countOf(v, "S", 0), M.countOf(v, "N"), M.countOf(v, "B", 1)], [1, 1, 1]);
  // a delta of 0 or of nonsense changes nothing
  const before = numbers(v);
  M.bumpCount(v, "S", 1, 0);
  M.bumpCount(v, "B", -1, "x");
  M.bumpCount(v, "N", -1, NaN);
  assert.deepEqual(numbers(v), before);
  lawful(v); survives(v);
});

test("bumpCount: a correction typed straight into the data that is far below zero does not swallow the next +1", () => {
  const v = v6(["Lime"]);
  tap(v, "S0 S0 S B");
  v.adjF = [-10]; v.adjS = -10; v.adjB = -10; v.adjN = -10;
  assert.deepEqual(numbers(v), { sampled: 0, declined: 0, talked: 0, sold: 0, plain: [0, 0], flav: [["Lime", 0, 0]] });
  M.bumpCount(v, "S", 0, 1);
  M.bumpCount(v, "S", -1, 1);
  M.bumpCount(v, "B", -1, 1);
  M.bumpCount(v, "N", -1, 1);
  assert.deepEqual(numbers(v), { sampled: 2, declined: 1, talked: 3, sold: 1, plain: [1, 1], flav: [["Lime", 1, 0]] });
  lawful(v); survives(v);
});

test("setCount / bumpCount on a flavour that does not exist: no flavour's count changes, nothing breaks", () => {
  const v = v6(["Lime", "Mango"]);
  tap(v, "S0 S1 S1 B0 N");
  const flavBefore = numbers(v).flav, declined = M.counts(v).declined;
  M.setCount(v, "S", 2, 9);
  M.setCount(v, "B", 7, 9);
  M.bumpCount(v, "S", 5, 3);
  M.bumpCount(v, "B", 99, 3);
  assert.deepEqual(numbers(v).flav, flavBefore);
  assert.equal(M.counts(v).declined, declined);
  assert.equal(v.adjF.length, 2);
  assert.equal(v.adjBF.length, 2);
  assert.equal(v.tapK, "SSSBN");
  // a rejection has no flavour, so any flavour number means the one rejected count
  M.setCount(v, "N", 7, 4);
  assert.equal(M.countOf(v, "N"), 4);
  M.bumpCount(v, "N", 1, 1);
  assert.equal(M.countOf(v, "N", 3), 5);
  lawful(v); survives(v);
});

test("countOf / setCount / bumpCount with flavour null mean 'no flavour', as addTap and undoKind do",
  () => {
    const v = v6(["Lime", "Mango"]);
    tap(v, "S S0");
    assert.equal(M.countOf(v, "S", null), 1);
    M.setCount(v, "S", null, 5);
    assert.equal(M.countOf(v, "S", -1), 5);
    M.bumpCount(v, "B", null, 2);
    assert.equal(M.countOf(v, "B", -1), 2);
    assert.deepEqual(numbers(v).flav, [["Lime", 1, 0], ["Mango", 0, 0]]);
    lawful(v); survives(v);
  });

/* ── removeFlavour ────────────────────────────────────── */
test("flavourIsEmpty: true only when nothing is counted for that flavour — taps or corrections, samples or sold", () => {
  const v = v6(["Lime", "Mango", "Berry", "Peach"]);
  tap(v, "S0 B1 S2");
  M.undoKind(v, "S", 2);
  v.adjBF = [0, 0, 0, 1];
  assert.deepEqual([0, 1, 2, 3].map(i => M.flavourIsEmpty(v, i)), [false, false, true, false]);
  assert.equal(M.flavourIsEmpty(v, 4), false, "no such flavour");
  assert.equal(M.flavourIsEmpty(v, -1), false);
  assert.equal(M.flavourIsEmpty(v6(), 0), false);
});

test("removeFlavour in the middle: later flavours move up and their taps and corrections move with them; every other number is unchanged", () => {
  const v = v6(["Apple", "Banana", "Cherry", "Date"]);
  //       0  1  2  3  4  5  6  7  8  9 10 11 12 13 14
  tap(v, "S0 S0 S2 S1 S2 S2 B2 S3 B3 B1 B3 S  B  N  N");
  M.undoKind(v, "S", 1);                       // Banana's taps are taken off, so it has nothing counted
  M.undoKind(v, "B", 1);
  M.setCount(v, "S", -1, 3);                   // corrections on every other part
  M.setCount(v, "B", -1, 2);
  M.setCount(v, "N", -1, 3);
  M.setCount(v, "S", 0, 3);
  M.setCount(v, "S", 2, 2);
  M.setCount(v, "S", 3, 5);
  M.setCount(v, "B", 2, 3);
  M.setCount(v, "B", 3, 3);
  assert.deepEqual([v.adjF, v.adjBF], [[1, 0, -1, 4], [0, 0, 2, 1]]);
  const before = numbers(v);
  assert.deepEqual(before, {
    sampled: 13, declined: 3, talked: 16, sold: 8, plain: [3, 2],
    flav: [["Apple", 3, 0], ["Banana", 0, 0], ["Cherry", 2, 3], ["Date", 5, 3]]
  });
  const times = v.tapT.slice();

  assert.equal(M.removeFlavour(v, 1), true);

  assert.deepEqual(v.flavours, ["Apple", "Cherry", "Date"]);
  assert.deepEqual([v.adjF, v.adjBF], [[1, -1, 4], [0, 2, 1]], "the corrections moved up with their flavours");
  assert.equal(v.tapF, "001-11122-2----");
  assert.equal(v.tapK, "SSSxSSBSBxBSBNN");
  assert.deepEqual(v.tapT, times);
  assert.deepEqual(numbers(v), {
    sampled: 13, declined: 3, talked: 16, sold: 8, plain: [3, 2],
    flav: [["Apple", 3, 0], ["Cherry", 2, 3], ["Date", 5, 3]]
  });
  assert.deepEqual([v.adjS, v.adjB, v.adjN], [2, 1, 1]);
  // the places now mean the flavours that moved up
  tap(v, "S1 B2");
  assert.deepEqual(numbers(v).flav, [["Apple", 3, 0], ["Cherry", 3, 3], ["Date", 5, 4]]);
  assert.deepEqual(M.undoKind(v, "S", 2), { kind: "S", flavour: 2, t: 80, index: 7 }, "Date's own sample, not Cherry's");
  lawful(v); survives(v);
});

test("removeFlavour: the mark string after a removal, spelled out", () => {
  // S of A, a taken-off s of B, S of C, a taken-off b of B, B of C, N: B has nothing counted
  const v = v6(["A", "B", "C"], { tapT: [1, 2, 3, 4, 5, 6], tapK: "SxSxBN", tapF: "01212-" });
  assert.equal(M.removeFlavour(v, 1), true);
  assert.equal(v.tapF, "0-1-1-");
  assert.equal(v.tapK, "SxSxBN");
  assert.deepEqual(numbers(v), { sampled: 2, declined: 1, talked: 3, sold: 1, plain: [0, 0], flav: [["A", 1, 0], ["C", 1, 1]] });
  lawful(v); survives(v);
});

test("removeFlavour: taken-off taps of the removed flavour stay in the log, off, with no flavour — and do not turn into plain counts", () => {
  const v = v6(["Lime", "Mango"]);
  tap(v, "S1 S1 B1 S0 S B");
  M.undoKind(v, "S", 1); M.undoKind(v, "S", 1); M.undoKind(v, "B", 1);
  assert.equal(v.tapK, "ssbSSB");
  const before = numbers(v);
  assert.equal(M.removeFlavour(v, 1), true);
  assert.equal(v.tapK, "xxxSSB", "taps of the removed flavour are marked x: off for good");
  assert.equal(v.tapF, "---0--");
  assert.equal(v.tapT.length, 6, "the log only loses taps through removeTapAt");
  assert.deepEqual(numbers(v), { ...before, flav: [["Lime", 1, 0]] });
  assert.deepEqual(numbers(v).plain, [1, 1]);
  lawful(v); survives(v);
});

test("removeFlavour: a flavour whose taps were cancelled by a hand correction can go, and its taps do not come back as plain counts", () => {
  const v = v6(["Lime", "Mango"]);
  tap(v, "S0 S0 B0 S1 S N");
  M.setCount(v, "S", 0, 0);                    // typed 0 over two taps
  M.setCount(v, "B", 0, 0);
  assert.equal(M.flavourIsEmpty(v, 0), true);
  const before = numbers(v);
  assert.equal(M.removeFlavour(v, 0), true);
  assert.deepEqual(v.flavours, ["Mango"]);
  assert.deepEqual(numbers(v), {
    sampled: before.sampled, declined: before.declined, talked: before.talked, sold: before.sold,
    plain: before.plain, flav: [["Mango", 1, 0]]
  });
  assert.deepEqual(numbers(v), { sampled: 2, declined: 1, talked: 3, sold: 0, plain: [1, 0], flav: [["Mango", 1, 0]] });
  assert.deepEqual([v.adjF, v.adjBF], [[0], [0]]);
  assert.equal(v.tapK.length, 6);
  lawful(v); survives(v);
});

test("removeFlavour: refused while something is counted for it, and for a place that does not exist", () => {
  const v = v6(["Lime", "Mango", "Berry", "Peach"]);
  tap(v, "S0 B1 S");
  M.setCount(v, "S", 2, 1);                    // counted by hand only
  v.adjBF[3] = 2;                              // sold by hand only
  const snapshot = json(v);
  for (const i of [0, 1, 2, 3]) assert.equal(M.removeFlavour(v, i), false, `place ${i} has something counted`);
  for (const i of [4, -1, 99, NaN, undefined]) assert.equal(M.removeFlavour(v, i), false, String(i));
  assert.deepEqual(v, snapshot, "a refusal changes nothing");
  assert.equal(M.removeFlavour(v6(), 0), false);
  assert.equal(M.removeFlavour(oldVisit("SS"), 0), false);
  // once the sample is taken off, the flavour can go
  M.undoKind(v, "S", 0);
  assert.equal(M.removeFlavour(v, 0), true);
  assert.deepEqual(v.flavours, ["Mango", "Berry", "Peach"]);
  assert.deepEqual(numbers(v).flav, [["Mango", 0, 1], ["Berry", 1, 0], ["Peach", 0, 2]]);
  lawful(v); survives(v);
});

test("removeFlavour: the first and the last place; removing them all leaves a plain tasting", () => {
  const v = v6(["Lime", "Mango", "Berry"]);
  tap(v, "S1 B1 S N");
  assert.equal(M.removeFlavour(v, 2), true, "the last one");
  assert.deepEqual(v.flavours, ["Lime", "Mango"]);
  assert.equal(v.tapF, "11--");
  assert.equal(M.removeFlavour(v, 0), true, "the first one");
  assert.deepEqual(v.flavours, ["Mango"]);
  assert.equal(v.tapF, "00--");
  assert.deepEqual(numbers(v), { sampled: 2, declined: 1, talked: 3, sold: 1, plain: [1, 0], flav: [["Mango", 1, 1]] });
  assert.equal(M.removeFlavour(v, 0), false);
  M.undoKind(v, "S", 0); M.undoKind(v, "B", 0);
  assert.equal(M.removeFlavour(v, 0), true);
  assert.deepEqual([v.flavours, v.adjF, v.adjBF], [[], [], []]);
  assert.deepEqual(numbers(v), { sampled: 1, declined: 1, talked: 2, sold: 0, plain: [1, 0], flav: [] });
  lawful(v); survives(v);
});

test("removeFlavour: a rejection whose mark (in a damaged log) names the removed flavour is still a rejection afterwards",
  () => {
    const v = v6(["Lime", "Mango"], { tapT: [1, 2, 3], tapK: "NNS", tapF: "1-0" });
    assert.equal(M.counts(v).declined, 2);
    assert.equal(M.removeFlavour(v, 1), true);
    assert.equal(M.counts(v).declined, 2);
  });

test("removeFlavour: a taken-off tap of the removed flavour cannot be put back afterwards as a sample with no flavour",
  () => {
    const v = v6(["Lime", "Mango"]);
    tap(v, "S0 S1");
    const off = M.undoKind(v, "S", 1);
    assert.equal(M.removeFlavour(v, 1), true);
    assert.equal(M.peekRedo(v), null);
    assert.equal(M.redoTap(v), null);
    assert.equal(M.redoAt(v, off.index), null);
    assert.deepEqual(numbers(v), { sampled: 1, declined: 0, talked: 1, sold: 0, plain: [0, 0], flav: [["Lime", 1, 0]] });
  });

test("addTap: a tap always raises its count by one, also after an undo beneath a typed-over number",
  () => {
    const v = v6(["Lime"]);
    tap(v, "S0 S0 S0 S S B B N N");
    M.setCount(v, "S", 0, 0); M.setCount(v, "S", -1, 0); M.setCount(v, "B", -1, 0); M.setCount(v, "N", -1, 0);
    M.undoKind(v, "S", 0); M.undoKind(v, "S"); M.undoKind(v, "B"); M.undoKind(v, "N");
    assert.deepEqual(numbers(v), { sampled: 0, declined: 0, talked: 0, sold: 0, plain: [0, 0], flav: [["Lime", 0, 0]] });
    tap(v, "S0 S B N");
    assert.deepEqual(numbers(v), { sampled: 2, declined: 1, talked: 3, sold: 1, plain: [1, 1], flav: [["Lime", 1, 0]] });
  });

test("a mark that points past the list does not become a real flavour when one is added later",
  () => {
    const v = v6(["Lime", "Mango"], { tapT: [1, 2, 3], tapK: "SSB", tapF: "022" });
    assert.deepEqual(numbers(v).plain, [1, 1]);
    assert.equal(M.addFlavour(v, "Berry"), 2);
    assert.deepEqual(numbers(v).flav[2], ["Berry", 0, 0], "a new flavour starts with nothing counted");
    assert.deepEqual(numbers(v).plain, [1, 1]);
  });

/* ── times that follow the taps ───────────────────────── */
test("lastTapMs / suggestPaidEnd: a sold tap is a count like the others; a taken-off one is not", () => {
  const v = v6(["Lime"]);
  assert.equal(M.lastTapMs(v), null);
  M.addTap(v, "S", at(10, 5), 0);
  M.addTap(v, "B", at(11, 0), 0);
  assert.equal(M.lastTapMs(v), at(11, 0));
  assert.deepEqual(M.suggestPaidEnd(v, at(11, 30), 15), { paidEnd: "11:00", from: "lastCount" });
  assert.deepEqual(M.suggestPaidEnd(v, at(11, 10), 15), { paidEnd: "11:15", from: "now" });
  M.undoKind(v, "B", 0);
  assert.equal(M.lastTapMs(v), at(10, 5));
  // a tasting on which only sales were counted
  const b = v6();
  M.addTap(b, "B", at(12, 0));
  assert.equal(M.lastTapMs(b), at(12, 0));
  assert.deepEqual(M.suggestPaidEnd(b, at(13, 0), 15), { paidEnd: "12:00", from: "lastCount" });
  survives(v);
});

test("lateTaps / lateTapInfo: sold taps alone are never late taps; a sample or a rejection after a long gap is", () => {
  const v = v6(["Lime"]);
  tap(v, "S0 S0 N", 60);                      // 60, 70, 80 seconds
  tap(v, "B0 B", 80 + 30 * 60);               // bottles sold typed in half an hour later: real work, not a pocket
  assert.equal(M.lateTaps(v), 0);
  assert.equal(M.lateTapInfo(v), null);
  tap(v, "S0", 80 + 31 * 60);                 // a sample 31 minutes after the last people-count
  assert.equal(M.lateTaps(v), 1);
  assert.deepEqual(M.lateTapInfo(v), { n: 1, gapMin: 31, firstMs: T0 + (80 + 31 * 60) * 1000 });
  assert.equal(M.lateTaps(v, 45), 0);
  assert.equal(M.lateTapInfo(v, 45), null);
  // the gap is measured between people-counts: a sale in between does not shorten it
  const w = v6();
  tap(w, "S", 60);
  tap(w, "B", 60 + 15 * 60);
  tap(w, "S", 60 + 30 * 60);
  assert.equal(M.lateTaps(w), 1, "30 minutes between two samples, whatever was sold in between");
});

test("dropLateTaps: removes the late samples and rejections but keeps the sales around them, and tapF stays in step", () => {
  const v = v6(["Lime", "Mango"]);
  tap(v, "S0 S1 B1 N S", 60);
  tap(v, "B0 S1 B", 100 + 25 * 60);           // a sale (real), then a late sample, then another sale
  assert.equal(v.tapF, "011--01-");
  assert.equal(M.dropLateTaps(v), 1, "one late people-count is reported");
  // only the late sample goes; the two sales on either side of it stay, so no bottle is lost
  assert.deepEqual([v.tapT, v.tapK, v.tapF], [[60, 70, 80, 90, 100, 1600, 1620], "SSBNSBB", "011--0-"]);
  assert.deepEqual(numbers(v), { sampled: 3, declined: 1, talked: 4, sold: 3, plain: [1, 1], flav: [["Lime", 1, 1], ["Mango", 1, 1]] });
  assert.equal(M.dropLateTaps(v), 0, "nothing late is left");
  lawful(v); survives(v);

  // a short tapF, an over-long tapF and no tapF at all: the lists still end the same length
  const short = v6(["Lime"], { tapT: [10, 20, 3000], tapK: "SSS", tapF: "0" });
  assert.equal(M.dropLateTaps(short), 1);
  assert.deepEqual([short.tapT, short.tapK, aligned(short)], [[10, 20], "SS", "0-"]);
  const long = v6(["Lime"], { tapT: [10, 20, 3000], tapK: "SSS", tapF: "00000000" });
  assert.equal(M.dropLateTaps(long), 1);
  assert.deepEqual([long.tapT, long.tapK, long.tapF], [[10, 20], "SS", "00"]);
  const old = oldVisit("SNS", [10, 20, 3000]);
  assert.equal(M.dropLateTaps(old), 1);
  assert.deepEqual([old.tapT, old.tapK], [[10, 20], "SN"]);
  assert.equal(M.tracksSold(old), false);
  lawful(short); lawful(long); lawful(old); survives(old);
});

test("unstartVisit: the log and every correction go, the flavours stay", () => {
  const v = v6(["Lime", "Mango"], { brand: "Vok", comments: "Loved the lime", note: "busy" });
  tap(v, "S0 S1 B1 N S B");
  M.setCount(v, "S", 0, 9); M.setCount(v, "B", 1, 4); M.setCount(v, "S", -1, 3);
  M.setCount(v, "B", -1, 2); M.setCount(v, "N", -1, 8);
  M.unstartVisit(v);
  assert.deepEqual([v.startedAt, v.endedAt], [null, null]);
  assert.deepEqual([v.tapT, v.tapK, v.tapF], [[], "", ""]);
  assert.deepEqual([v.adjS, v.adjN, v.adjB, v.adjF, v.adjBF], [0, 0, 0, [0, 0], [0, 0]]);
  assert.deepEqual(v.flavours, ["Lime", "Mango"]);
  assert.deepEqual([v.brand, v.comments, v.note], ["Vok", "Loved the lime", "busy"]);
  assert.equal(M.isPlanned(v), true);
  assert.deepEqual(numbers(v), { sampled: 0, declined: 0, talked: 0, sold: 0, plain: [0, 0], flav: [["Lime", 0, 0], ["Mango", 0, 0]] });
  // counting again starts clean
  M.startVisit(v, at(12, 0));
  M.addTap(v, "S", at(12, 1), 1);
  assert.deepEqual([v.tapT, v.tapK, v.tapF], [[60], "S", "1"]);
  lawful(v); survives(v);
  // a tasting with no flavours
  const p = tap(v6(), "S B N");
  M.unstartVisit(p);
  assert.deepEqual([p.tapT, p.tapK, p.tapF, p.adjF, p.adjBF, p.flavours], [[], "", "", [], [], []]);
  survives(p);
});

/* ── a new tasting ────────────────────────────────────── */
test("a new tasting of any kind starts with empty version-6 fields and tracks sold", () => {
  for (const v of [M.newVisit(PLACE, T0, 15), M.manualVisit(PLACE, "10:00", "14:00", T0), M.plannedVisit(PLACE, "10:00", "14:00", T0)]) {
    assert.deepEqual([v.flavours, v.tapT, v.tapK, v.tapF], [[], [], "", ""]);
    assert.deepEqual([v.adjS, v.adjN, v.adjB, v.adjF, v.adjBF], [0, 0, 0, [], []]);
    assert.equal(v.comments, "");
    assert.equal(M.tracksSold(v), true);
    assert.deepEqual(numbers(v), { sampled: 0, declined: 0, talked: 0, sold: 0, plain: [0, 0], flav: [] });
    lawful(v); survives(v);
  }
});

/* ── restoring from a backup ──────────────────────────── */
const dayOf = (...visits) => ({ v: 1, date: D, updatedAt: 5, paidAs: null, visits, legs: [], parking: [] });

test("cleanBackupDay: a good version-6 tasting comes back exactly as it was saved", () => {
  const v = v6(["Lime", "Mango"], { brand: "Vok", comments: "Too sweet for some.\nLime sold out." });
  tap(v, "S0 S1 B1 N S B S1");
  M.undoKind(v, "S", 1);
  M.setCount(v, "S", 0, 6); M.setCount(v, "B", 1, 3); M.setCount(v, "B", -1, 2);
  M.finishVisit(v, at(14, 0), 15);
  const day = dayOf(json(v));
  const out = M.cleanBackupDay(json(day));
  assert.deepEqual(out.visits[0], v);
  assert.deepEqual(numbers(out.visits[0]), numbers(v));
  assert.deepEqual(M.countLines(out.visits[0]), M.countLines(v));
  survives(out);
});

test("cleanBackupDay: damaged version-6 fields are made safe", () => {
  const raw = dayOf({
    id: "v1", placeId: "a", placeName: "Store A", startedAt: T0, endedAt: T0 + 1000,
    paidStart: "10:00", paidEnd: "14:00", breakMin: 0, note: "",
    flavours: ["  Lime  ", 7, null, "", "x".repeat(40), "Mango"],
    tapT: [1, 2, 3, 4, 5, 6], tapK: "SSSBBN", tapF: "0x 1",
    adjS: 0, adjN: 0, adjB: "3", adjF: [1.6, "2", null, 4, 5], adjBF: "nope", comments: 42
  });
  const v = M.cleanBackupDay(raw).visits[0];
  // every place in the list is kept (a damaged or empty name gets a stand-in), because the taps point at a place
  assert.deepEqual(v.flavours, ["Lime", "Flavour 2", "Flavour 3", "Flavour 4", "x".repeat(24), "Mango"]);
  assert.equal(v.tapF, "0--1--", "junk becomes '-', and the marks are made as long as tapK");
  assert.deepEqual(v.adjF, [2, 0, 0, 4, 5, 0], "whole numbers, one per flavour, each still at its own place");
  assert.deepEqual(v.adjBF, [0, 0, 0, 0, 0, 0]);
  assert.equal(v.adjB, 0);
  assert.equal(v.comments, "");
  lawful(v); survives(v);
  assert.doesNotThrow(() => M.countLines(v));
  assert.ok(!/NaN|undefined/.test(M.reportText({ date: D }, v)));
});

test("cleanBackupDay: a tapF longer than tapK is cut, more than the maximum of flavours are dropped, a missing tapF is filled", () => {
  const base = { id: "v1", placeId: "a", placeName: "Store A", startedAt: T0, endedAt: T0 + 1000, paidStart: "10:00", paidEnd: "14:00" };
  const out = M.cleanBackupDay(dayOf(
    { ...base, flavours: ["A", "B", "C", "D", "E", "F", "G", "H"], tapT: [1, 2], tapK: "SB", tapF: "5512345", adjB: 0, adjF: [1, 2, 3, 4, 5, 6, 7, 8], adjBF: [0, 0, 0, 0, 0, 9, 9, 9] },
    { ...base, id: "v2", flavours: ["Lime"], tapT: [1, 2, 3], tapK: "SsB", adjB: 0 },
    { ...base, id: "v3", flavours: "Lime", tapT: [1], tapK: "S", tapF: 0, adjB: 1, adjF: { 0: 4 } }
  ));
  const [a, b, c] = out.visits;
  assert.equal(a.flavours.length, M.MAX_FLAVOURS);
  assert.equal(a.tapF, "55");
  assert.deepEqual(a.adjF, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(a.adjBF, [0, 0, 0, 0, 0, 9]);
  assert.deepEqual(numbers(a).flav[5], ["F", 7, 10]);
  assert.equal(b.tapF, "---");
  assert.deepEqual([b.adjF, b.adjBF], [[0], [0]]);
  assert.deepEqual([c.flavours, c.tapF, c.adjF, c.adjBF, c.adjB], [[], "-", [], [], 1]);
  for (const v of out.visits) { lawful(v); survives(v); }
});

test("cleanBackupDay: an old tasting is not given a sold count — its report still has no 'Sold' line", () => {
  const old = oldVisit("SSNsN", null, { adjS: 1 });
  const out = M.cleanBackupDay(dayOf(json(old)));
  const v = out.visits[0];
  assert.equal("adjB" in v, false);
  assert.equal(M.tracksSold(v), false);
  assert.deepEqual(v.flavours, []);
  assert.equal(v.tapF, "-----");
  assert.deepEqual([v.adjF, v.adjBF], [[], []]);
  assert.deepEqual(numbers(v), numbers(old));
  assert.deepEqual(M.countLines(v), ["Total interactions: 5", "Samples given: 3", "Rejected or ignored: 2"]);
  assert.ok(!/Sold/.test(M.reportText(out, v)));
  assert.equal("comments" in v, false);
  lawful(v); survives(out);
});

test("cleanBackupDay: a log whose lists do not match is emptied in all three lists", () => {
  const out = M.cleanBackupDay(dayOf({
    id: "v1", placeId: "a", placeName: "Store A", startedAt: T0, endedAt: T0 + 1000, paidStart: "10:00", paidEnd: "14:00",
    flavours: ["Lime"], tapT: [1, 2], tapK: "SSS", tapF: "000", adjB: 0, adjF: [2], adjBF: [1]
  }));
  const v = out.visits[0];
  assert.deepEqual([v.tapT, v.tapK, v.tapF], [[], "", ""]);
  assert.deepEqual(numbers(v), { sampled: 2, declined: 0, talked: 2, sold: 1, plain: [0, 0], flav: [["Lime", 2, 1]] });
  lawful(v); survives(v);
});

/* ── report lines ─────────────────────────────────────── */
test("tracksSold: a version-6 tasting (a number in adjB), any sold tap, or anything sold at all; never an old tasting with nothing sold", () => {
  assert.equal(M.tracksSold(v6()), true);
  assert.equal(M.tracksSold(oldVisit("SSN")), false);
  assert.equal(M.tracksSold(oldVisit("")), false);
  assert.equal(M.tracksSold(oldVisit("SB")), true);
  assert.equal(M.tracksSold(oldVisit("Sb")), true);
  assert.equal(M.tracksSold(oldVisit("SN", null, { adjB: 0 })), true);
  assert.equal(M.tracksSold(oldVisit("SN", null, { adjB: null })), false);
  assert.equal(M.tracksSold(oldVisit("SN", null, { adjB: "2" })), true, "counts() reads it as 2 sold, so the report must show it");
  // Sold typed for a flavour on a tasting from before version 6 (the review's finding): it is in the report
  const typed = oldVisit("SN");
  M.addFlavour(typed, "Lime");
  assert.equal(M.tracksSold(typed), false, "flavours alone do not make it print Sold: 0");
  M.setCount(typed, "B", 0, 3);
  assert.equal(M.tracksSold(typed), true);
  assert.ok(M.countLines(typed).includes("Sold: 3"));
  // and setting plain Sold to the 0 it already is leaves an old tasting old
  const still = oldVisit("SN");
  M.bumpCount(still, "B", -1, -1); M.setCount(still, "B", -1, 0);
  assert.equal(still.adjB, undefined);
  assert.equal(M.tracksSold(still), false);
  // counting it in version 6 (Start counting, or Count more people) makes it track Sold from then on
  const counted = oldVisit("SN");
  M.reopenVisit(counted);
  assert.equal(M.tracksSold(counted), true);
  assert.equal(M.tracksSold(null), false);
  assert.equal(M.tracksSold(undefined), false);
  assert.equal(M.tracksSold({}), false);
});

test("countLines: an old tasting never prints 'Sold: 0'", () => {
  const v = oldVisit("SSSNNs", null, { adjS: 4, adjN: -1 });
  assert.deepEqual(M.countLines(v), ["Total interactions: 8", "Samples given: 7", "Rejected or ignored: 1"]);
  // also after adding flavours to it without counting any sale
  M.addFlavour(v, "Lime");
  assert.ok(!M.countLines(v).some(l => l.startsWith("Sold")));
  assert.deepEqual(M.countLines(oldVisit("")), ["Total interactions: 0", "Samples given: 0", "Rejected or ignored: 0"]);
});

test("countLines: a version-6 tasting with no flavours and nothing sold says 'Sold: 0', with no flavour lines", () => {
  const v = tap(v6(), "S S S N");
  assert.deepEqual(M.countLines(v), ["Total interactions: 4", "Samples given: 3", "Rejected or ignored: 1", "Sold: 0"]);
  tap(v, "B B");
  assert.deepEqual(M.countLines(v), ["Total interactions: 4", "Samples given: 3", "Rejected or ignored: 1", "Sold: 2"]);
  assert.deepEqual(M.countLines(v6()), ["Total interactions: 0", "Samples given: 0", "Rejected or ignored: 0", "Sold: 0"]);
});

test("countLines: flavours — one indented line each, in order, zeros included; 'No flavour' only when that part is not 0", () => {
  const v = v6(["Lime", "Mango", "Berry"]);
  tap(v, "S0 S0 S1 B1 B1 N");
  assert.deepEqual(M.countLines(v), [
    "Total interactions: 4",
    "Samples given: 3",
    "  Lime: 2",
    "  Mango: 1",
    "  Berry: 0",
    "Rejected or ignored: 1",
    "Sold: 2",
    "  Lime: 0",
    "  Mango: 2",
    "  Berry: 0"
  ]);
  tap(v, "S S");                               // samples with no flavour, nothing sold with no flavour
  assert.deepEqual(M.countLines(v), [
    "Total interactions: 6",
    "Samples given: 5",
    "  Lime: 2",
    "  Mango: 1",
    "  Berry: 0",
    "  No flavour: 2",
    "Rejected or ignored: 1",
    "Sold: 2",
    "  Lime: 0",
    "  Mango: 2",
    "  Berry: 0"
  ]);
  tap(v, "B");
  M.setCount(v, "S", -1, 0);                   // now the other way round: sold with no flavour only
  assert.deepEqual(M.countLines(v), [
    "Total interactions: 4",
    "Samples given: 3",
    "  Lime: 2",
    "  Mango: 1",
    "  Berry: 0",
    "Rejected or ignored: 1",
    "Sold: 3",
    "  Lime: 0",
    "  Mango: 2",
    "  Berry: 0",
    "  No flavour: 1"
  ]);
  // the flavour lines of each block add up to the line above them
  const sum = (lines, from, to) => lines.slice(from, to).reduce((a, l) => a + Number(l.split(": ")[1]), 0);
  const lines = M.countLines(v);
  assert.equal(sum(lines, 2, 5), 3);
  assert.equal(sum(lines, 7, 11), 3);
  survives(v);
});

test("countLines: customer comments go on one line, line breaks and all; empty comments print nothing", () => {
  const v = tap(v6(["Lime"]), "S0 N");
  v.comments = "  Loved the lime.\r\n\r\nToo sweet\tfor some.\n  Asked for a bigger bottle.  ";
  const lines = M.countLines(v);
  assert.equal(lines[lines.length - 1], "Customer comments: Loved the lime. Too sweet for some. Asked for a bigger bottle.");
  assert.ok(lines.every(l => !/[\r\n\t]/.test(l)));
  assert.equal(lines.filter(l => l.startsWith("Customer comments")).length, 1);
  for (const empty of ["", "   ", "\n\n", null, undefined, 42]) {
    v.comments = empty;
    assert.ok(!M.countLines(v).some(l => l.startsWith("Customer comments")), JSON.stringify(empty));
  }
  // an old tasting can carry comments too, still with no Sold line
  const old = oldVisit("S", null, { comments: "Nice" });
  assert.deepEqual(M.countLines(old), ["Total interactions: 1", "Samples given: 1", "Rejected or ignored: 0", "Customer comments: Nice"]);
});

test("reportText: title, store, brand, time, then the count lines", () => {
  const v = v6(["Lime", "Mango"], { brand: "  Vok Cocktails ", paidStart: "10:00", paidEnd: "14:00", comments: "Lime\nsold out" });
  tap(v, "S0 S1 S1 B1 N");
  assert.equal(M.reportText({ date: D }, v), [
    "Tasting report — Sat 14 Nov 2026",
    "Store: Store A",
    "Brand: Vok Cocktails",
    "Time: 10:00 am – 2:00 pm",
    "Total interactions: 4",
    "Samples given: 3",
    "  Lime: 1",
    "  Mango: 2",
    "Rejected or ignored: 1",
    "Sold: 1",
    "  Lime: 0",
    "  Mango: 1",
    "Customer comments: Lime sold out"
  ].join("\n"));
  survives(v);
});

test("reportText: an old tasting — no Brand line, no Sold line; an empty brand prints no Brand line", () => {
  const old = oldVisit("SSN");
  assert.equal(M.reportText({ date: D }, old), [
    "Tasting report — Sat 14 Nov 2026",
    "Store: Store A",
    "Time: 10:00 am – 2:00 pm",
    "Total interactions: 3",
    "Samples given: 2",
    "Rejected or ignored: 1"
  ].join("\n"));
  const v = v6([], { brand: "   ", paidEnd: "" });
  const text = M.reportText({ date: D }, v);
  assert.equal(text, [
    "Tasting report — Sat 14 Nov 2026",
    "Store: Store A",
    "Time: 10:00 am",
    "Total interactions: 0",
    "Samples given: 0",
    "Rejected or ignored: 0",
    "Sold: 0"
  ].join("\n"));
  assert.ok(!/undefined|NaN/.test(text));
  const lines = M.reportText({ date: D }, tap(v6(["Lime"], { brand: "Vok" }), "S0"));
  assert.deepEqual(lines.split("\n").slice(4), M.countLines(tap(v6(["Lime"]), "S0")), "the report ends with exactly the count lines");
});

/* ── busiest hour ─────────────────────────────────────── */
/** A tasting started at h:m with taps at the given clock times. */
function clocked(h, m, taps) {
  const v = M.newVisit(PLACE, at(h, m), 15);
  for (const [kind, hh, mm] of taps) M.addTap(v, kind, at(hh, mm));
  return v;
}

test("busiestHour: the clock hour with the most samples and rejections", () => {
  const v = clocked(10, 50, [
    ["S", 10, 51], ["N", 10, 52], ["S", 10, 55], ["S", 10, 59],
    ["S", 11, 0], ["S", 11, 5], ["N", 11, 10], ["N", 11, 20], ["S", 11, 30], ["S", 11, 45], ["N", 11, 59],
    ["S", 12, 0], ["N", 12, 30]
  ]);
  assert.deepEqual(M.busiestHour(v), { hour: 11, count: 7 });
  survives(v);
  // an afternoon tasting: the hour is the clock hour, 0–23
  const pm = clocked(15, 0, [
    ["S", 15, 1], ["S", 15, 2], ["S", 15, 3],
    ["S", 16, 1], ["S", 16, 2], ["N", 16, 3], ["N", 16, 4], ["S", 16, 5], ["S", 16, 6], ["S", 16, 7], ["S", 16, 8]
  ]);
  assert.deepEqual(M.busiestHour(pm), { hour: 16, count: 8 });
});

test("busiestHour: null with fewer than 10 samples and rejections, or with all of them in one hour", () => {
  const nine = clocked(10, 0, [
    ["S", 10, 1], ["S", 10, 2], ["S", 10, 3], ["N", 10, 5],
    ["S", 11, 1], ["S", 11, 2], ["S", 11, 3], ["N", 11, 4], ["B", 11, 4], ["B", 11, 4], ["S", 11, 5]
  ]);
  assert.equal(M.busiestHour(nine), null, "nine interactions (and two sales) say nothing yet");
  M.addTap(nine, "S", at(11, 6));
  assert.deepEqual(M.busiestHour(nine), { hour: 11, count: 6 }, "the tenth one makes it speak");

  const oneHour = clocked(10, 0, Array.from({ length: 14 }, (_, i) => [i % 3 ? "S" : "N", 10, 1 + i * 4]));
  assert.equal(M.busiestHour(oneHour), null);

  assert.equal(M.busiestHour(v6()), null);
  assert.equal(M.busiestHour(M.plannedVisit(PLACE, "10:00", "14:00", T0)), null, "a tasting that never ran has no clock times");
  assert.equal(M.busiestHour(oldVisit("")), null);
});

test("busiestHour: sold taps and taken-off taps are not interactions", () => {
  const v = clocked(10, 0, [
    ["S", 10, 1], ["S", 10, 2], ["S", 10, 3], ["S", 10, 4], ["N", 10, 5], ["N", 10, 6],
    ["S", 11, 1], ["S", 11, 2], ["S", 11, 3], ["S", 11, 4],
    ["B", 11, 5], ["B", 11, 6], ["B", 11, 7], ["B", 11, 8], ["B", 11, 9]
  ]);
  assert.deepEqual(M.busiestHour(v), { hour: 10, count: 6 }, "nine sales at 11 do not make 11 the busiest hour");
  // take off two of the 10 o'clock taps: 4 + 4 = 8 interactions are too few to say anything
  M.undoKind(v, "N"); M.undoKind(v, "N");
  assert.equal(M.busiestHour(v), null);
  // only sales in the second hour: all the interactions are in one hour
  const w = clocked(10, 0, [
    ...Array.from({ length: 10 }, (_, i) => ["S", 10, 1 + i]),
    ["B", 11, 5], ["B", 11, 6]
  ]);
  assert.equal(M.busiestHour(w), null);
});

test("busiestHour: works from an old tasting's log and with flavours", () => {
  const old = oldVisit("SSSSSNSSSSSS", [60, 120, 180, 240, 300, 3660, 3720, 3780, 3840, 3900, 3960, 7260], { startedAt: at(9, 0) });
  assert.deepEqual(M.busiestHour(old), { hour: 10, count: 6 });
  const v = M.newVisit(PLACE, at(13, 30), 15);
  M.setFlavours(v, ["Lime", "Mango"]);
  for (let i = 0; i < 4; i++) M.addTap(v, "S", at(13, 31 + i), i % 2);
  for (let i = 0; i < 7; i++) M.addTap(v, "S", at(14, 1 + i), i % 2);
  assert.deepEqual(M.busiestHour(v), { hour: 14, count: 7 });
});

/* ── store.js: a tap's flavour travels with the tap ───── */
function fakeStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key(i) { return [...m.keys()][i] ?? null; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); }
  };
}
function fakeRemote() {
  const r = {
    mode: "ok", pushes: [], subs: {}, server: new Map(),
    pushDoc(kind, id, data) {
      r.pushes.push({ kind, id, data });
      if (r.mode === "hang") return new Promise(() => {});
      r.server.set(kind + ":" + id, data);
      return Promise.resolve();
    },
    subscribe(kind, onChange) { r.subs[kind] = onChange; return () => { delete r.subs[kind]; }; },
    fetchDays() { return Promise.resolve([]); },
    deliver(kind, id, data) { r.subs[kind]([{ id, data }]); }
  };
  return r;
}
const settle = () => new Promise(res => setImmediate(res));
function setup() {
  let id = 0, clock = 1000;
  const timers = new Map();
  const store = createStore({
    storage: fakeStorage(), prefix: "t:", now: () => clock, debounceMs: 1500,
    setTimeout: f => { timers.set(++id, f); return id; }, clearTimeout: i => timers.delete(i),
    setInterval: f => { timers.set(++id, f); return id; }, clearInterval: i => timers.delete(i),
    onOnline: () => () => {}
  });
  const remote = fakeRemote();
  store.attachRemote(remote);
  return { store, remote };
}
const runningWith = (taps, times, marks, extra = {}) => ({
  id: "v1", placeId: "a", placeName: "Store A", startedAt: 5, endedAt: null,
  paidStart: "10:00", paidEnd: "", breakMin: 0, flavours: ["Lime", "Mango"],
  tapT: times, tapK: taps, ...(marks == null ? {} : { tapF: marks }),
  adjS: 0, adjN: 0, adjB: 0, adjF: [0, 0], adjBF: [0, 0], note: "", ...extra
});
const newer = (store, visit, extra = {}) =>
  ({ v: 1, date: D, updatedAt: store.getDay(D).updatedAt + 500, paidAs: null, visits: [visit], legs: [], parking: [], ...extra });

test("store pull: local taps carried onto a newer remote copy bring their flavour marks, lined up with tapK", async () => {
  const { store, remote } = setup();
  store.saveDay(D, d => d.visits.push(runningWith("SSBSNB", [1, 2, 3, 4, 5, 6], "011---")));
  // local: S Lime, S Mango, B Mango, S none, N, B none
  assert.equal(store.getDay(D).visits[0].tapF, "011---");
  store.saveDay(D, d => { const v = d.visits[0]; v.tapT.push(7, 8); v.tapK += "SB"; v.tapF += "01"; });

  // another device saved later knowing the first three taps only, with the second taken off
  remote.deliver("day", D, newer(store, runningWith("SsB", [1, 2, 3], "011", { note: "edited elsewhere" })));
  const v = store.getDay(D).visits[0];
  assert.deepEqual(v.tapT, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(v.tapK, "SsBSNBSB");
  assert.equal(v.tapF, "011---01");
  assert.equal(v.note, "edited elsewhere");
  assert.deepEqual(numbers(v), { sampled: 3, declined: 1, talked: 4, sold: 3, plain: [1, 1], flav: [["Lime", 2, 0], ["Mango", 0, 2]] });
  lawful(v); survives(v);
  assert.equal(store.status().dirty, 1, "the merged day goes back up");
  store.flush();
  await settle();
  assert.equal(remote.server.get("day:" + D).visits[0].tapF, "011---01");
});

test("store pull: a short tapF on either side is padded, so a carried mark never slides onto another tap", () => {
  // local marks are shorter than the local log; the carried taps are the last three
  let { store, remote } = setup();
  store.saveDay(D, d => d.visits.push(runningWith("SSSBS", [1, 2, 3, 4, 5], "0101")));
  remote.deliver("day", D, newer(store, runningWith("SS", [1, 2], "01")));
  let v = store.getDay(D).visits[0];
  assert.equal(v.tapK, "SSSBS");
  assert.equal(aligned(v), "0101-");
  assert.equal(v.tapF.length, 5);
  lawful(v);

  // the remote marks are shorter than the remote log: its own taps keep "no flavour" for the missing end
  ({ store, remote } = setup());
  store.saveDay(D, d => d.visits.push(runningWith("SSSB", [1, 2, 3, 4], "0011")));
  remote.deliver("day", D, newer(store, runningWith("SS", [1, 2], "0")));
  v = store.getDay(D).visits[0];
  assert.equal(v.tapK, "SSSB");
  assert.equal(v.tapF.length, 4, "one mark per tap");
  assert.equal(v.tapF.slice(2), "11", "the carried taps keep their own marks");
  assert.equal(v.tapF[0], "0");
  lawful(v);

  // the remote copy has no tapF at all (saved by the old version); the carried taps still keep theirs
  ({ store, remote } = setup());
  store.saveDay(D, d => d.visits.push(runningWith("SSSB", [1, 2, 3, 4], "0011")));
  remote.deliver("day", D, newer(store, runningWith("SS", [1, 2], null)));
  v = store.getDay(D).visits[0];
  assert.equal(v.tapK, "SSSB");
  assert.equal(v.tapF.length, 4);
  assert.equal(v.tapF.slice(2), "11");
  lawful(v);
});

test("store pull: the newer copy's marks stand for the taps it knows; old tastings with no marks stay without wrong ones", () => {
  // remote has more marks than taps (a stray end): they must not shift the carried marks
  let { store, remote } = setup();
  store.saveDay(D, d => d.visits.push(runningWith("SSB", [1, 2, 3], "001")));
  remote.deliver("day", D, newer(store, runningWith("S", [1], "0111")));
  let v = store.getDay(D).visits[0];
  assert.equal(v.tapK, "SSB");
  assert.equal(v.tapF, "001");
  lawful(v);

  // neither side has marks (an old tasting): the taps are carried and all read as no flavour
  ({ store, remote } = setup());
  const old = (taps, times) => ({
    id: "v1", placeId: "a", placeName: "Store A", startedAt: 5, endedAt: null,
    paidStart: "10:00", paidEnd: "", breakMin: 0, tapT: times, tapK: taps, adjS: 0, adjN: 0, note: ""
  });
  store.saveDay(D, d => d.visits.push(old("SNSS", [1, 2, 3, 4])));
  remote.deliver("day", D, newer(store, old("Sn", [1, 2])));
  v = store.getDay(D).visits[0];
  assert.equal(v.tapK, "SnSS");
  assert.equal(aligned(v), "----");
  assert.equal(M.tracksSold(v), false, "carrying taps does not make an old tasting track sold");
  assert.deepEqual(numbers(v), { sampled: 3, declined: 0, talked: 3, sold: 0, plain: [3, 0], flav: [] });
  lawful(v);
});

test("store pull: counting started here on a tasting the newer copy still has planned keeps its marks too", async () => {
  const { store, remote } = setup();
  const planned = () => ({
    id: "v1", placeId: "a", placeName: "Store A", startedAt: null, endedAt: null,
    paidStart: "10:00", paidEnd: "14:00", startManual: true, endManual: true, breakMin: 0,
    flavours: ["Lime", "Mango"], tapT: [], tapK: "", tapF: "",
    adjS: 0, adjN: 0, adjB: 0, adjF: [0, 0], adjBF: [0, 0], note: ""
  });
  store.saveDay(D, d => d.visits.push(planned()));
  store.flush();
  await settle();
  assert.equal(store.status().dirty, 0);
  remote.mode = "hang";
  store.saveDay(D, d => { const v = d.visits[0]; v.startedAt = 5000; v.tapT = [3, 7, 9]; v.tapK = "SBN"; v.tapF = "11-"; });

  remote.deliver("day", D, newer(store, { ...planned(), note: "Vok" }));
  const v = store.getDay(D).visits[0];
  assert.deepEqual([v.startedAt, v.tapT, v.tapK, v.tapF, v.note], [5000, [3, 7, 9], "SBN", "11-", "Vok"]);
  assert.deepEqual(numbers(v), { sampled: 1, declined: 1, talked: 2, sold: 1, plain: [0, 0], flav: [["Lime", 0, 0], ["Mango", 1, 1]] });
  lawful(v); survives(v);
});

/* ── everything together ──────────────────────────────── */
test("a whole tasting, built with every operation, survives a JSON round trip at each step and reads the same afterwards", () => {
  const c = M.withConfigDefaults({});
  const v = M.plannedVisit(PLACE, "10:00", "14:00", T0);
  survives(v);
  v.brand = "Vok Cocktails";
  M.setFlavours(v, ["Lime", "Mango"]);
  M.rememberBrand(c, v.brand, M.flavoursOf(v), T0);
  M.startVisit(v, T0);
  tap(v, "S0 S1 S1 B1 N S0 B0");
  survives(v);
  M.addFlavour(v, "Berry");
  tap(v, "S2 S2 B2 N");
  const u = M.undoKind(v, "S", 2);
  survives(v);
  M.redoAt(v, u.index);
  M.removeTapAt(v, 0);
  M.setCount(v, "S", 1, 10);
  M.bumpCount(v, "B", 0, 2);
  M.bumpCount(v, "N", -1, -1);
  M.renameFlavour(v, 2, "Mixed Berry");
  v.comments = "Wanted a bigger bottle";
  M.finishVisit(v, at(14, 0), 15);
  survives(v); survives(c);
  const copy = json(v);
  assert.deepEqual(numbers(copy), numbers(v));
  assert.deepEqual(numbers(v), {
    sampled: 13, declined: 1, talked: 14, sold: 5, plain: [0, 0],
    flav: [["Lime", 1, 3], ["Mango", 10, 1], ["Mixed Berry", 2, 1]]
  });
  assert.equal(M.reportText({ date: D }, copy), M.reportText({ date: D }, v));
  assert.deepEqual(M.brandFlavours(json(c), "vok cocktails"), ["Lime", "Mango"]);
  lawful(copy);
});

/* A small seeded generator (mulberry32): the same sequence on every run, no Math.random. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("property: random addTap / undoKind / redoAt / setCount / bumpCount / removeTapAt on three flavours keep every law", () => {
  for (const seed of [1, 2, 3, 7, 42, 2026, 20261114, 99991]) {
    const rand = rng(seed);
    const int = n => Math.floor(rand() * n);
    const pick = list => list[int(list.length)];
    const v = v6(["Lime", "Mango", "Berry"]);
    let clock = T0;
    for (let step = 0; step < 400; step++) {
      const label = `(seed ${seed}, step ${step})`;
      const op = int(100);
      const kind = pick(["S", "S", "S", "N", "B"]);
      const flavour = pick([-1, 0, 1, 2]);
      const before = M.counts(v);
      const logLen = v.tapK.length;
      if (op < 45) {
        clock += int(90) * 1000;
        const f = pick([null, undefined, -1, 0, 1, 2, 3, 9]);      // 3 and 9 are not in the list
        M.addTap(v, kind, clock, f);
        assert.equal(v.tapK.length, logLen + 1, label);
        const mark = v.tapF[v.tapF.length - 1];
        const real = kind !== "N" && [0, 1, 2].includes(f);
        assert.equal(mark, real ? String(f) : "-", `the mark of the new tap ${label}`);
      } else if (op < 60) {
        const r = M.undoKind(v, kind, flavour);
        if (r) {
          assert.equal(v.tapK[r.index], kind.toLowerCase(), label);
          assert.equal(r.kind, kind, label);
          assert.equal(r.flavour, kind === "N" ? -1 : flavour, label);
          assert.equal(r.t, v.tapT[r.index], label);
          // it was the newest of its count: nothing after it is a counted tap of the same count
          for (let i = r.index + 1; i < v.tapK.length; i++) {
            const same = v.tapK[i] === kind && (kind === "N" || (aligned(v)[i] === (flavour < 0 ? "-" : String(flavour))));
            assert.ok(!same, `a newer tap of that count was left on ${label}`);
          }
        } else {
          assert.equal(v.tapK.length, logLen, label);
          const taps = kind === "N" ? before.tapN : (flavour < 0 ? before.plain : before.flav[flavour])[kind === "S" ? "tapS" : "tapB"];
          assert.equal(taps, 0, `null only when there is no such tap ${label}`);
        }
        assert.equal(v.tapK.length, logLen, label);
      } else if (op < 70) {
        const i = int(v.tapK.length + 2) - 1;
        const was = v.tapK[i];
        const r = M.redoAt(v, i);
        if (was === "s" || was === "n" || was === "b") {
          assert.ok(r, label);
          assert.equal(v.tapK[i], was.toUpperCase(), label);
          assert.equal(r.index, i, label);
        } else {
          assert.equal(r, null, label);
        }
        assert.equal(v.tapK.length, logLen, label);
      } else if (op < 82) {
        const value = int(13);
        const k = v.tapK, f = v.tapF, t = v.tapT.slice();
        M.setCount(v, kind, flavour, value);
        assert.equal(M.countOf(v, kind, flavour), value, `the count shows what was typed ${label}`);
        assert.deepEqual([v.tapK, v.tapF, v.tapT], [k, f, t], `the log is not rewritten ${label}`);
      } else if (op < 90) {
        const delta = int(7) - 3;
        const was = M.countOf(v, kind, flavour);
        M.bumpCount(v, kind, flavour, delta);
        assert.equal(M.countOf(v, kind, flavour), Math.max(0, was + delta), label);
      } else {
        const i = int(v.tapK.length + 2) - 1;
        const ok = M.removeTapAt(v, i);
        assert.equal(ok, i >= 0 && i < logLen, label);
        assert.equal(v.tapK.length, logLen - (ok ? 1 : 0), label);
      }
      // the laws
      assert.equal(v.tapT.length, v.tapK.length, `tapT / tapK ${label}`);
      assert.equal(v.tapF.length, v.tapK.length, `tapF / tapK ${label}`);
      assert.ok(/^[SNBsnb]*$/.test(v.tapK), label);
      assert.ok(/^[0-2-]*$/.test(v.tapF), label);
      for (let i = 0; i < v.tapK.length; i++) {
        if (v.tapK[i].toUpperCase() === "N") assert.equal(v.tapF[i], "-", `a rejection never has a flavour ${label}`);
        if (i) assert.ok(v.tapT[i] >= v.tapT[i - 1], `times never go backwards ${label}`);
      }
      lawful(v, label);
      assert.deepEqual([v.adjF.length, v.adjBF.length], [3, 3], label);
      // an operation on one count never changes another one (rejected is the same count for every flavour)
      if ((op >= 45 && op < 60) || (op >= 70 && op < 90)) {
        const after = M.counts(v);
        const others = (n, skipKind, skipF) => {
          const out = {};
          if (skipKind !== "N") out.N = n.declined;
          [-1, 0, 1, 2].forEach(f => {
            const slot = f < 0 ? n.plain : n.flav[f];
            if (!(skipKind === "S" && skipF === f)) out["S" + f] = slot.sampled;
            if (!(skipKind === "B" && skipF === f)) out["B" + f] = slot.sold;
          });
          return out;
        };
        const f = kind === "N" ? -1 : flavour;
        assert.deepEqual(others(after, kind, f), others(before, kind, f), `only the one count moved ${label}`);
      }
      if (step % 50 === 49) survives(v);
    }
    // at the end: every flavour that is empty can be removed, and the rest still adds up
    const before = numbers(v);
    for (let i = 2; i >= 0; i--) {
      const empty = M.flavourIsEmpty(v, i);
      assert.equal(M.removeFlavour(v, i), empty, `seed ${seed}, removing place ${i}`);
    }
    const after = numbers(v);
    assert.deepEqual([after.sampled, after.declined, after.talked, after.sold, after.plain],
      [before.sampled, before.declined, before.talked, before.sold, before.plain], `seed ${seed}: removing empty flavours changes no total`);
    assert.deepEqual(after.flav, before.flav.filter(f => f[1] || f[2]), `seed ${seed}`);
    lawful(v, `(seed ${seed}, end)`);
    survives(v);
  }
});

test("property: random flavour lists — add, rename and remove keep the counts of the flavours that stay", () => {
  const names = ["Lime", "Mango", "Berry", "Peach", "Cola", "Mint", "Apple", "Guava"];
  for (const seed of [5, 11, 314, 2718]) {
    const rand = rng(seed);
    const int = n => Math.floor(rand() * n);
    const v = v6();
    let clock = T0;
    for (let step = 0; step < 300; step++) {
      const label = `(seed ${seed}, step ${step})`;
      const count = M.flavoursOf(v).length;
      const byName = () => Object.fromEntries(M.counts(v).flav.map(f => [f.name.toLowerCase(), [f.sampled, f.sold]]));
      const before = numbers(v), beforeByName = byName();
      const op = int(100);
      if (op < 50) {
        clock += 1000 * int(60);
        M.addTap(v, ["S", "S", "B", "N"][int(4)], clock, int(count + 2) - 1);
      } else if (op < 62) {
        const name = names[int(names.length)];
        const had = M.flavoursOf(v).some(x => x.toLowerCase() === name.toLowerCase());
        const i = M.addFlavour(v, name);
        assert.equal(i, had || count >= M.MAX_FLAVOURS ? -1 : count, label);
        assert.deepEqual({ ...numbers(v), flav: numbers(v).flav.slice(0, count) }, before, `adding changes no number ${label}`);
      } else if (op < 72 && count) {
        const i = int(count);
        M.undoKind(v, "S", i); M.undoKind(v, "B", i);
      } else if (op < 80 && count) {
        const i = int(count);
        M.setCount(v, ["S", "B"][int(2)], i, int(4));
      } else if (op < 86 && count) {
        const i = int(count);
        const name = (rand() < 0.5 ? names[int(names.length)] : M.flavoursOf(v)[i]).toUpperCase();
        const taken = M.flavoursOf(v).some((x, j) => j !== i && x.toLowerCase() === name.toLowerCase());
        assert.equal(M.renameFlavour(v, i, name), !taken, label);
        assert.deepEqual(numbers(v).flav.map(f => f.slice(1)), before.flav.map(f => f.slice(1)), label);
      } else if (count) {
        const i = int(count);
        const gone = M.flavoursOf(v)[i].toLowerCase();
        const empty = M.flavourIsEmpty(v, i);
        assert.equal(M.removeFlavour(v, i), empty, label);
        if (empty) {
          const now = numbers(v), nowByName = byName();
          assert.equal(M.flavoursOf(v).length, count - 1, label);
          delete beforeByName[gone];
          assert.deepEqual(nowByName, beforeByName, `every other flavour keeps its numbers ${label}`);
          assert.deepEqual([now.sampled, now.declined, now.talked, now.sold, now.plain],
            [before.sampled, before.declined, before.talked, before.sold, before.plain], `the totals and the plain part are unchanged ${label}`);
        } else {
          assert.deepEqual(numbers(v), before, label);
        }
      }
      lawful(v, label);
      const n = M.flavoursOf(v).length;
      assert.ok(n <= M.MAX_FLAVOURS, label);
      assert.deepEqual([v.adjF.length, v.adjBF.length], [n, n], `one correction per flavour ${label}`);
      assert.equal(new Set(M.flavoursOf(v).map(x => x.toLowerCase())).size, n, `no repeated name ${label}`);
      assert.ok([...v.tapF].every(ch => ch === "-" || Number(ch) < n), `no mark points past the list ${label}`);
      if (step % 60 === 59) survives(v);
    }
  }
});
