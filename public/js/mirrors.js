

const PING_TIMEOUT = 5000;
const CHECK_INTERVAL = 30000;

let mirrors = [];
let checking = false;

export async function initMirrors(mirrorList) {
  mirrors = mirrorList || [];
  if (mirrors.length === 0) return;

  raceMirrors();

  setInterval(checkCurrentDomain, CHECK_INTERVAL);
}

async function raceMirrors() {
  const candidates = mirrors.filter((m) => !m.includes(location.hostname));
  if (candidates.length === 0) return;

  try {
    const fastest = await Promise.any(
      candidates.map(async (url) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT);
        const resp = await fetch(`${url}/health`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!resp.ok) throw new Error("unhealthy");
        return url;
      })
    );
    localStorage.setItem("blossom-best-mirror", fastest);
  } catch {
    localStorage.removeItem("blossom-best-mirror");
  }
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
      return;
    }
  } catch {

    await redirectToMirror();
  }

  checking = false;
}

async function redirectToMirror() {

  const results = await Promise.allSettled(
    mirrors
      .filter((m) => !m.includes(location.hostname))
      .map(async (url) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT);

        const resp = await fetch(`${url}/health`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!resp.ok) throw new Error("Mirror unhealthy");
        return url;
      })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {

      const newUrl = result.value + location.pathname + location.search;
      window.location.replace(newUrl);
      return;
    }
  }

  console.warn("All mirrors are down");
}

export function getBestMirror() {
  return localStorage.getItem("blossom-best-mirror");
}
