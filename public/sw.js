const _params = new URL(self.location).searchParams;
const PROXY_PREFIX = _params.get("p") || "/assets/wasm/";
const SCRAMJET_PREFIX = _params.get("s") || "/~/";

importScripts(PROXY_PREFIX + "scramjet.all.js");
const { ScramjetServiceWorker: ScramjetSWClass } = $scramjetLoadWorker();

let scramjet = null;
let ready = false;
let jarHydrated = null;

// The ScramjetSWClass constructor kicks off an IDB read of the cookie jar
// but never awaits it, so the first fetch can observe an empty jar. We force
// a deterministic hydration: read the row ourselves and load it before the
// first proxied fetch is allowed through.
async function hydrateJar(sw) {
  try {
    const db = await openJarDb();
    if (!db) return;
    const row = await new Promise((res) => {
      let g;
      try { g = db.transaction("cookies", "readonly").objectStore("cookies").get("cookies"); }
      catch { return res(null); }
      g.onsuccess = () => res(g.result);
      g.onerror = () => res(null);
    });
    db.close();
    if (row) sw.cookieStore.load(row);
  } catch {}
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// --- Anti-CAPTCHA vault seeding ------------------------------------------
// Vault cookie seeds arrive from the page as {scramjet$type:"cookie",...}
// messages BEFORE any proxied navigation — often before the Scramjet SW
// class is constructed (it builds lazily on first fetch). We therefore
// persist seeds into the shared "$scramjet" IDB row ourselves; the jar is
// hydrated from that row when the Scramjet SW is constructed, and if an
// instance is already alive we apply the cookie to its in-memory store too.

function openJarDb() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open("$scramjet", 1); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("config")) db.createObjectStore("config");
      if (!db.objectStoreNames.contains("cookies")) db.createObjectStore("cookies");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

// Normalisation mirrors Scramjet's CookieStore.setCookies().
function normalizeSeed(cookie, url) {
  const c = { ...cookie };
  const host = new URL(url).hostname;
  if (!c.domain) c.domain = "." + host;
  if (!c.domain.startsWith(".")) c.domain = "." + c.domain;
  if (!c.path) c.path = "/";
  if (!c.sameSite) c.sameSite = "lax";
  if (c.expires) c.expires = String(c.expires);
  return c;
}

async function seedJar(cookie, url) {
  // Scramjet posts cookies through this channel as raw "name=value; ..." strings
  // (frame's document.cookie trap) or as objects (our vault restore). Strings
  // pass straight through to CookieStore.setCookies(); objects need the jar-key
  // merge below. Junk cookie objects (the alpha sometimes emits cookie:undefined)
  // are discarded here instead of landing in the jar as "undefined=undefined".
  let c = cookie;
  if (typeof c === "string") {
    const parts = c.split(";");
    const nv = parts[0]?.split("=");
    if (!nv || !nv[0]) return;
    c = { name: nv[0].trim(), value: (nv.slice(1).join("=") || "").trim() };
  }
  if (!c || typeof c !== "object") return;
  if (typeof c.name !== "string" || !c.name || c.name === "undefined") return;
  if (c.value === undefined || c.value === "undefined") c.value = "";

  const db = await openJarDb();
  if (!db) return;
  try {
    const store = db.transaction("cookies", "readwrite").objectStore("cookies");
    const current = await new Promise((res) => {
      const g = store.get("cookies");
      g.onsuccess = () => res(g.result || {});
      g.onerror = () => res({});
    });
    const jar = typeof current === "string" ? JSON.parse(current || "{}") : current;
    const key = `${c.domain || "." + new URL(url).hostname}@${c.path || "/"}@${c.name}`;
    jar[key] = normalizeSeed(c, url);
    await new Promise((res) => {
      const p = store.put(jar, "cookies");
      p.onsuccess = res; p.onerror = res;
    });
  } catch (e) {
    console.error("[Blossom SW] seed persist failed", e);
  } finally {
    db.close();
  }
  // Live-apply if the Scramjet SW instance already exists.
  if (scramjet?.cookieStore) {
    try { scramjet.cookieStore.setCookies([cookie], new URL(url)); } catch {}
  }
}

self.addEventListener("message", (event) => {
  const d = event.data;
  if (d?.type === "skipWaiting") self.skipWaiting();
  if (d?.scramjet$type === "cookie" && d.cookie && d.url) {
    seedJar(d.cookie, d.url);
  }
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  const origin = location.origin;

  const isProxy = url.startsWith(origin + SCRAMJET_PREFIX);
  const isWasm = scramjet?.config && url.startsWith(origin + scramjet.config.files.wasm);

  if (!isProxy && !isWasm) return;

  event.respondWith(handleProxy(event));
});

// --- Challenge detection -------------------------------------------------
// After Scramjet serves a document/iframe, scan the response body for
// challenge markers and tell pages so they can surface the "solve it once"
// guidance. Cookie capture happens page-side (the jar dump lives in the
// shared $scramjet IDB row).

