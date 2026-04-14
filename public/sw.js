// Blossom service worker — routes proxy requests through Scramjet

importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
let ready = false;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// When the controller sends config via postMessage, the built-in handler
// sets scramjet.config but does NOT initialize $W or load WASM.
// Force a full re-init from IDB on the next proxy request.
self.addEventListener("message", (event) => {
  if (event.data && event.data.scramjet$type === "loadConfig") {
    scramjet.config = null;
    ready = false;
  }
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // Only intercept proxy-prefixed requests (default: /scramjet/)
  // Let all other requests (CSS, JS, images, page itself) pass through untouched
  if (!url.startsWith(location.origin + "/scramjet/")) {
    return;
  }

  event.respondWith(handleProxy(event));
});

async function handleProxy(event) {
  try {
    if (!ready) {
      // Force IDB-based loadConfig which properly calls Nk() and loads WASM
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
