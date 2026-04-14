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
  swReady = true;
  return true;
}