const CHALLENGE_MARKERS = [
  { kind: "google",     needles: ["/sorry/index", "unusual traffic from your computer network", "Our systems have detected unusual traffic"] },
  { kind: "cloudflare", needles: ["cf-chl-", "challenges.cloudflare.com", "cf-turnstile", "Verify you are human"] },
  { kind: "recaptcha",  needles: ["g-recaptcha", "recaptcha/api2", "recaptcha/api.js"] },
  { kind: "hcaptcha",   needles: ["hcaptcha.com/1/api.js", "h-captcha"] },
  { kind: "reddit",     needles: ["You've been blocked", "whoa there, pardner", "www.reddit.com/block"] },
];

function detectChallenge(response, targetUrl) {
  if (!response || (!response.ok && response.status !== 403 && response.status !== 429)) return;
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return;
  response
    .clone()
    .text()
    .then((text) => {
      const body = text.slice(0, 262144);
      const path = targetUrl.pathname + targetUrl.search;
      let kind = null;
      if (/(^|\.)google\.[a-z.]+$/.test(targetUrl.hostname) && path.startsWith("/sorry")) {
        kind = "google";
      } else {
        for (const m of CHALLENGE_MARKERS) {
          if (m.needles.some((n) => body.includes(n))) { kind = m.kind; break; }
        }
      }
      if (!kind) return;
      const msg = { type: "blossom:captcha", host: targetUrl.hostname, kind, url: targetUrl.href };
      return self.clients
        .matchAll({ includeUncontrolled: true, type: "window" })
        .then((clients) => clients.forEach((c) => c.postMessage(msg)));
    })
    .catch(() => {});
}

// --- Watch hosts + cookie capture -----------------------------------------
// Config is fetched from the server (session cookie rides along same-origin)
// once per SW lifetime. The page-side full-jar sync in vault.js covers
// document.cookie writes; here we capture network-level Set-Cookie on
// watched hosts — the path scramjet-alpha does not persist reliably.

let watchHostsCache = null;
async function getWatchHosts() {
  if (watchHostsCache) return watchHostsCache;
  try {
    const r = await fetch("/blossom-config.json", { headers: { Accept: "application/json" } });
    const j = await r.json();
    watchHostsCache = j.captchaWatchHosts || [];
  } catch {
    watchHostsCache = [];
  }
  return watchHostsCache;
}

function watchEntryFor(hostname) {
  const h = String(hostname || "").toLowerCase();
  for (const w of watchHostsCache || []) {
    const bare = w.split(":")[0];
    if (h === bare || h.endsWith("." + bare)) return w;
  }
  return null;
}

function parseSetCookieLine(line, targetUrl) {
  const parts = String(line).split(";");
  const nv = parts[0]?.split("=");
  if (!nv || nv.length < 2) return null;
  const name = nv[0].trim();
  const value = nv.slice(1).join("=").trim();
  if (!name) return null;
  const c = { name, value, secure: false, httpOnly: false };
  for (const attr of parts.slice(1)) {
    const eq = attr.indexOf("=");
    const k = (eq === -1 ? attr : attr.slice(0, eq)).trim().toLowerCase();
    const v = eq === -1 ? "" : attr.slice(eq + 1).trim();
    if (k === "domain") c.domain = v;
    else if (k === "path") c.path = v;
    else if (k === "samesite") c.sameSite = v.toLowerCase();
    else if (k === "expires") c.expires = v;
    else if (k === "max-age") {
      const secs = parseInt(v, 10);
      if (!Number.isNaN(secs)) c.expires = new Date(Date.now() + secs * 1000).toISOString();
    }
    else if (k === "secure") c.secure = true;
    else if (k === "httponly") c.httpOnly = true;
  }
  return normalizeSeed(c, targetUrl.href);
}

const lastPostedSig = new Map(); // host -> signature of last posted snapshot

// Read cookies for a watch entry straight out of Scramjet's in-memory store.
// (The alpha's network Set-Cookie is handled internally and never persisted
// to IDB, so we snapshot from here instead of reading response headers.)
function snapshotCookiesForEntry(entry) {
  const bare = entry.split(":")[0];
  const map = scramjet?.cookieStore?.cookies || {};
  const out = [];
  for (const c of Object.values(map)) {
    if (!c || typeof c.name !== "string" || !COOKIE_NAME_OK.test(c.name)) continue;
    const d = String(c.domain || "").toLowerCase();
    if (d === bare || d === "." + bare || d.endsWith("." + bare)) out.push(c);
  }
  return out;
}

// Plausible cookie-name token; scramjet-alpha sometimes emits junk
// "undefined" name cookies through its own sync channel — never forward those.
const COOKIE_NAME_OK = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
function cleanJarCookieString(str) {
  return String(str || "")
    .split("; ")
    .filter((p) => {
      const name = p.split("=")[0].trim();
      return COOKIE_NAME_OK.test(name) && name !== "undefined";
    })
    .join("; ");
}

