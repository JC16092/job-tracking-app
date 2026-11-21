// Checks for public/sw.js (SPEC.md section 9). From the project folder:
//
//     node --test                      every test in the project, these included
//     node --test "tools/*.mjs"        these alone
//
// (Node 24 does not take a folder name here: "node --test tools/" fails with "Cannot find module".)
//
// The worker is run against a pretend browser (pretend cache storage, pretend network), so the
// rules can be checked without a phone: all-or-nothing install, waiting for "Update now",
// cache first, and never deleting a cache that is not its own.
//
// Nothing here touches the real network and nothing is written to disk.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const SOURCE = fs.readFileSync(path.join(PUBLIC, "sw.js"), "utf8");
const ORIGIN = "https://app.example";

// The contract, written out here on purpose so a slip in sw.js shows up as a difference.
const SHELL = [
  "/", "/index.html", "/styles.css", "/app.js", "/pay.js", "/holidays.js", "/model.js", "/report.js", "/store.js",
  "/remote-firebase.js", "/firebase-config.js", "/manifest.webmanifest", "/icon.svg", "/icon-192.png",
  "/apple-touch-icon.png"
];
const SDK = [
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js"
];
// Files in public/ that are deliberately NOT kept by the worker.
const NOT_KEPT = [
  "/sw.js",          // the browser must always ask the server for the worker itself
  "/icon-512.png"    // only read when the app is installed; fetched from the network if asked for
];

const UNTOUCHED = Symbol("left to the browser");
const tick = () => new Promise(resolve => setImmediate(resolve));
const abs = input => new URL(typeof input === "string" ? input : input.url, ORIGIN + "/").href;
const noQuery = url => url.split("?")[0];

function typeFor(p) {
  if (p === "/" || p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".webmanifest")) return "application/manifest+json";
  if (p.endsWith(".svg")) return "image/svg+xml";
  if (p.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

/* ── the pretend browser ─────────────────────────────────────────────────────── */

function makeBrowser() {
  const stores = new Map();     // cache name → Map(url → Response)
  const routes = new Map();     // url → (init) => Response, or a promise of one, or throws
  const requests = [];          // everything that went to the "network"
  const deleted = [];           // every cache name the worker deleted
  const timers = [];

  class Cache {
    constructor(map) { this.map = map; }
    async put(request, response) {
      // Like the real thing: the entry exists only once the whole body has been read.
      const body = await response.arrayBuffer();
      this.map.set(abs(request), new Response(body, { status: response.status, headers: response.headers }));
    }
    async match(request, options = {}) {
      const want = abs(request);
      for (const [url, response] of this.map) {
        if (url === want || (options.ignoreSearch && noQuery(url) === noQuery(want))) return response.clone();
      }
      return undefined;
    }
    async keys() { return [...this.map.keys()]; }
  }

  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      return new Cache(stores.get(name));
    },
    async keys() { return [...stores.keys()]; },
    async has(name) { return stores.has(name); },
    async delete(name) { deleted.push(name); return stores.delete(name); },
    // caches.match() looks through EVERY cache. The worker must only look in its own.
    async match() { throw new Error("caches.match() was called: the worker must read only its own cache"); }
  };

  async function fetch(input, init = {}) {
    const url = abs(input);
    requests.push({ url, init });
    const route = routes.get(url);
    if (!route) throw new TypeError("Failed to fetch " + url);   // what "no network" looks like
    return route(init);
  }

  function startWorker(source = SOURCE) {
    const handlers = {};
    const worker = { skipWaitingCalls: 0, claimCalls: 0 };
    const self = {
      location: new URL(ORIGIN + "/sw.js"),
      addEventListener(type, handler) { handlers[type] = handler; },
      skipWaiting() { worker.skipWaitingCalls++; return Promise.resolve(); },
      clients: { claim() { worker.claimCalls++; return Promise.resolve(); } }
    };
    const context = vm.createContext({
      self, caches, fetch, URL, Response, Headers, AbortController, console,
      setTimeout(fn, ms) { timers.push({ fn, ms, cleared: false }); return timers.length; },
      clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; }
    });
    vm.runInContext(source, context, { filename: "sw.js" });

    const lifecycle = async type => {
      const waiting = [];
      handlers[type]({ waitUntil: promise => waiting.push(promise) });
      await Promise.all(waiting);
    };
    worker.read = name => vm.runInContext(name, context);     // a top-level const of sw.js
    worker.install = () => lifecycle("install");
    worker.activate = () => lifecycle("activate");
    worker.message = data => handlers.message({ data });
    worker.fetch = async request => {
      let answer = UNTOUCHED;
      const waiting = [];
      handlers.fetch({
        request,
        respondWith(promise) { answer = Promise.resolve(promise); },
        waitUntil(promise) { waiting.push(promise); }
      });
      if (answer === UNTOUCHED) return UNTOUCHED;
      const response = await answer;
      await Promise.all(waiting);
      return response;
    };
    return worker;
  }

  // Puts the site (and, unless told not to, the SDK) on the pretend network.
  function online({ tag = "one", missing = [], sdk = true } = {}) {
    routes.clear();
    for (const p of SHELL) {
      if (missing.includes(p)) continue;
      routes.set(ORIGIN + p, () => new Response(p + " " + tag, { headers: { "content-type": typeFor(p), "vary": "accept-encoding" } }));
    }
    if (sdk) {
      for (const url of SDK) {
        routes.set(url, () => new Response("sdk " + url, { headers: { "content-type": "text/javascript; charset=UTF-8", "vary": "Accept-Encoding" } }));
      }
    }
  }
  const offline = () => routes.clear();
  const keys = async name => stores.has(name) ? [...stores.get(name).keys()].sort() : null;

  return { stores, routes, requests, deleted, timers, caches, startWorker, online, offline, keys };
}

