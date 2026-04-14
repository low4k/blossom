// Domain survival / mirror system
// Pings backup domains and auto-redirects if current domain dies
// No existing proxy site does this properly

const PING_TIMEOUT = 5000;
const CHECK_INTERVAL = 30000; // Check every 30s

let mirrors = [];
let checking = false;

export async function initMirrors(mirrorList) {
  mirrors = mirrorList || [];
  if (mirrors.length === 0) return;

  // Periodic health check of current domain
  setInterval(checkCurrentDomain, CHECK_INTERVAL);
}

async function checkCurrentDomain() {
  if (checking || mirrors.length === 0) return;
  checking = true;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT);

    const resp = await fetch("/health", { signal: controller.signal });
    clearTimeout(timeout);

    if (resp.ok) {
      checking = false;
      return; // Current domain is fine
    }
  } catch {
    // Current domain is down — find a working mirror
    await redirectToMirror();
  }

  checking = false;
}

async function redirectToMirror() {
  // Ping all mirrors, redirect to first that responds
  const results = await Promise.allSettled(
    mirrors
      .filter((m) => !m.includes(location.hostname))
      .map(async (url) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT);

        const resp = await fetch(`${url}/health`, {
          signal: controller.signal,
          mode: "no-cors",
        });
        clearTimeout(timeout);

        return url;
      })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      // Found a working mirror
      const newUrl = result.value + location.pathname + location.search;
      window.location.replace(newUrl);
      return;
    }
  }

  // No mirrors available — show error
  console.warn("All mirrors are down");
}

// Store fastest mirror in localStorage for offline reference
export function getBestMirror() {
  return localStorage.getItem("blossom-best-mirror");
}