async function captureCookies(target) {
  if (!watchHostsCache) await getWatchHosts();
  const entry = watchEntryFor(target.hostname);
  if (!entry) return;

  const snap = snapshotCookiesForEntry(entry);
  if (!snap.length) return;

  const sig = JSON.stringify(
    snap.map((c) => `${c.domain}@${c.path}@${c.name}=${c.value}`).sort()
  );
  if (lastPostedSig.get(target.hostname) === sig) return;
  lastPostedSig.set(target.hostname, sig);

  // Persist to the IDB jar row (Scramjet-alpha only keeps these in memory)
  // so the cookies survive SW restarts, then push the snapshot to the vault.
  for (const c of snap) {
    try { await seedJar(c, target.href); } catch {}
  }
  queueVaultPost(target.hostname, snap);
}

// Busy sites (Google) rewrite cookies on nearly every response; throttle the
// vault POSTs to one flush per host per 2.5s, trailing with the newest state.
const vaultPostAt = new Map();     // host -> ts of last POST
const vaultFlushTimer = new Map(); // host -> pending timeout id
const vaultPending = new Map();    // host -> newest snapshot queued
function queueVaultPost(host, snap) {
  vaultPending.set(host, snap);
  const flush = () => {
    vaultFlushTimer.delete(host);
    const pending = vaultPending.get(host);
    if (!pending) return;
    fetch(`/api/captcha/vault/${encodeURIComponent(host)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies: pending, merge: true }),
    })
      .then(() => {
        if (vaultPending.get(host) === pending) vaultPending.delete(host);
        vaultPostAt.set(host, Date.now());
      })
      .catch(() => {});
  };
  const wait = 2500 - (Date.now() - (vaultPostAt.get(host) || 0));
  if (wait <= 0) { flush(); return; }
  if (vaultFlushTimer.has(host)) return; // trailing flush already armed
  vaultFlushTimer.set(host, setTimeout(flush, wait));
}

function decodeTarget(url, origin) {
  try {
    const raw = url.slice((origin + SCRAMJET_PREFIX).length);
    return new URL(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

async function handleProxy(event) {
  try {

    if (!scramjet) {
      scramjet = new ScramjetSWClass();
      jarHydrated = hydrateJar(scramjet);
    }
    if (jarHydrated) {
      await jarHydrated;
      jarHydrated = null;
    }

    if (!ready) {
      scramjet.config = null;
      await scramjet.loadConfig();
      if (!scramjet.config) {
        throw new Error("Configuration not available - try reloading the page");
      }
      ready = true;
    }

    if (!scramjet.route(event)) {
      return fetch(event.request);
    }

    // Vault-backed cookie injection: scramjet-alpha's outbound Cookie wiring
    // doesn't reliably attach jar cookies on the wire, so for watched hosts
    // we attach the jar's cookie string to the request ourselves. This is
    // what makes a restored (or previously captured) session actually count.
    let fetchEvent = event;
    const target = decodeTarget(event.request.url, location.origin);
    if (target) {
      try {
        if (!watchHostsCache) await getWatchHosts();
        if (watchEntryFor(target.hostname)) {
          const jarCookies = cleanJarCookieString(scramjet.cookieStore?.getCookies(target, false) || "");
          if (jarCookies) {
            const existing = event.request.headers.get("cookie") || "";
            if (!existing.includes(jarCookies)) {
              const headers = new Headers(event.request.headers);
              headers.set("cookie", existing ? `${existing}; ${jarCookies}` : jarCookies);
              fetchEvent = {
                request: new Request(event.request, { headers }),
                clientId: event.clientId,
              };
            }
          }
        }
      } catch {}
    }

    const response = await scramjet.fetch(fetchEvent);

    if (target) captureCookies(target).catch(() => {});
    if (target && ["document", "iframe"].includes(event.request.destination)) {
      detectChallenge(response, target);
    }

    return response;
  } catch (err) {
    ready = false;
    console.error("[Blossom SW]", err);

    if (["document", "iframe"].includes(event.request.destination)) {
      const safe = String(err.message)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      // The error marker id/data attribute is detected by app.js, which then
      // shows the app-level error overlay with working Retry/Home buttons.
      return new Response(
        `<!DOCTYPE html><html><body style="font-family:system-ui;background:#111;color:#eee;padding:2em;text-align:center">
        <div id="blossom-sw-error" data-detail="${safe}"></div>
        <h2>Connection Error</h2><p style="color:#f88">${safe}</p>
        <button onclick="location.reload()" style="margin:1em;padding:.5em 1.5em;cursor:pointer">Reload</button></body></html>`,
        { status: 502, headers: { "Content-Type": "text/html" } }
      );
    }
    return new Response(err.message, { status: 502 });
  }
}