const get = (url, extra = {}) => ({ method: "GET", url: abs(url), mode: "cors", ...extra });
const page = url => get(url, { mode: "navigate" });
const text = async response => (response === UNTOUCHED ? UNTOUCHED : response.text());

// A worker that is installed and in charge, with the site online while it installed.
async function running(browser = makeBrowser(), options) {
  browser.online(options);
  const worker = browser.startWorker();
  await worker.install();
  await worker.activate();
  browser.requests.length = 0;
  return { browser, worker, VERSION: worker.read("VERSION") };
}

/* ── the lists ───────────────────────────────────────────────────────────────── */

test("VERSION is the cache name and starts with tastings-", () => {
  const worker = makeBrowser().startWorker();
  assert.match(worker.read("VERSION"), /^tastings-v\d+$/);
  assert.equal(worker.read("PREFIX"), "tastings-");
});

test("the shell list is exactly the files the app loads", () => {
  const worker = makeBrowser().startWorker();
  assert.deepEqual([...worker.read("SHELL")].sort(), [...SHELL].sort());
  assert.deepEqual([...worker.read("SDK")], SDK);
});

/* ── install ─────────────────────────────────────────────────────────────────── */

test("install keeps every shell file and the three SDK files, and does not skip waiting", async () => {
  const browser = makeBrowser();
  browser.online();
  const worker = browser.startWorker();
  await worker.install();

  const VERSION = worker.read("VERSION");
  assert.deepEqual(await browser.keys(VERSION), [...SHELL.map(p => ORIGIN + p), ...SDK].sort());
  assert.equal(worker.skipWaitingCalls, 0, "skipWaiting() must not be called on install");
  assert.equal(worker.claimCalls, 0);

  for (const p of SHELL) {
    const sent = browser.requests.filter(r => r.url === ORIGIN + p);
    assert.equal(sent.length, 1, p + " is fetched once");
    assert.equal(sent[0].init.cache, "reload", p + " is fetched with cache: \"reload\"");
  }
  for (const url of SDK) {
    const sent = browser.requests.filter(r => r.url === url);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].init.credentials, "omit");
  }
});

test("what is kept is the real content, with its content type", async () => {
  const { browser, VERSION } = await running();
  const cache = await browser.caches.open(VERSION);
  const app = await cache.match("/app.js");
  assert.equal(app.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await app.text(), "/app.js one");
});

