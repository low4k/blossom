

const ALLOWED_HOSTNAMES = ["localhost", "127.0.0.1"];
const VERSION_KEY = "blossom_version";

let swReady = false;

async function purgeStaleData() {
  console.log("[Blossom] Purging stale SW data...");

  const regs = await navigator.serviceWorker.getRegistrations();
  for (const reg of regs) {
    if (reg.active?.scriptURL?.includes("/sw.js") || reg.scope.endsWith("/")) {
      await reg.unregister();
      console.log("[Blossom] Unregistered SW:", reg.scope);
    }
  }

  const cacheNames = await caches.keys();
  for (const name of cacheNames) {
    await caches.delete(name);
    console.log("[Blossom] Deleted cache:", name);
  }

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

export async function registerSW(serverVersion, proxyPrefix, scramjetPrefix) {
  if (swReady) return true;

  if (!navigator.serviceWorker) {
    if (location.protocol !== "https:" && !ALLOWED_HOSTNAMES.includes(location.hostname)) {
      throw new Error("Service workers require HTTPS. Try accessing via https:// or localhost.");
    }
    throw new Error("Your browser doesn't support service workers.");
  }

  const storedVersion = localStorage.getItem(VERSION_KEY);
  if (serverVersion && storedVersion !== serverVersion) {
    console.log(`[Blossom] Version changed: ${storedVersion} -> ${serverVersion}`);
    await purgeStaleData();
    localStorage.setItem(VERSION_KEY, serverVersion);
  }

  const p = encodeURIComponent(proxyPrefix || "/assets/wasm/");
  const s = encodeURIComponent(scramjetPrefix || "/~/");
  const swUrl = `/sw.js?p=${p}&s=${s}`;

  const reg = await navigator.serviceWorker.register(swUrl, { updateViaCache: "none" });

  if (reg.waiting) {
    reg.waiting.postMessage({ type: "skipWaiting" });
  }

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

  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
      setTimeout(resolve, 3000);
    });
  }

  swReady = true;
  return true;
}
