/* Service worker: keeps the whole app on the phone.

   The app is used inside stores with little or no reception, so every launch is answered
   from the copy kept here and never waits for the network.

   How a new version reaches the phone
     1. VERSION below is raised and the site is deployed (see README.md).
     2. The phone downloads every file of the new version in the background, into a cache of
        its own. The app that is open keeps running on the old files. If a single file fails,
        the whole download is dropped and tried again later, so a half-downloaded version is
        never used.
     3. The new version then WAITS. It takes over when the page sends { type: "SKIP_WAITING" }
        ("Update now"), or the next time the app is opened after being fully closed.

   Each version serves only from its own cache, so files from two versions are never mixed. */

const VERSION = "tastings-v6";   // RAISE THE NUMBER ON EVERY DEPLOY: tastings-v2, tastings-v3, …
const PREFIX = "tastings-";      // the only caches this worker is ever allowed to delete

// Every file the app loads. A file that is added to public/ and loaded by the app goes here too.
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/pay.js",
  "/holidays.js",
  "/model.js",
  "/report.js",
  "/store.js",
  "/remote-firebase.js",
  "/firebase-config.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/apple-touch-icon.png"
];

// The Firebase SDK, kept as well so sync can start without downloading it again.
// Must be the version remote-firebase.js imports.
const SDK_HOME = "https://www.gstatic.com/firebasejs/";
const SDK = [
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js"
];
const SDK_WAIT_MS = 20000;       // how long the install waits for an SDK file before going on without it

/* ── install: download the new version, all or nothing ───────────────────────── */

self.addEventListener("install", event => {
  // No skipWaiting() here, on purpose: a new version waits (step 3 above).
  event.waitUntil(install());
});

async function install() {
  // Every shell file is downloaded in full first. Nothing is stored until all of them are in hand.
  const files = await Promise.all(SHELL.map(async path => {
    // "reload" = straight from the server, never from the browser's own HTTP cache.
    const file = await download(path, { cache: "reload" });
    // Firebase Hosting answers a missing file with index.html and "200 OK" (the rewrite in
    // firebase.json). A page where a script, a style sheet or a picture should be = not there.
    const type = file.headers.get("content-type") || "";
    const isPage = path === "/" || path.endsWith(".html");
    if (!isPage && type.includes("text/html")) throw new Error(path + " is missing (the server sent a page instead)");
    return file;
  }));

  const cache = await caches.open(VERSION);
  await Promise.all(SHELL.map((path, i) => cache.put(path, files[i])));

  // Best effort from here on: nothing below can fail the install.
  await Promise.all(SDK.map(url => keepSdkFile(cache, url)));
}

// Downloads one file completely and returns a clean copy that can be stored and served later.
async function download(url, options) {
  const res = await fetch(url, options);
  if (res.status !== 200) throw new Error(url + " answered " + res.status);
  const body = await res.blob();                 // the whole file is in memory before anything is stored
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");            // the body is already unpacked
  headers.delete("content-length");
  // A fresh Response also drops the "redirected" mark, which a browser refuses for a page load.
  return new Response(body, { status: 200, headers });
}

async function keepSdkFile(cache, url) {
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), SDK_WAIT_MS);
  try {
    if (await cache.match(url, { ignoreVary: true })) return;
    // The address carries the SDK version, so a copy kept by the previous version of this
    // worker is the same file: move it across instead of downloading it again.
    const file = await copyFromOlderCache(url)
              || await download(url, { credentials: "omit", signal: giveUp.signal });
    await cache.put(url, file);
  } catch (err) {
    // Not kept this time. The fetch handler below keeps it the first time the app loads it.
  } finally {
    clearTimeout(timer);
  }
}

async function copyFromOlderCache(url) {
  for (const name of await caches.keys()) {
    if (name === VERSION || !name.startsWith(PREFIX)) continue;
    const older = await caches.open(name);
    const file = await older.match(url, { ignoreVary: true });
    if (file) return file;
  }
  return null;
}

/* ── activate: this version takes over ───────────────────────────────────────── */

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      const old = names.filter(name => name.startsWith(PREFIX) && name !== VERSION);
      await Promise.all(old.map(name => caches.delete(name)));
    } catch (err) {
      // An old cache left behind costs a little space and nothing else.
    }
    await self.clients.claim();
  })());
});

/* ── "Update now" ────────────────────────────────────────────────────────────── */

self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/* ── fetch: the kept copy first ──────────────────────────────────────────────── */

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  if (new URL(request.url).origin === self.location.origin) {
    event.respondWith(fromShell(request));
  } else if (request.url.startsWith(SDK_HOME)) {
    event.respondWith(fromSdk(event, request));
  }
  // Everything else (Firestore, Google sign-in, fonts, Maps) is left alone: with no
  // respondWith the browser does exactly what it would do without a service worker.
});

// Looks in this version's cache and nowhere else. A storage error counts as "not kept",
// so the network still gets its turn.
async function kept(request, options) {
  try {
    const cache = await caches.open(VERSION);
    return (await cache.match(request, options)) || null;
  } catch (err) {
    return null;
  }
}

// The app's own files: the kept copy, whatever follows the "?" in the address (/?demo, /app.js?v=3).
// What comes from the network here is passed on but not kept: a version's cache holds only
// the files downloaded together at install.
async function fromShell(request) {
  const file = await kept(request, { ignoreSearch: true, ignoreVary: true });
  if (file) return file;
  try {
    return await fetch(request);
  } catch (err) {
    // Not kept and no network. A page load still gets the app; anything else fails as it would have.
    const page = request.mode === "navigate" ? await kept("/index.html", { ignoreVary: true }) : null;
    if (page) return page;
    throw err;
  }
}

// The Firebase SDK: the kept copy; otherwise the network, and keep what comes back.
async function fromSdk(event, request) {
  const file = await kept(request, { ignoreVary: true });
  if (file) return file;
  const res = await fetch(request);
  if (res.status === 200) {
    const copy = res.clone();
    event.waitUntil(caches.open(VERSION).then(cache => cache.put(request, copy)).catch(() => {}));
  }
  return res;
}
