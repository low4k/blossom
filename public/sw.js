// Blossom service worker — routes proxy requests through Scramjet
//
// IMPORTANT: importScripts() only works during the initial script evaluation
// or the install event. It throws NetworkError if called in fetch/activate/etc.
// So we MUST import scramjet at the top level.
//
// The proxy prefix is passed via URL parameters during registration so it's
// available immediately (no async config fetch needed):
//   navigator.serviceWorker.register("/sw.js?p=/cdn/m/&s=/~/")
//
// ScramjetServiceWorker is created LAZILY on the first proxy fetch (not at
// top level) because its constructor opens IDB "$scramjet" without upgrade
// callbacks. The page's ScramjetController.init() opens the same DB WITH
// upgrade callbacks that create the required stores. If the SW constructor
// wins the race, the page's upgrade never fires and init() hangs forever.
// By delaying construction to the first fetch event, the page has already
// finished init() by then.

// --- Read config from registration URL params ---
const _params = new URL(self.location).searchParams;
const PROXY_PREFIX = _params.get("p") || "/assets/wasm/";
const SCRAMJET_PREFIX = _params.get("s") || "/~/";

// --- Import scramjet scripts at top level (MUST happen here, not in fetch) ---
importScripts(PROXY_PREFIX + "scramjet.all.js");
const { ScramjetServiceWorker: ScramjetSWClass } = $scramjetLoadWorker();

let scramjet = null;
let ready = false;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  if (event.data?.type === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  const origin = location.origin;

  // Only intercept proxy-prefixed URLs and WASM fetches
  const isProxy = url.startsWith(origin + SCRAMJET_PREFIX);
  const isWasm = scramjet?.config && url.startsWith(origin + scramjet.config.files.wasm);

  if (!isProxy && !isWasm) return;

  event.respondWith(handleProxy(event));
});

async function handleProxy(event) {
  try {
    // Lazy-init: create ScramjetServiceWorker on first proxy request.
    // By now the page's ScramjetController.init() has set up IDB properly.
    if (!scramjet) {
      scramjet = new ScramjetSWClass();
    }

    if (!ready) {
      scramjet.config = null;
      await scramjet.loadConfig();
      if (!scramjet.config) {
        throw new Error("Configuration not available — try reloading the page");
      }
      ready = true;
    }

    if (!scramjet.route(event)) {
      return fetch(event.request);
    }

    return await scramjet.fetch(event);
  } catch (err) {
    ready = false;
    console.error("[Blossom SW]", err);

    if (["document", "iframe"].includes(event.request.destination)) {
      const safe = String(err.message)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return new Response(
        `<!DOCTYPE html><html><body style="font-family:system-ui;background:#111;color:#eee;padding:2em;text-align:center">
        <h2>Connection Error</h2><p style="color:#f88">${safe}</p>
        <button onclick="location.reload()" style="margin:1em;padding:.5em 1.5em;cursor:pointer">Reload</button></body></html>`,
        { status: 502, headers: { "Content-Type": "text/html" } }
      );
    }
    return new Response(err.message, { status: 502 });
  }
}
