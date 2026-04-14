// Service worker registration for Scramjet

const SW_PATH = "./sw.js";
const ALLOWED_HOSTNAMES = ["localhost", "127.0.0.1"];
const VERSION_KEY = "blossom_version";

let swReady = false;

// Nuke ALL stale service workers, caches, and IDB so fresh code always loads.
// Called automatically when the server version changes.
async function purgeStaleData() {
  console.log("[Blossom] Purging stale SW data...");

  // 1. Unregister all service workers
  const regs = await navigator.serviceWorker.getRegistrations();
  for (const reg of regs) {
    await reg.unregister();
    console.log("[Blossom] Unregistered SW:", reg.scope);
  }

  // 2. Clear all caches
  const cacheNames = await caches.keys();
  for (const name of cacheNames) {
    await caches.delete(name);
    console.log("[Blossom] Deleted cache:", name);
  }

  // 3. Delete scramjet IDB (by known name — indexedDB.databases() not supported in Firefox)
  for (const name of ["$scramjet"]) {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = resolve;
      req.onerror = resolve;
      req.onblocked = resolve;
    });
    console.log("[Blossom] Deleted IDB:", name);
  }
}

export async function registerSW(serverVersion) {
  if (swReady) return true;

  if (!navigator.serviceWorker) {
    if (location.protocol !== "https:" && !ALLOWED_HOSTNAMES.includes(location.hostname)) {
      throw new Error("Service workers require HTTPS. Try accessing via https:// or localhost.");
    }
    throw new Error("Your browser doesn't support service workers.");
  }

  // Auto-purge when server version changes (or on first visit)
  const storedVersion = localStorage.getItem(VERSION_KEY);
  if (serverVersion && storedVersion !== serverVersion) {
    console.log(`[Blossom] Version changed: ${storedVersion} → ${serverVersion}`);
    await purgeStaleData();
    localStorage.setItem(VERSION_KEY, serverVersion);
  }

  // updateViaCache: 'none' forces the browser to check the server for an updated SW
  // on every navigation, bypassing HTTP cache. This ensures users get the latest SW
  // after deployments (critical: old broken SWs would otherwise stay cached indefinitely).
  const reg = await navigator.serviceWorker.register(SW_PATH, { updateViaCache: "none" });

  // If there's a waiting SW, activate it immediately
  if (reg.waiting) {
    reg.waiting.postMessage({ type: "skipWaiting" });
  }

  // If a new SW is found during update, activate it
  reg.addEventListener("updatefound", () => {
    const newWorker = reg.installing;
    if (newWorker) {
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "activated") {
          console.log("[Blossom] New service worker activated");
        }
      });
    }
  });

  await navigator.serviceWorker.ready;

  // Wait for controller to be available (skipWaiting + clients.claim fires this)
  // This is required so that ScramjetController.init() can postMessage to the SW
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
      setTimeout(resolve, 3000); // Fallback timeout
    });
  }

  swReady = true;
  return true;
}