test("a missing shell file (404) fails the whole install and nothing is kept", async () => {
  const browser = makeBrowser();
  browser.online({ missing: ["/model.js"] });
  browser.routes.set(ORIGIN + "/model.js", () => new Response("Not found", { status: 404, headers: { "content-type": "text/html" } }));
  const worker = browser.startWorker();
  await assert.rejects(worker.install(), /\/model\.js answered 404/);
  assert.deepEqual([...browser.stores.keys()], [], "no cache was even created");
});

test("a missing shell file that comes back as the index page with 200 OK fails the install too", async () => {
  // Firebase Hosting does this: firebase.json rewrites every unknown address to /index.html.
  const browser = makeBrowser();
  browser.online();
  browser.routes.set(ORIGIN + "/store.js", () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
  const worker = browser.startWorker();
  await assert.rejects(worker.install(), /\/store\.js is missing/);
  assert.deepEqual([...browser.stores.keys()], []);
});

test("a dropped connection during install fails the whole install and nothing is kept", async () => {
  const browser = makeBrowser();
  browser.online({ missing: ["/icon-192.png"] });      // no route = the request fails
  const worker = browser.startWorker();
  await assert.rejects(worker.install(), /Failed to fetch/);
  assert.deepEqual([...browser.stores.keys()], []);
});

test("a file that stops arriving half way fails the whole install and nothing is kept", async () => {
  const browser = makeBrowser();
  browser.online();
  browser.routes.set(ORIGIN + "/styles.css", () => {
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("body{")); },
      pull(controller) { controller.error(new TypeError("connection lost")); }
    });
    return new Response(body, { headers: { "content-type": "text/css" } });
  });
  const worker = browser.startWorker();
  await assert.rejects(worker.install(), /connection lost/);
  assert.deepEqual([...browser.stores.keys()], []);
});

test("a redirected answer is kept as a clean copy (a browser refuses a redirected one for a page load)", async () => {
  const browser = makeBrowser();
  browser.online();
  browser.routes.set(ORIGIN + "/index.html", () => {
    const response = new Response("/index.html one", { headers: { "content-type": "text/html", "content-encoding": "gzip", "content-length": "5" } });
    Object.defineProperty(response, "redirected", { value: true });
    return response;
  });
  const worker = browser.startWorker();
  await worker.install();
  const kept = await (await browser.caches.open(worker.read("VERSION"))).match("/index.html");
  assert.equal(kept.redirected, false);
  assert.equal(kept.headers.get("content-encoding"), null);
  assert.equal(kept.headers.get("content-length"), null);
  assert.equal(await kept.text(), "/index.html one");
});

test("the SDK is best effort: unreachable, the install still succeeds with the shell alone", async () => {
  const browser = makeBrowser();
  browser.online({ sdk: false });
  const worker = browser.startWorker();
  await worker.install();
  assert.deepEqual(await browser.keys(worker.read("VERSION")), SHELL.map(p => ORIGIN + p).sort());
});

test("the SDK is best effort: an error answer is not kept", async () => {
  const browser = makeBrowser();
  browser.online();
  browser.routes.set(SDK[1], () => new Response("nope", { status: 503 }));
  const worker = browser.startWorker();
  await worker.install();
  const kept = await browser.keys(worker.read("VERSION"));
  assert.equal(kept.includes(SDK[0]), true);
  assert.equal(kept.includes(SDK[1]), false);
  assert.equal(kept.includes(SDK[2]), true);
});

test("an SDK download that hangs is given up after 20 seconds and the install goes on", async () => {
  const browser = makeBrowser();
  browser.online();
  browser.routes.set(SDK[2], init => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  }));
  const worker = browser.startWorker();
  let settled = false;
  const installing = worker.install().then(() => { settled = true; });
  while (!browser.requests.some(r => r.url === SDK[2])) await tick();
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(settled, false, "still waiting for the hung download");

  const live = browser.timers.filter(t => !t.cleared);
  assert.equal(live.length, 1);
  assert.equal(live[0].ms, 20000);
  live[0].fn();                                   // 20 seconds pass
  await installing;
  const kept = await browser.keys(worker.read("VERSION"));
  assert.equal(kept.length, SHELL.length + 2);
  assert.equal(kept.includes(SDK[2]), false);
});

