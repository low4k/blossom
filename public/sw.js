// Blossom service worker — routes proxy requests through Scramjet
//
// CRITICAL: ScramjetServiceWorker must NOT be created at the top level.
// Its constructor opens IDB "$scramjet" v1 without the upgrade callback,
// which creates the DB with no object stores. This races against the page's
// ScramjetController.init() which opens the same DB WITH the upgrade callback
// that creates the required stores. If the SW wins the race (it always does
// because it installs first), the page's upgrade never fires, init() hangs
// forever, and the proxy never works.
//
// Solution: create ScramjetServiceWorker lazily on the first proxy fetch,
// by which time the page has already set up the IDB properly.

importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
let scramjet = null;
let ready = false;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Handle skip-waiting message from registration code (for immediate activation of updates)
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "skipWaiting") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // Intercept proxy-prefixed requests (default: /scramjet/) AND the WASM file.
  // Scramjet's route() intercepts the WASM file to wrap it as JS (base64-encoded)
  // so proxied pages can load it via importScripts(). Without this, the raw .wasm
  // file is served with application/wasm MIME type which browsers refuse to execute.
  const isProxy = url.startsWith(location.origin + "/scramjet/");
  const isWasm = scramjet && scramjet.config && url.startsWith(location.origin + scramjet.config.files.wasm);

  if (!isProxy && !isWasm) {
    return;
  }

  event.respondWith(handleProxy(event));
});

async function handleProxy(event) {
  try {
    // Lazy-init: create ScramjetServiceWorker on first proxy request.
    // By now the page's init() has created the IDB with all required stores.
    if (!scramjet) {
      scramjet = new ScramjetServiceWorker();
    }

    if (!ready) {
      // loadConfig reads config from IDB, calls Nk() (sets global $W), loads WASM
      scramjet.config = null;
      await scramjet.loadConfig();
      if (!scramjet.config) {
        throw new Error("Proxy config not available — try reloading the page");
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

    // Return a visible error page for document/iframe requests
    if (["document", "iframe"].includes(event.request.destination)) {
      const safe = String(err.message)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return new Response(
        `<!DOCTYPE html><html><body style="font-family:system-ui;background:#111;color:#eee;padding:2em;text-align:center">
        <h2>Proxy Error</h2><p style="color:#f88">${safe}</p>
        <button onclick="location.reload()" style="margin:1em;padding:.5em 1.5em;cursor:pointer">Reload</button></body></html>`,
        { status: 502, headers: { "Content-Type": "text/html" } }
      );
    }
    return new Response(err.message, { status: 502 });
  }
}
