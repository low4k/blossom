// Anti-CAPTCHA session vault (client side).
//
// Two jobs:
//  1. Restore: pull vaulted cookies from the server and seed Scramjet's jar
//     through its "cookie" SW message channel. This runs right after login,
//     before any proxied navigation, so a previously solved CAPTCHA stays
//     solved even after the IDB jar was purged (deploys) or on a new device.
//  2. Capture: read the Scramjet jar from IndexedDB (same origin as the SW),
//     filter to the server's watch hosts, and push changes to the vault.
//
// The jar row is Scramjet's own format: a map keyed "domain@path@name" whose
// values are cookie objects. We store those objects verbatim server-side so
// restore is a pure round trip.

const SYNC_INTERVAL_MS = 15000;
const EVENT_DEDUP_MS = 10000;

let watchHosts = [];
let onChallengeCb = null;
let lastSent = new Map(); // host -> signature of last synced snapshot
const recentEvents = new Map(); // host:kind -> ts

function matchesWatch(domain, watch) {
  const d = String(domain || "").toLowerCase();
  const w = watch.split(":")[0]; // watch entries may carry a :port (tests)
  return d === w || d === "." + w || d.endsWith("." + w);
}

// The IDB db is created/owned by the SW worker. Only open it if it already
// exists so we never race store creation (object stores belong to Scramjet).
async function readJar() {
  try {
    if (!indexedDB.databases) return await openJar(); // pre-Chrome-71 fallback
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === "$scramjet")) return null;
    return await openJar();
  } catch {
    return null;
  }
}

function openJar() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open("$scramjet", 1); } catch { return resolve(null); }
    // Never let this reader create/upgrade the shared DB — Scramjet (and the
    // SW boot) own schema creation. Aborting prevents an empty-store DB.
    req.onupgradeneeded = () => { try { req.transaction?.abort(); } catch {} };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("cookies")) { db.close(); return resolve(null); }
      let get;
      try { get = db.transaction("cookies", "readonly").objectStore("cookies").get("cookies"); }
      catch { db.close(); return resolve(null); }
      get.onsuccess = () => { const v = get.result || {}; db.close(); resolve(v); };
      get.onerror = () => { db.close(); resolve(null); };
    };
  });
}

export async function syncVaultFromJar() {
  if (!watchHosts.length) return { synced: 0 };
  const jar = await readJar();
  if (!jar || typeof jar !== "object") return { synced: 0 };

  const byHost = new Map();
  for (const c of Object.values(jar)) {
    if (!c || typeof c.name !== "string" || typeof c.value !== "string") continue;
    const domain = String(c.domain || "").toLowerCase();
    if (!domain) continue;
    if (!watchHosts.some((w) => matchesWatch(domain, w))) continue;
    const site = domain.replace(/^\./, "");
    if (!byHost.has(site)) byHost.set(site, []);
    byHost.get(site).push({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      sameSite: c.sameSite,
      expires: c.expires,
      secure: c.secure,
      httpOnly: c.httpOnly,
    });
  }

  let changed = 0;
  for (const [host, cookies] of byHost) {
    const sig = JSON.stringify(cookies.map((c) => `${c.name}=${c.value}`).sort());
    if (lastSent.get(host) === sig) continue;
    try {
      const r = await fetch(`/api/captcha/vault/${encodeURIComponent(host)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookies }),
      });
      if (r.ok) { lastSent.set(host, sig); changed++; }
    } catch { /* offline / mid-navigation: next tick retries */ }
  }
  return { synced: changed };
}

async function restoreVault(controller) {
  let data;
  try {
    const r = await fetch("/api/captcha/vault", { headers: { Accept: "application/json" } });
    if (!r.ok) return 0;
    data = await r.json();
  } catch { return 0; }

  let seeded = 0;
  for (const [host, cookies] of Object.entries(data.hosts || {})) {
    for (const c of cookies) {
      // Scramjet's SW message channel: merges into its jar + persists to IDB.
      controller.postMessage({ scramjet$type: "cookie", cookie: c, url: `https://${host}/` });
      seeded++;
    }
  }
  return seeded;
}

function handleSwMessage(e) {
  const d = e.data;
  if (d?.type !== "blossom:captcha") return;
  const key = `${d.host}:${d.kind}`;
  const now = Date.now();
  if (now - (recentEvents.get(key) || 0) < EVENT_DEDUP_MS) return;
  recentEvents.set(key, now);
  onChallengeCb?.(d.host, d.kind, d.url);
  fetch(`/api/captcha/event?solve=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: d.host, kind: d.kind, url: d.url }),
  }).catch(() => {});
}

// config: from /blossom-config.json. onChallenge(host, kind, url): UI hook.
export async function initVaultSync(config, { onChallenge } = {}) {
  watchHosts = config?.captchaWatchHosts || [];
  if (!watchHosts.length) return;

  onChallengeCb = onChallenge || null;
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", handleSwMessage);
  }

  // Restore once the SW controls the page (the jar listener only exists then).
  const controller = navigator.serviceWorker?.controller;
  if (controller) {
    try { await restoreVault(controller); } catch {}
  }

  setInterval(() => { syncVaultFromJar().catch(() => {}); }, SYNC_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncVaultFromJar().catch(() => {});
  });

  // Test/QA hook (and opens the console door to curious users)
  window.__blossomVault = {
    syncNow: () => syncVaultFromJar(),
    restore: () =>
      navigator.serviceWorker?.controller
        ? restoreVault(navigator.serviceWorker.controller)
        : Promise.resolve(0),
  };
}
