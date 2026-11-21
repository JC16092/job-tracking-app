// Run from the project folder:  node --test tests/
// The sync rules, with a fake storage, a fake remote and fake timers — no waiting, no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../public/store.js";

function fakeStorage({ failWrites = false } = {}) {
  const m = new Map();
  return {
    fail: failWrites,
    get length() { return m.size; },
    key(i) { return [...m.keys()][i] ?? null; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (this.fail) throw new Error("QuotaExceededError"); m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    raw: m
  };
}

function fakeTimers() {
  let id = 0;
  const timers = new Map();
  return {
    setTimeout(f, ms) { timers.set(++id, { f, ms, every: false }); return id; },
    clearTimeout(i) { timers.delete(i); },
    setInterval(f, ms) { timers.set(++id, { f, ms, every: true }); return id; },
    clearInterval(i) { timers.delete(i); },
    /** Run every timer whose delay is exactly `ms`. */
    fire(ms) {
      for (const [i, t] of [...timers]) {
        if (t.ms !== ms) continue;
        if (!t.every) timers.delete(i);
        t.f();
      }
    },
    count: () => timers.size
  };
}

function fakeRemote() {
  const r = {
    mode: "ok",                    // "ok" | "fail" | "hang"
    pushes: [], pending: [], subs: {}, server: new Map(),
    pushDoc(kind, id, data) {
      r.pushes.push({ kind, id, data });
      if (r.mode === "fail") return Promise.reject(new Error("offline"));
      if (r.mode === "hang") return new Promise((res, rej) => r.pending.push({ res, rej, kind, id, data }));
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

function setup(extra = {}) {
  const storage = extra.storage || fakeStorage();
  const timers = fakeTimers();
  let clock = 1000;
  let online = null;
  const store = createStore({
    storage, prefix: "t:", now: () => clock, debounceMs: 1500,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    onOnline: fn => { online = fn; return () => { online = null; }; },
    ...extra.opts
  });
  return { store, storage, timers, tick: (n = 1) => { clock += n; }, goOnline: () => online && online(), at: () => clock };
}

const D = "2026-11-14";
const running = (taps = "", times = []) => ({
  id: "v1", placeId: "a", placeName: "Store A", startedAt: 5, endedAt: null,
  paidStart: "10:00", paidEnd: "", breakMin: 0, tapT: times, tapK: taps, adjS: 0, adjN: 0, note: ""
});

test("a save is written to storage at once and listeners are told", () => {
  const { store, storage } = setup();
  let calls = 0;
  store.subscribe(() => calls++);
  store.saveDay(D, d => d.visits.push(running("S", [3])));
  assert.equal(calls, 1);
  assert.equal(JSON.parse(storage.getItem("t:day:" + D)).visits[0].tapK, "S");
  assert.deepEqual(JSON.parse(storage.getItem("t:dirty")), ["day:" + D]);
  assert.equal(store.getDay(D).date, D);
  assert.equal(store.status().dirty, 1);
  assert.equal(store.status().storageOk, true);
});

test("the store survives a restart: days, config, dirty marks and the running tasting", () => {
  const a = setup();
  a.store.saveConfig(c => { c.homeAddress = "1 Home St"; });
  a.store.saveDay(D, d => d.visits.push(running("SN", [3, 9])));
  const b = setup({ storage: a.storage });
  assert.equal(b.store.getConfig().homeAddress, "1 Home St");
  assert.equal(b.store.runningVisit().visit.tapK, "SN");
  assert.equal(b.store.runningVisit().date, D);
  assert.equal(b.store.status().dirty, 2);
});

test("a storage failure keeps the change in memory and reports it; a later success clears it", () => {
  const storage = fakeStorage({ failWrites: true });
  const { store } = setup({ storage });
  store.saveDay(D, d => d.visits.push(running("S", [1])));
  assert.equal(store.getDay(D).visits[0].tapK, "S");
  assert.equal(store.status().storageOk, false);
  storage.fail = false;
  store.saveDay(D, d => { d.visits[0].tapK = "SS"; d.visits[0].tapT = [1, 2]; });
  assert.equal(store.status().storageOk, true);
  assert.equal(JSON.parse(storage.getItem("t:day:" + D)).visits[0].tapK, "SS");
});

test("corrupt stored values are skipped, not fatal", () => {
  const storage = fakeStorage();
  storage.setItem("t:config", "{not json");
  storage.setItem("t:day:2026-01-01", "[[[");
  storage.setItem("t:day:" + D, JSON.stringify({ v: 1, date: D, updatedAt: 5, visits: [], legs: [], parking: [] }));
  storage.setItem("other:day:2026-02-02", JSON.stringify({ visits: [] }));
  const { store } = setup({ storage });
  assert.equal(store.listDays().length, 1);
  assert.ok(store.status().skipped >= 2);
  assert.equal(typeof store.getConfig(), "object");
});

test("a change made offline is pushed after reconnect", async () => {
  const { store, timers } = setup();
  store.saveDay(D, d => d.visits.push(running("S", [1])));
  const remote = fakeRemote();
  store.attachRemote(remote);                       // attach pushes what is dirty
  await settle();
  assert.equal(remote.pushes.length, 1);
  assert.equal(remote.server.get("day:" + D).visits[0].tapK, "S");
  assert.equal(store.status().dirty, 0);
  assert.equal(store.status().remote, "online");
  assert.ok(timers.count() >= 1);
});

test("a push waits for the debounce; flush pushes at once", async () => {
  const { store, timers } = setup();
  const remote = fakeRemote();
  store.attachRemote(remote);
  store.saveDay(D, d => d.visits.push(running()));
  assert.equal(remote.pushes.length, 0);
  timers.fire(1500);
  await settle();
  assert.equal(remote.pushes.length, 1);
  store.saveDay(D, d => { d.paidAs = "holiday"; });
  store.flush();
  await settle();
  assert.equal(remote.pushes.length, 2);
  assert.equal(remote.server.get("day:" + D).paidAs, "holiday");
});

test("a failed push stays dirty and is retried on the online signal and on the 60-second tick", async () => {
  const { store, timers, goOnline } = setup();
  const remote = fakeRemote();
  remote.mode = "fail";
  store.attachRemote(remote);
  store.saveDay(D, d => d.visits.push(running()));
  store.flush();
  await settle();
  assert.equal(store.status().dirty, 1);
  assert.equal(store.status().remote, "offline");

  goOnline();                                       // still failing
  await settle();
  assert.equal(remote.pushes.length, 2);
  assert.equal(store.status().dirty, 1);

  remote.mode = "ok";
  timers.fire(60000);
  await settle();
  assert.equal(remote.pushes.length, 3);
  assert.equal(store.status().dirty, 0);
});

test("a document changed while its push is in flight is pushed again and not marked clean early", async () => {
  const { store, timers, tick } = setup();
  const remote = fakeRemote();
  remote.mode = "hang";
  store.attachRemote(remote);
  store.saveDay(D, d => d.visits.push(running("S", [1])));
  store.flush();
  assert.equal(remote.pending.length, 1);

  tick(10);
  store.saveDay(D, d => { d.visits[0].tapK = "SS"; d.visits[0].tapT = [1, 2]; });
  store.flush();
  assert.equal(remote.pushes.length, 1, "only one push in flight per document");

  remote.mode = "ok";
  remote.pending[0].res();
  await settle();
  assert.equal(store.status().dirty, 1, "still dirty: it changed during the push");
  timers.fire(1500);
  await settle();
  assert.equal(remote.pushes.length, 2);
  assert.equal(remote.server.get("day:" + D).visits[0].tapK, "SS");
  assert.equal(store.status().dirty, 0);
});

test("a push that never settles reports offline after 30 seconds and stays in flight", async () => {
  const { store, timers } = setup();
  const remote = fakeRemote();
  remote.mode = "hang";
  store.attachRemote(remote);
  store.saveDay(D, d => d.visits.push(running()));
  store.flush();
  timers.fire(30000);
  assert.equal(store.status().remote, "offline");
  store.flush();
  assert.equal(remote.pushes.length, 1);
});

test("pull: a newer remote document replaces the local one; an older one does not and is pushed over", async () => {
  const { store, tick } = setup();
  const remote = fakeRemote();
  store.attachRemote(remote);
  store.saveDay(D, d => { d.paidAs = "saturday"; });
  store.flush();
  await settle();
  const localAt = store.getDay(D).updatedAt;

  remote.deliver("day", D, { v: 1, date: D, updatedAt: localAt + 50, paidAs: "holiday", visits: [], legs: [], parking: [] });
  assert.equal(store.getDay(D).paidAs, "holiday");
  assert.equal(store.status().dirty, 0);

  tick(100);
  store.saveDay(D, d => { d.paidAs = "sunday"; });
  store.flush();
  await settle();
  const pushes = remote.pushes.length;
  remote.deliver("day", D, { v: 1, date: D, updatedAt: 1, paidAs: "weekday", visits: [], legs: [], parking: [] });
  assert.equal(store.getDay(D).paidAs, "sunday", "the older remote copy is ignored");
  assert.equal(store.status().dirty, 1, "and ours is queued to go up again");
  store.flush();
  await settle();
  assert.equal(remote.pushes.length, pushes + 1);
});

test("pull: a new phone takes everything the server has, including the config", () => {
  const { store } = setup();
  const remote = fakeRemote();
  store.attachRemote(remote);
  remote.deliver("config", "main", { v: 1, updatedAt: 77, homeAddress: "1 Home St", places: [{ id: "a", name: "Store A" }] });
  remote.deliver("day", D, { v: 1, date: D, updatedAt: 80, paidAs: null, visits: [running("SSN", [1, 2, 3])], legs: [], parking: [] });
  assert.equal(store.getConfig().homeAddress, "1 Home St");
  assert.equal(store.getDay(D).visits[0].tapK, "SSN");
  assert.equal(store.status().dirty, 0);
});

test("counts are never lost to a pull: a newer remote day with fewer taps keeps the local taps", async () => {
  const { store } = setup();
  const remote = fakeRemote();
  store.attachRemote(remote);
  store.saveDay(D, d => d.visits.push(running("SNSS", [1, 2, 3, 4])));
  const localAt = store.getDay(D).updatedAt;

  // Another device saved the same day later, knowing only the first two taps (and undid one).
  remote.deliver("day", D, {
    v: 1, date: D, updatedAt: localAt + 500, paidAs: "holiday",
    visits: [running("Sn", [1, 2])], legs: [], parking: [{ id: "k", cents: 650 }]
  });
  const d = store.getDay(D);
  assert.deepEqual(d.visits[0].tapT, [1, 2, 3, 4]);
  assert.equal(d.visits[0].tapK, "SnSS", "the newer copy's undo is kept, the local taps are added back");
  assert.equal(d.paidAs, "holiday");
  assert.equal(d.parking.length, 1);
  assert.equal(store.status().dirty, 1, "the merged day goes back up");
  store.flush();
  await settle();
  assert.equal(remote.server.get("day:" + D).visits[0].tapK, "SnSS");
});

test("counts are never lost to a pull: a tasting running here survives a newer remote day that lacks it", () => {
  const { store } = setup();
  const remote = fakeRemote();
  store.attachRemote(remote);
  store.saveDay(D, d => d.visits.push(running("S", [1])));
  remote.deliver("day", D, { v: 1, date: D, updatedAt: store.getDay(D).updatedAt + 500, paidAs: null, visits: [], legs: [], parking: [] });
  assert.equal(store.runningVisit().visit.tapK, "S");
});

/* Planned tastings (v4): a tasting exists before counting starts, so the two copies of a day can
   disagree about whether it is planned or running. */
const planned = () => ({
  id: "v1", placeId: "a", placeName: "Store A", startedAt: null, endedAt: null,
  paidStart: "10:00", paidEnd: "14:00", startManual: true, endManual: true,
  breakMin: 0, tapT: [], tapK: "", adjS: 0, adjN: 0, note: ""
});
const dayWith = (visit, updatedAt, extra = {}) => ({ v: 1, date: D, updatedAt, paidAs: null, visits: [visit], legs: [], parking: [], ...extra });

test("pull: counting started here and not yet synced survives a newer remote copy that still has it planned", async () => {
  const { store } = setup();
  const remote = fakeRemote();
  store.attachRemote(remote);
  store.saveDay(D, d => d.visits.push(planned()));
  store.flush();
  await settle();
  assert.equal(store.status().dirty, 0);

  remote.mode = "hang";                               // offline from here on
  store.saveDay(D, d => { const v = d.visits[0]; v.startedAt = 5000; v.tapT = [3, 7]; v.tapK = "SN"; });
  assert.equal(store.status().dirty, 1);

  // another device, which still has the tasting planned, edited its note and saved later
  remote.deliver("day", D, dayWith({ ...planned(), note: "Jameson" }, store.getDay(D).updatedAt + 500));
  const v = store.getDay(D).visits[0];
  assert.deepEqual([v.startedAt, v.endedAt, v.tapT, v.tapK, v.note], [5000, null, [3, 7], "SN", "Jameson"]);
  assert.equal(store.runningVisit().visit.id, "v1", "the Counter still has its running tasting");
  assert.equal(store.status().dirty, 1, "and the merged day goes back up");
});

test("pull: a run started here carries its flavours onto a newer remote copy that is still planned", async () => {
  const { store } = setup();
  const remote = fakeRemote();
  store.attachRemote(remote);
  store.saveDay(D, d => d.visits.push({ ...planned(), flavours: ["Lime", "Mango"], adjF: [0, 0], adjBF: [0, 0] }));
  store.flush();
  await settle();
  assert.equal(store.status().dirty, 0);

  remote.mode = "hang";                               // offline from here on
  // start counting here, add a third flavour, tap a sample on Peach (mark "2") and one on Lime ("0")
  store.saveDay(D, d => {
    const v = d.visits[0];
    v.startedAt = 5000; v.flavours = ["Lime", "Mango", "Peach"];
    v.adjF = [0, 0, 0]; v.adjBF = [0, 0, 0];
    v.tapT = [3, 7]; v.tapK = "SS"; v.tapF = "20";
  });
  assert.equal(store.status().dirty, 1);

  // another device still has it planned (the two original flavours) and saved a note later
  remote.deliver("day", D, dayWith({ ...planned(), flavours: ["Lime", "Mango"], adjF: [0, 0], adjBF: [0, 0], note: "Jameson" }, store.getDay(D).updatedAt + 500));
  const v = store.getDay(D).visits[0];
  assert.deepEqual(v.flavours, ["Lime", "Mango", "Peach"], "the local flavour list is kept whole");
  assert.deepEqual([v.tapT, v.tapK, v.tapF], [[3, 7], "SS", "20"], "and each tap keeps its flavour mark");
  assert.equal(v.note, "Jameson", "while the remote note still comes in");
  assert.equal(store.status().dirty, 1, "and the merged day goes back up");
});

test("pull: a tasting stopped on another device is not brought back by a copy with nothing unsynced", async () => {
  const { store } = setup();
  const remote = fakeRemote();
  store.attachRemote(remote);
  store.saveDay(D, d => d.visits.push({ ...planned(), startedAt: 5000, tapT: [3, 7], tapK: "SN" }));
  store.flush();
  await settle();
  assert.equal(store.status().dirty, 0);
  assert.ok(store.runningVisit());

  // elsewhere: "stop counting" put it back to planned, with nothing counted
  remote.deliver("day", D, dayWith(planned(), store.getDay(D).updatedAt + 500));
  const v = store.getDay(D).visits[0];
  assert.deepEqual([v.startedAt, v.tapT, v.tapK], [null, [], ""]);
  assert.equal(store.runningVisit(), null);
  assert.equal(store.status().dirty, 0);

  // and a tasting removed elsewhere stays removed
  const b = setup();
  const r2 = fakeRemote();
  b.store.attachRemote(r2);
  b.store.saveDay(D, d => d.visits.push({ ...planned(), startedAt: 5000, tapT: [3], tapK: "S" }));
  b.store.flush();
  await settle();
  r2.deliver("day", D, { v: 1, date: D, updatedAt: b.store.getDay(D).updatedAt + 500, paidAs: null, visits: [], legs: [], parking: [] });
  assert.equal(b.store.getDay(D).visits.length, 0);
});

test("pull: taps are never carried across two different runs of the same tasting", async () => {
  const { store } = setup();
  const remote = fakeRemote();
  store.attachRemote(remote);
  store.saveDay(D, d => d.visits.push({ ...planned(), startedAt: 5000, tapT: [3, 7, 9], tapK: "SNS" }));
  // restarted elsewhere at another time, with fewer taps so far
  remote.deliver("day", D, dayWith({ ...planned(), startedAt: 9000, tapT: [3], tapK: "N" }, store.getDay(D).updatedAt + 500));
  const v = store.getDay(D).visits[0];
  assert.deepEqual([v.startedAt, v.tapT, v.tapK], [9000, [3], "N"]);
});

test("detachRemote stops pushes; listeners fire on remote changes too", async () => {
  const { store } = setup();
  const remote = fakeRemote();
  let calls = 0;
  store.subscribe(() => calls++);
  store.attachRemote(remote);
  const before = calls;
  remote.deliver("day", D, { v: 1, date: D, updatedAt: 9, paidAs: null, visits: [], legs: [], parking: [] });
  assert.ok(calls > before);
  store.detachRemote();
  store.saveDay(D, d => { d.paidAs = "sunday"; });
  store.flush();
  await settle();
  assert.equal(remote.pushes.length, 0);
  assert.equal(store.status().remote, "none");
  assert.equal(store.status().dirty, 1);
});

test("stamps always move forward, even when the clock stands still", () => {
  const { store } = setup();
  store.saveDay(D, d => { d.paidAs = "sunday"; });
  const a = store.getDay(D).updatedAt;
  store.saveDay(D, d => { d.paidAs = "holiday"; });
  assert.ok(store.getDay(D).updatedAt > a);
});

/* ── v5: has the account answered yet? (restore waits for this) ── */
test("v5: ready turns true only when the account has answered for settings and days", () => {
  const { store } = setup();
  assert.equal(store.status().ready, false, "no remote attached");
  const r = fakeRemote();
  store.attachRemote(r);
  assert.equal(store.status().ready, false);
  r.subs.config([]);
  assert.equal(store.status().ready, false, "days not heard from yet");
  r.subs.day([]);
  assert.equal(store.status().ready, true);
  store.detachRemote();
  assert.equal(store.status().ready, false);
  // attaching again starts from "not heard yet"
  const r2 = fakeRemote();
  store.attachRemote(r2);
  assert.equal(store.status().ready, false);
});

test("v5: an answer from the SDK's own memory (no server) is applied but does not count as hearing from the account", () => {
  const { store } = setup();
  const r = fakeRemote();
  store.attachRemote(r);
  r.subs.config([], { fromCache: true });
  r.subs.day([{ id: D, data: { v: 1, date: D, updatedAt: 50, paidAs: null, visits: [], legs: [], parking: [{ id: "k", cents: 500, note: "" }] } }], { fromCache: true });
  const s = store.status();
  assert.equal(s.ready, false);
  assert.equal(s.lastSync, null);
  assert.notEqual(s.remote, "online");
  assert.equal(store.getDay(D).parking[0].cents, 500, "the documents are still taken in");
  // the server answers later
  r.subs.config([], { fromCache: false });
  r.subs.day([], { fromCache: false });
  assert.equal(store.status().ready, true);
  assert.equal(store.status().remote, "online");
  assert.notEqual(store.status().lastSync, null);
});