/* ── activate ────────────────────────────────────────────────────────────────── */

test("activate deletes only older tastings- caches, then claims the open pages", async () => {
  const browser = makeBrowser();
  browser.online();
  const worker = browser.startWorker();
  const VERSION = worker.read("VERSION");
  for (const name of ["tastings-v0", "tastings-old", "hours-v5", "pace-v12", "other", "Tastings-v0", "xtastings-v0"]) {
    await (await browser.caches.open(name)).put("/x", new Response("x"));
  }
  await worker.install();
  await worker.activate();

  assert.deepEqual([...browser.deleted].sort(), ["tastings-old", "tastings-v0"]);
  assert.deepEqual([...browser.stores.keys()].sort(), ["Tastings-v0", "hours-v5", "other", "pace-v12", VERSION, "xtastings-v0"].sort());
  assert.equal(worker.claimCalls, 1);
  assert.equal(worker.skipWaitingCalls, 0);
});

test("activate still claims the pages when the clean-up fails", async () => {
  const browser = makeBrowser();
  browser.online();
  const worker = browser.startWorker();
  await worker.install();
  browser.caches.keys = async () => { throw new Error("storage is unhappy"); };
  await worker.activate();
  assert.equal(worker.claimCalls, 1);
});

/* ── "Update now" ────────────────────────────────────────────────────────────── */

test("skipWaiting happens only when the page sends { type: \"SKIP_WAITING\" }", () => {
  const worker = makeBrowser().startWorker();
  worker.message(undefined);
  worker.message(null);
  worker.message("SKIP_WAITING");
  worker.message({ type: "something else" });
  assert.equal(worker.skipWaitingCalls, 0);
  worker.message({ type: "SKIP_WAITING" });
  assert.equal(worker.skipWaitingCalls, 1);
});

/* ── fetch ───────────────────────────────────────────────────────────────────── */

test("the app's own files come from the cache and the network is not asked", async () => {
  const { browser, worker } = await running();
  browser.online({ tag: "newer" });                       // the server has moved on; the phone has not
  for (const p of SHELL) assert.equal(await text(await worker.fetch(get(p))), p + " one");
  assert.equal(browser.requests.length, 0);
});

test("the query string is ignored: /?demo, /?sw and /app.js?v=3 are answered from the cache", async () => {
  const { browser, worker } = await running();
  browser.offline();
  assert.equal(await text(await worker.fetch(page("/?demo"))), "/ one");
  assert.equal(await text(await worker.fetch(page("/?sw"))), "/ one");
  assert.equal(await text(await worker.fetch(page("/index.html?demo"))), "/index.html one");
  assert.equal(await text(await worker.fetch(get("/app.js?v=3"))), "/app.js one");
  assert.equal(await text(await worker.fetch(get("/styles.css?v=3"))), "/styles.css one");
  assert.equal(browser.requests.length, 0);
});

test("with no network at all, a launch gets every file", async () => {
  const { browser, worker } = await running();
  browser.offline();
  assert.equal(await text(await worker.fetch(page("/"))), "/ one");
  for (const p of SHELL) assert.equal(await text(await worker.fetch(get(p))), p + " one");
  for (const url of SDK) assert.equal(await text(await worker.fetch(get(url))), "sdk " + url);
  assert.equal(browser.requests.length, 0);
});

test("a same-origin file that is not kept comes from the network and is not stored", async () => {
  const { browser, worker, VERSION } = await running();
  const before = await browser.keys(VERSION);
  browser.routes.set(ORIGIN + "/icon-512.png", () => new Response("big icon", { headers: { "content-type": "image/png" } }));
  assert.equal(await text(await worker.fetch(get("/icon-512.png"))), "big icon");
  assert.equal(browser.requests.length, 1);
  assert.deepEqual(await browser.keys(VERSION), before);
});

test("a page load that is not kept falls back to /index.html when the network fails", async () => {
  const { browser, worker } = await running();
  browser.offline();
  assert.equal(await text(await worker.fetch(page("/some/other/address"))), "/index.html one");
});

