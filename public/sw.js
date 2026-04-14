// Blossom service worker — routes proxy requests through Scramjet

importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
let configLoaded = false;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  event.respondWith(
    (async () => {
      try {
        if (!configLoaded) {
          await scramjet.loadConfig();
          configLoaded = true;
        }
        if (scramjet.route(event)) {
          return await scramjet.fetch(event);
        }
      } catch (err) {
        // Config not ready yet or proxy error — fall through to normal fetch
        configLoaded = false;
        console.error("[Blossom SW]", err.message);
      }
      return fetch(event.request);
    })()
  );
});
