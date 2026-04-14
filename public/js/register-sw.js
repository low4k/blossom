// Service worker registration for Scramjet
// Handles SW lifecycle + version-based update prompting

const SW_PATH = "./sw.js";
const ALLOWED_HOSTNAMES = ["localhost", "127.0.0.1"];

let swRegistered = false;

export async function registerSW() {
  if (swRegistered) return true;

  if (!navigator.serviceWorker) {
    if (location.protocol !== "https:" && !ALLOWED_HOSTNAMES.includes(location.hostname)) {
      throw new Error("Service workers require HTTPS. Try accessing via https:// or localhost.");
    }
    throw new Error("Your browser doesn't support service workers.");
  }

  // Check if existing SW needs updating
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) {
    // Force update check
    existing.update();
    swRegistered = true;
    return true;
  }

  await navigator.serviceWorker.register(SW_PATH, { scope: "/" });
  swRegistered = true;
  return false; // first registration — may need reload
}

// Check if SW version matches server version, prompt refresh if stale
export async function checkSWVersion(serverVersion) {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;

  const channel = new MessageChannel();
  navigator.serviceWorker.controller.postMessage({ type: "VERSION_CHECK" }, [channel.port2]);

  return new Promise((resolve) => {
    channel.port1.onmessage = (event) => {
      if (event.data?.version && event.data.version !== serverVersion) {
        resolve(false); // stale
      } else {
        resolve(true); // up to date
      }
    };
    // Timeout after 2s
    setTimeout(() => resolve(true), 2000);
  });
}
