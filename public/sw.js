// Blossom service worker
// This is the stock SW that Scramjet will intercept through
// Includes version checking for update management

const VERSION = "1.0.0";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Handle version check messages from the main thread
self.addEventListener("message", (event) => {
  if (event.data?.type === "VERSION_CHECK") {
    event.ports[0]?.postMessage({ version: VERSION });
  }
});
