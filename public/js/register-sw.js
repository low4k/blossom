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

  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) {
    existing.update();
    // Wait for the SW to be ready (handles page refresh edge case)
    await navigator.serviceWorker.ready;
    swRegistered = true;
    return true;
  }

  // First registration — register and wait for activation
  const reg = await navigator.serviceWorker.register(SW_PATH, { scope: "/" });
  await new Promise((resolve) => {
    const sw = reg.installing || reg.waiting || reg.active;
    if (sw.state === "activated") return resolve();
    sw.addEventListener("statechange", () => {
      if (sw.state === "activated") resolve();
    });
  });
  swRegistered = true;
  return true;
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