test("anything else that is not kept fails when the network fails (no page in place of a script)", async () => {
  const { browser, worker } = await running();
  browser.offline();
  await assert.rejects(worker.fetch(get("/not-kept.js")), /Failed to fetch/);
  await assert.rejects(worker.fetch(get("/icon-512.png")), /Failed to fetch/);
});

test("a page load that is not kept takes the server's answer when there is a network", async () => {
  const { browser, worker } = await running();
  browser.routes.set(ORIGIN + "/elsewhere", () => new Response("from the server", { headers: { "content-type": "text/html" } }));
  assert.equal(await text(await worker.fetch(page("/elsewhere"))), "from the server");
});

test("the SDK comes from the cache; a file that is not kept yet is fetched and then kept", async () => {
  const { browser, worker, VERSION } = await running(makeBrowser(), { sdk: false });
  assert.equal((await browser.keys(VERSION)).length, SHELL.length);

  browser.online();                                        // the SDK is reachable now
  assert.equal(await text(await worker.fetch(get(SDK[0]))), "sdk " + SDK[0]);
  assert.equal(browser.requests.length, 1);
  assert.equal((await browser.keys(VERSION)).includes(SDK[0]), true, "kept after the first load");

  browser.offline();
  assert.equal(await text(await worker.fetch(get(SDK[0]))), "sdk " + SDK[0]);
  assert.equal(browser.requests.length, 1, "second load: no network");
  await assert.rejects(worker.fetch(get(SDK[1])), /Failed to fetch/);
});

test("an SDK error answer is passed on but not kept", async () => {
  const { browser, worker, VERSION } = await running(makeBrowser(), { sdk: false });
  browser.routes.set(SDK[0], () => new Response("down", { status: 503 }));
  const response = await worker.fetch(get(SDK[0]));
  assert.equal(response.status, 503);
  assert.equal((await browser.keys(VERSION)).includes(SDK[0]), false);
});

test("everything else is left to the browser", async () => {
  const { browser, worker } = await running();
  const others = [
    "https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?VER=8",
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup",
    "https://securetoken.googleapis.com/v1/token",
    "https://your-project-id.firebaseapp.com/__/auth/handler",
    "https://apis.google.com/js/api.js",
    "https://fonts.googleapis.com/css2?family=Rubik",
    "https://fonts.gstatic.com/s/rubik/v28/x.woff2",
    "https://www.gstatic.com/other/file.js",
    "https://www.google.com/maps/dir/?api=1"
  ];
  for (const url of others) assert.equal(await worker.fetch(get(url)), UNTOUCHED, url);
  assert.equal(await worker.fetch({ method: "POST", url: ORIGIN + "/anything", mode: "cors" }), UNTOUCHED);
  assert.equal(await worker.fetch({ method: "POST", url: SDK[0], mode: "cors" }), UNTOUCHED);
  assert.equal(await worker.fetch({ method: "HEAD", url: ORIGIN + "/app.js", mode: "cors" }), UNTOUCHED);
  assert.equal(browser.requests.length, 0);
});

test("a storage error while looking in the cache does not stop the network answering", async () => {
  const { browser, worker } = await running();
  browser.online({ tag: "server" });
  browser.caches.open = async () => { throw new Error("storage is unhappy"); };
  assert.equal(await text(await worker.fetch(get("/app.js"))), "/app.js server");
  assert.equal(await text(await worker.fetch(get(SDK[0]))), "sdk " + SDK[0]);
});

/* ── a new version ───────────────────────────────────────────────────────────── */

function nextVersion(source) {
  const bumped = source.replace(/const VERSION = "tastings-v(\d+)"/, (all, n) => `const VERSION = "tastings-v${Number(n) + 1}"`);
  assert.notEqual(bumped, source, "could not find the VERSION line in sw.js");
  return bumped;
}

