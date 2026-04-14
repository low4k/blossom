// Service worker registration for Scramjet

const SW_PATH = "./sw.js";
const ALLOWED_HOSTNAMES = ["localhost", "127.0.0.1"];

let swReady = false;

export async function registerSW() {
  if (swReady) return true;

  if (!navigator.serviceWorker) {
    if (location.protocol !== "https:" && !ALLOWED_HOSTNAMES.includes(location.hostname)) {
      throw new Error("Service workers require HTTPS. Try accessing via https:// or localhost.");
    }
    throw new Error("Your browser doesn't support service workers.");
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
