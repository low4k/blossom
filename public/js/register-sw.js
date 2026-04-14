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

  await navigator.serviceWorker.register(SW_PATH);
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