test("an update installs beside the running version, waits, and takes over only when told", async () => {
  const { browser, worker: one, VERSION: v1 } = await running();

  // A new version is deployed while the app is open.
  browser.online({ tag: "two", sdk: false });              // the SDK is NOT reachable during this install
  const two = browser.startWorker(nextVersion(SOURCE));
  const v2 = two.read("VERSION");
  assert.notEqual(v2, v1);
  await two.install();

  // Both versions are complete, side by side. The SDK was carried over without the network.
  assert.deepEqual(await browser.keys(v2), [...SHELL.map(p => ORIGIN + p), ...SDK].sort());
  assert.equal((await browser.keys(v1)).length, SHELL.length + SDK.length);
  assert.equal(browser.requests.filter(r => r.url.startsWith("https://www.gstatic.com/")).length, 0);
  assert.equal(two.skipWaitingCalls, 0, "the new version waits");
  assert.deepEqual(browser.deleted, []);

  // The open app is still answered by the old version, from the old files only.
  assert.equal(await text(await one.fetch(get("/app.js"))), "/app.js one");
  assert.equal(await text(await one.fetch(page("/"))), "/ one");

  // "Update now".
  two.message({ type: "SKIP_WAITING" });
  assert.equal(two.skipWaitingCalls, 1);
  await two.activate();
  assert.deepEqual(browser.deleted, [v1]);
  assert.equal(await text(await two.fetch(get("/app.js"))), "/app.js two");
  assert.equal(await text(await two.fetch(page("/?demo"))), "/ two");
  browser.offline();
  assert.equal(await text(await two.fetch(get(SDK[2]))), "sdk " + SDK[2]);
});

test("an update whose download fails leaves the running version exactly as it was", async () => {
  const { browser, worker: one, VERSION: v1 } = await running();
  const before = await browser.keys(v1);

  browser.online({ tag: "two", missing: ["/pay.js"] });
  const two = browser.startWorker(nextVersion(SOURCE));
  await assert.rejects(two.install());

  assert.deepEqual([...browser.stores.keys()], [v1]);
  assert.deepEqual(await browser.keys(v1), before);
  assert.deepEqual(browser.deleted, []);
  browser.offline();
  for (const p of SHELL) assert.equal(await text(await one.fetch(get(p))), p + " one");
});

test("a version never serves a file from another version's cache", async () => {
  const { browser, worker } = await running();
  await (await browser.caches.open("tastings-v999")).put("/extra.js", new Response("from another version"));
  await (await browser.caches.open("tastings-v999")).put("/app.js", new Response("from another version"));
  browser.offline();
  await assert.rejects(worker.fetch(get("/extra.js")), /Failed to fetch/);
  assert.equal(await text(await worker.fetch(get("/app.js"))), "/app.js one");
});

/* ── sw.js against the real public/ folder ───────────────────────────────────── */
// These two fail until every engineer's file is in place, and again whenever a file is added
// to public/ without adding it to SHELL in sw.js. That is their job.

function publicFiles(dir = PUBLIC, base = "") {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) found.push(...publicFiles(path.join(dir, entry.name), base + "/" + entry.name));
    else found.push(base + "/" + entry.name);
  }
  return found;
}

test("every file in the shell list exists in public/", () => {
  const missing = SHELL.filter(p => p !== "/" && !fs.existsSync(path.join(PUBLIC, p)));
  assert.deepEqual(missing, [], "listed in sw.js but not in public/ (the install would fail on the phone)");
});

test("every file in public/ is in the shell list", () => {
  const unlisted = publicFiles().filter(p => !SHELL.includes(p) && !NOT_KEPT.includes(p));
  assert.deepEqual(unlisted, [], "in public/ but not in SHELL in sw.js (it would be missing with no reception)");
});

test("the app imports the same SDK files the worker keeps", { skip: !fs.existsSync(path.join(PUBLIC, "remote-firebase.js")) && "remote-firebase.js is not there yet" }, () => {
  const kept = new Set(SDK.map(url => url.match(/firebasejs\/([^/]+)\//)[1]));
  for (const file of publicFiles().filter(p => p.endsWith(".js") && p !== "/sw.js")) {
    const source = fs.readFileSync(path.join(PUBLIC, file), "utf8");
    for (const [, version] of source.matchAll(/https:\/\/www\.gstatic\.com\/firebasejs\/(\d+\.\d+\.\d+)\//g)) {
      assert.equal(kept.has(version), true, `${file} loads Firebase SDK ${version}; sw.js keeps ${[...kept].join(", ")}`);
    }
  }
});
