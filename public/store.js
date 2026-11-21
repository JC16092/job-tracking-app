/* ══════════════════════════════════════════════════════════
   Tastings — the local database and its sync.

   The phone's localStorage is the working database: every change
   is written there at once, synchronously. Firestore is the synced
   copy, reached through an injected "remote" adapter (see
   remote-firebase.js). Nothing here may ever block counting.

   Storage, clock, timers and the online signal are injectable so
   the sync rules can be tested in Node with no waiting.
   ══════════════════════════════════════════════════════════ */

const clone = x => JSON.parse(JSON.stringify(x));

export function createStore(opts = {}) {
  const storage = opts.storage !== undefined ? opts.storage : (typeof localStorage !== "undefined" ? localStorage : null);
  const prefix = opts.prefix || "tastings:";
  const now = opts.now || Date.now;
  const debounceMs = opts.debounceMs == null ? 1500 : opts.debounceMs;
  const fillConfig = opts.fillConfig || (c => ({ v: 1, updatedAt: 0, ...(c || {}) }));
  const newDay = opts.newDay || (date => ({ v: 1, date, updatedAt: 0, paidAs: null, visits: [], legs: [], parking: [] }));
  const setT = opts.setTimeout || ((f, ms) => setTimeout(f, ms));
  const clearT = opts.clearTimeout || (id => clearTimeout(id));
  const setI = opts.setInterval || ((f, ms) => setInterval(f, ms));
  const clearI = opts.clearInterval || (id => clearInterval(id));
  const onOnline = opts.onOnline || (fn => {
    if (typeof window === "undefined" || !window.addEventListener) return () => {};
    window.addEventListener("online", fn);
    return () => window.removeEventListener("online", fn);
  });

  let config = null;             // the stored config, or null while it has never been edited
  let cfgCache = null;
  const days = new Map();        // date → day
  const dirty = new Set();       // "config" | "day:YYYY-MM-DD" still to be pushed
  const unsaved = new Set();     // keys whose last write to storage failed
  const inflight = new Map();    // key → updatedAt being pushed
  const listeners = new Set();

  let remote = null, unsubs = [], pushTimer = null, tickTimer = null, offOnline = null;
  let remoteState = "none", lastSync = null, skipped = 0, lastStamp = 0;
  // Has the account's own copy arrived since the remote was attached? (config, days)
  let seen = { config: false, day: false };

  /* ── storage ────────────────────────────────────────── */
  function read(key) {
    try {
      const raw = storage && storage.getItem(prefix + key);
      if (raw == null) return null;
      return JSON.parse(raw);
    } catch (e) {
      skipped++;
      return null;
    }
  }
  function write(key, value) {
    try {
      if (!storage) throw new Error("no storage");
      storage.setItem(prefix + key, JSON.stringify(value));
      unsaved.delete(key);
      return true;
    } catch (e) {
      unsaved.add(key);
      return false;
    }
  }
  function docOf(key) { return key === "config" ? config : days.get(key.slice(4)); }
  function retryUnsaved() {
    for (const key of [...unsaved]) {
      if (key === "dirty") write("dirty", [...dirty]);
      else { const d = docOf(key); if (d) write(key, d); else unsaved.delete(key); }
    }
  }
  function persistDirty() { write("dirty", [...dirty]); }

  function load() {
    const c = read("config");
    if (c && typeof c === "object") config = c;
    try {
      const n = storage ? storage.length : 0;
      const keys = [];
      for (let i = 0; i < n; i++) keys.push(storage.key(i));
      const head = prefix + "day:";
      for (const k of keys) {
        if (typeof k !== "string" || !k.startsWith(head)) continue;
        const date = k.slice(head.length);
        const d = read("day:" + date);
        if (d && typeof d === "object" && Array.isArray(d.visits)) days.set(date, d);
        else if (d) skipped++;
      }
    } catch (e) { skipped++; }
    const list = read("dirty");
    if (Array.isArray(list)) for (const k of list) if (typeof k === "string") dirty.add(k);
    for (const d of days.values()) if ((d.updatedAt || 0) > lastStamp) lastStamp = d.updatedAt;
    if (config && (config.updatedAt || 0) > lastStamp) lastStamp = config.updatedAt;
  }

  /* A stamp that always moves forward, even if the clock does not. */
  function stamp() {
    const t = now();
    lastStamp = t > lastStamp ? t : lastStamp + 1;
    return lastStamp;
  }

  function notify() {
    for (const fn of [...listeners]) {
      try { fn(); } catch (e) { if (typeof console !== "undefined") console.error(e); }
    }
  }

  /* ── reading ────────────────────────────────────────── */
  function getConfig() {
    if (!cfgCache) cfgCache = fillConfig(config ? clone(config) : null);
    return cfgCache;
  }
  function getDay(date) { return days.get(date) || null; }
  function listDays() { return [...days.values()]; }

  function runningVisit() {
    const dates = [...days.keys()].sort().reverse();
    for (const date of dates) {
      const v = (days.get(date).visits || []).find(x => x && x.startedAt != null && x.endedAt == null);
      if (v) return { date, visit: v };
    }
    return null;
  }

  /* ── saving ─────────────────────────────────────────── */
  function commit(key, doc) {
    if (key === "config") { config = doc; cfgCache = null; }
    else days.set(key.slice(4), doc);
    write(key, doc);
  }
  function markDirty(key) {
    if (!dirty.has(key)) { dirty.add(key); }
    persistDirty();
  }

  function saveConfig(mutator) {
    const draft = clone(getConfig());
    mutator(draft);
    draft.updatedAt = stamp();
    commit("config", draft);
    markDirty("config");
    retryUnsaved();
    notify();
    schedulePush();
    return draft;
  }

  function saveDay(date, mutator) {
    const draft = clone(days.get(date) || newDay(date));
    mutator(draft);
    draft.date = date;
    draft.updatedAt = stamp();
    commit("day:" + date, draft);
    markDirty("day:" + date);
    retryUnsaved();
    notify();
    schedulePush();
    return draft;
  }

  /* ── pushing ────────────────────────────────────────── */
  function schedulePush() {
    if (!remote) return;
    if (pushTimer != null) clearT(pushTimer);
    pushTimer = setT(() => { pushTimer = null; pushAll(); }, debounceMs);
  }
  function flush() {
    if (pushTimer != null) { clearT(pushTimer); pushTimer = null; }
    pushAll();
  }
  function pushAll() {
    if (!remote) return;
    for (const key of [...dirty]) pushKey(key);
  }
  function pushKey(key) {
    if (!remote || inflight.has(key)) return;        // at most one push in flight per document
    const doc = docOf(key);
    if (!doc) { dirty.delete(key); persistDirty(); return; }
    const pushedAt = doc.updatedAt;
    const owner = remote;
    inflight.set(key, pushedAt);
    let settled = false;
    const watchdog = setT(() => {
      if (!settled && remote === owner) { remoteState = "offline"; notify(); }
    }, 30000);
    const done = ok => {
      settled = true;
      clearT(watchdog);
      inflight.delete(key);
      if (remote !== owner) return;
      if (ok) {
        const cur = docOf(key);
        // Clear the mark only if nothing changed while the push was in flight.
        if (cur && cur.updatedAt === pushedAt) { dirty.delete(key); persistDirty(); }
        remoteState = "online";
        lastSync = now();
        if (dirty.has(key)) schedulePush();
      } else {
        remoteState = "offline";
      }
      notify();
    };
    let p;
    try {
      p = owner.pushDoc(key === "config" ? "config" : "day", key === "config" ? "main" : key.slice(4), clone(doc));
    } catch (e) { done(false); return; }
    Promise.resolve(p).then(() => done(true), () => done(false));
  }

  /* ── pulling ────────────────────────────────────────── */

  /* Counts are never lost to a pull. When a newer remote day replaces the local one, each
     tasting is compared with its local copy:
     - Same run on both sides (same startedAt): if the local tap log is longer and starts with
       the remote one, the local taps are kept.
     - Counting was started HERE and has not been synced yet (the local day is dirty), while the
       remote copy still has the tasting planned or does not have it at all: the local run is
       kept whole — its start, its taps.
     - Anything else (it was stopped, restarted or removed on another device and this copy has
       nothing unsynced): the newer remote copy stands as it is. Taps are never carried across
       two different runs, and a tasting stopped elsewhere is not brought back to life. */
  const isRun = v => !!v && v.startedAt != null && v.endedAt == null;
  const isPlan = v => !!v && v.startedAt == null && v.endedAt == null;
  /* A tap's flavour marks, made exactly n long ("-" = no flavour) so they line up with tapK. */
  const marks = (f, n) => {
    const s = typeof f === "string" ? f : "";
    return s.length >= n ? s.slice(0, n) : s + "-".repeat(n - s.length);
  };

  function mergeDay(local, incoming, localDirty) {
    let changed = false;
    const out = clone(incoming);
    if (!Array.isArray(out.visits)) out.visits = [];
    for (const lv of local.visits || []) {
      const rv = out.visits.find(x => x && x.id === lv.id);
      if (!rv) {
        if (isRun(lv) && localDirty) { out.visits.push(clone(lv)); changed = true; }
        continue;
      }
      const lt = Array.isArray(lv.tapT) ? lv.tapT : [], rt = Array.isArray(rv.tapT) ? rv.tapT : [];
      if (rv.startedAt === lv.startedAt) {
        if (lt.length > rt.length && rt.every((t, i) => t === lt[i])) {
          const rk = rv.tapK || "", lk = lv.tapK || "";
          const lf = Array.isArray(lv.flavours) ? lv.flavours : [], rf = Array.isArray(rv.flavours) ? rv.flavours : [];
          // the two lists line up when the local one is the remote one plus more at the end
          const flavMatch = lf.length >= rf.length && rf.every((name, i) => name === lf[i]);
          rv.tapT = lt.slice();
          rv.tapK = rk + lk.slice(rk.length);
          // the flavour of each tap (tapF, one mark per tap) travels with the tap — but only when
          // the lists line up; otherwise a carried mark could point at the wrong flavour, so the
          // carried taps are left with no flavour instead
          if (typeof rv.tapF === "string" || typeof lv.tapF === "string") {
            const carried = flavMatch ? marks(lv.tapF, lk.length).slice(rk.length) : "-".repeat(Math.max(0, lk.length - rk.length));
            rv.tapF = marks(rv.tapF, rk.length) + carried;
          }
          // a flavour added here since comes along, so the carried marks have it to point at
          if (flavMatch && lf.length > rf.length) {
            rv.flavours = lf.slice();
            for (const key of ["adjF", "adjBF"]) {
              const list = Array.isArray(rv[key]) ? rv[key].slice(0, lf.length) : [];
              while (list.length < lf.length) list.push(0);
              rv[key] = list;
            }
          }
          changed = true;
        }
      } else if (isPlan(rv) && isRun(lv) && localDirty) {
        rv.startedAt = lv.startedAt;
        rv.endedAt = null;
        rv.tapT = lt.slice();
        rv.tapK = lv.tapK || "";
        if (typeof lv.tapF === "string") rv.tapF = marks(lv.tapF, rv.tapK.length);
        // the whole run is the local one, so its flavour list and corrections come with it, or
        // the carried marks would point at flavours the still-planned copy does not have
        if (Array.isArray(lv.flavours)) rv.flavours = lv.flavours.slice();
        for (const key of ["adjF", "adjBF"]) if (Array.isArray(lv[key])) rv[key] = lv[key].slice();
        changed = true;
      }
    }
    return { doc: out, changed };
  }

  /* `meta.fromCache` = the SDK answered from its own memory because the server could not be
     reached. Such an answer is still applied, but it does not count as hearing from the account. */
  function onRemote(kind) {
    return (changes, meta) => {
      if (!(meta && meta.fromCache)) {
        remoteState = "online";
        lastSync = now();
        seen[kind] = true;
      }
      let touched = false;
      for (const ch of changes || []) {
        if (!ch || !ch.data || typeof ch.data !== "object") continue;
        const key = kind === "config" ? "config" : "day:" + ch.id;
        const local = docOf(key);
        const rAt = ch.data.updatedAt || 0, lAt = local ? local.updatedAt || 0 : -1;
        if (!local || rAt > lAt) {
          let doc = clone(ch.data), keepDirty = false;
          if (kind === "day") {
            if (local) {
              const m = mergeDay(local, doc, dirty.has(key));
              if (m.changed) { doc = m.doc; doc.updatedAt = stamp(); keepDirty = true; }
            }
            doc.date = ch.id;
            if (!Array.isArray(doc.visits)) doc.visits = [];
          }
          commit(key, doc);
          if (keepDirty) markDirty(key);
          else if (dirty.has(key)) { dirty.delete(key); persistDirty(); }
          if ((doc.updatedAt || 0) > lastStamp) lastStamp = doc.updatedAt;
          touched = true;
        } else if (rAt < lAt) {
          markDirty(key);                              // the server is behind: push ours again
        }
      }
      notify();
      if (dirty.size) schedulePush();
      return touched;
    };
  }

  function attachRemote(r) {
    if (remote === r) return;
    if (remote) detachRemote();
    remote = r;
    remoteState = "connecting";
    seen = { config: false, day: false };
    unsubs = [];
    for (const kind of ["config", "day"]) {
      try {
        const off = r.subscribe(kind, onRemote(kind));
        if (typeof off === "function") unsubs.push(off);
      } catch (e) { if (typeof console !== "undefined") console.error(e); }
    }
    offOnline = onOnline(() => pushAll());
    tickTimer = setI(() => { if (dirty.size) pushAll(); }, 60000);
    notify();
    pushAll();
  }

  function detachRemote() {
    for (const off of unsubs) { try { off(); } catch (e) { /* already gone */ } }
    unsubs = [];
    if (offOnline) { try { offOnline(); } catch (e) { /* ignore */ } offOnline = null; }
    if (tickTimer != null) { clearI(tickTimer); tickTimer = null; }
    if (pushTimer != null) { clearT(pushTimer); pushTimer = null; }
    inflight.clear();
    remote = null;
    remoteState = "none";
    seen = { config: false, day: false };
    notify();
  }

  /* Kept for callers that page back through old pay periods. Every day is pulled by the
     live listener in v1, so there is nothing more to fetch. */
  function ensureRange() { return Promise.resolve(); }

  function status() {
    return {
      remote: remoteState,
      dirty: dirty.size,
      lastSync,
      storageOk: unsaved.size === 0,
      skipped,
      // true once the account has answered for both the settings and the days: from then on a
      // day this phone does not have is a day the account does not have either
      ready: !!remote && seen.config && seen.day
    };
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  load();

  return {
    getConfig, getDay, listDays, runningVisit,
    saveConfig, saveDay,
    subscribe, attachRemote, detachRemote, ensureRange, flush, status
  };
}
