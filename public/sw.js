

const _params = new URL(self.location).searchParams;
const PROXY_PREFIX = _params.get("p") || "/assets/wasm/";
const SCRAMJET_PREFIX = _params.get("s") || "/~/";

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

  const isProxy = url.startsWith(origin + SCRAMJET_PREFIX);
  const isWasm = scramjet?.config && url.startsWith(origin + scramjet.config.files.wasm);

  if (!isProxy && !isWasm) return;

  event.respondWith(handleProxy(event));
});

async function handleProxy(event) {
  try {

    if (!scramjet) {
      scramjet = new ScramjetSWClass();
    }

    if (!ready) {
      scramjet.config = null;
      await scramjet.loadConfig();
      if (!scramjet.config) {
        throw new Error("Configuration not available - try reloading the page");
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
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      // The error marker id/data attribute is detected by app.js, which then
      // shows the app-level error overlay with working Retry/Home buttons.
      return new Response(
        `<!DOCTYPE html><html><body style="font-family:system-ui;background:#111;color:#eee;padding:2em;text-align:center">
        <div id="blossom-sw-error" data-detail="${safe}"></div>
        <h2>Connection Error</h2><p style="color:#f88">${safe}</p>
        <button onclick="location.reload()" style="margin:1em;padding:.5em 1.5em;cursor:pointer">Reload</button></body></html>`,
        { status: 502, headers: { "Content-Type": "text/html" } }
      );
    }
    return new Response(err.message, { status: 502 });
  }
}
