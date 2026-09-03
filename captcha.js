// Anti-CAPTCHA middleware (Phase 1: session vault + keep-alive + challenge
// visibility; Phase 2/3 plumbing: optional CONNECT stealth proxy for
// server-origin keep-alive, optional solver sidecar hook).
//
// Architecture note: proxied browsing traffic terminates TLS in the user's
// browser (Epoxy/libcurl.wasm over Wisp). Server-side changes here affect
// only server-origin requests (the keep-alive refresher and solver calls).
// The browser-facing win comes from the cookie vault: cookies captured from
// the Scramjet jar are persisted server-side per user and re-seeded into the
// SW jar after IDB purges / new devices, so a solved CAPTCHA stays solved.

import express from "express";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import config from "./config.js";
import {
  saveVaultCookies,
  getVaultCookies,
  getVaultHosts,
  getUserVaultCookies,
  deleteVaultCookies,
  clearUserVault,
  getRecentVaultRows,
  recordCaptchaEvent,
  getCaptchaEventStats,
} from "./db.js";

// ---------------------------------------------------------------------------
// Watch-host classification
// ---------------------------------------------------------------------------

function kindFor(entry) {
  const bare = entry.split(":")[0];
  if (bare.includes("google")) return "google";
  if (bare.includes("reddit")) return "reddit";
  if (bare.includes("recaptcha")) return "recaptcha";
  if (bare.includes("hcaptcha")) return "hcaptcha";
  if (bare.includes("cloudflare")) return "cloudflare";
  return "generic";
}

// A watch entry is either a bare hostname (subdomain-tolerant) or "h:port"
// (exact host:port, for local testing; also matches the bare hostname so
// vault keys stay port-free). Returns { entry, kind } | null.
export function classifyHost(rawHost) {
  const h = String(rawHost || "").toLowerCase().trim();
  if (!h) return null;
  for (const entry of config.captcha.watchHosts) {
    if (entry.includes(":")) {
      if (h === entry || h === entry.split(":")[0]) return { entry, kind: kindFor(entry) };
      continue;
    }
    if (h === entry || h.endsWith("." + entry)) return { entry, kind: kindFor(entry) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cookie snapshot validation (Scramjet CookieStore dump entries)
// ---------------------------------------------------------------------------

const MAX_COOKIES_PER_HOST = 100;
const MAX_VAULT_JSON = 24 * 1024;

function sanitizeCookieSnapshot(input) {
  if (!Array.isArray(input) || input.length > MAX_COOKIES_PER_HOST) return null;
  const out = [];
  for (const c of input) {
    if (!c || typeof c !== "object") return null;
    if (typeof c.name !== "string" || !c.name || c.name.length > 128) return null;
    if (typeof c.value !== "string" || c.value.length > 4096) return null;
    const clean = { name: c.name, value: c.value };
    if (typeof c.domain === "string" && c.domain.length <= 255) clean.domain = c.domain;
    if (typeof c.path === "string" && c.path.length <= 255) clean.path = c.path;
    if (typeof c.sameSite === "string") clean.sameSite = c.sameSite;
    if (typeof c.expires === "string" || typeof c.expires === "number") clean.expires = String(c.expires);
    if (c.secure === true) clean.secure = true;
    if (c.httpOnly === true) clean.httpOnly = true;
    out.push(clean);
  }
  const json = JSON.stringify(out);
  if (json.length > MAX_VAULT_JSON) return null;
  return json;
}

// Drop expired cookies (scramjet stores expires as a Date string).
export function liveCookies(cookies) {
  const now = Date.now();
  return cookies.filter((c) => {
    if (!c.expires) return true;
    const t = Date.parse(c.expires);
    return Number.isNaN(t) || t > now;
  });
}

function cookieHeader(cookies) {
  return liveCookies(cookies).map((c) => `${c.name}=${c.value}`).join("; ");
}

// ---------------------------------------------------------------------------
// Keep-alive probes (server-origin requests; optional CONNECT stealth proxy)
// ---------------------------------------------------------------------------

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function probeUrlFor(entry, kind) {
  if (entry.includes(":") || /^(127\.|localhost|\[?::1)/.test(entry)) {
    return `http://${entry}/`; // local test target
  }
  if (kind === "google") return "https://www.google.com/generate_204";
  return `https://${entry}/robots.txt`;
}

function directGet(url, { cookie, timeoutMs }) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        headers: { "user-agent": CHROME_UA, cookie, accept: "*/*" },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve({ ok: res.statusCode < 500, status: res.statusCode });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.on("error", () => resolve({ ok: false, status: 0 }));
    req.end();
  });
}

// Minimal HTTP CONNECT client: reaches the target through a proxy that owns
// the TLS handshake (a uTLS/curl-impersonate sidecar exposing CONNECT).
function proxyConnectGet(url, proxyUrlRaw, { cookie, timeoutMs }) {
  return new Promise((resolve) => {
    let target, proxy;
    try { target = new URL(url); proxy = new URL(proxyUrlRaw); }
    catch { return resolve({ ok: false, status: 0 }); }

    const done = (r) => { try { sock.destroy(); } catch {} resolve(r); };
    const sock = net.connect(Number(proxy.port || 8080), proxy.hostname);
    const timer = setTimeout(() => done({ ok: false, status: 0 }), timeoutMs);
    sock.on("error", () => done({ ok: false, status: 0 }));

    let stage = "connect";
    let buf = Buffer.alloc(0);
    sock.on("connect", () => {
      const tport = target.port || 443;
      sock.write(
        `CONNECT ${target.hostname}:${tport} HTTP/1.1\r\n` +
        `Host: ${target.hostname}:${tport}\r\n` +
        `Proxy-Connection: keep-alive\r\n\r\n`
      );
    });

    sock.on("data", (chunk) => {
      if (stage !== "connect") return;
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      const statusLine = buf.slice(0, buf.indexOf("\r\n")).toString("latin1");
      if (!/\b200\b/.test(statusLine)) return done({ ok: false, status: 0 });
      stage = "tls";
      const tsock = tls.connect(
        { socket: sock, servername: target.hostname },
        () => {
          tsock.write(
            `GET ${(target.pathname || "/") + target.search} HTTP/1.1\r\n` +
            `Host: ${target.host}\r\n` +
            `User-Agent: ${CHROME_UA}\r\n` +
            `Accept: */*\r\n` +
            (cookie ? `Cookie: ${cookie}\r\n` : "") +
            `Connection: close\r\n\r\n`
          );
        }
      );
      let rbuf = Buffer.alloc(0);
      tsock.on("data", (ch) => {
        rbuf = Buffer.concat([rbuf, ch]);
        const nl = rbuf.indexOf("\r\n");
        if (nl === -1) return;
        const line = rbuf.slice(0, nl).toString("latin1");
        const m = line.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
        clearTimeout(timer);
        if (!m) { tsock.destroy(); return done({ ok: false, status: 0 }); }
        const status = Number(m[1]);
        tsock.destroy();
        done({ ok: status < 500, status });
      });
      tsock.on("error", () => done({ ok: false, status: 0 }));
    });
  });
}

function probeGet(url, opts) {
  if (config.captcha.stealthProxyUrl) {
    return proxyConnectGet(url, config.captcha.stealthProxyUrl, opts);
  }
  return directGet(url, opts);
}

// ---------------------------------------------------------------------------
// Circuit breakers (per host entry) + keep-alive scheduler
// ---------------------------------------------------------------------------

const BREAKER_FAILS = 3;
const BREAKER_OPEN_MS = 15 * 60 * 1000;

const breakers = new Map(); // entry -> { fails, openUntil }

function breakerAllows(entry) {
  const b = breakers.get(entry);
  return !b || !b.openUntil || Date.now() > b.openUntil;
}
function breakerReport(entry, ok) {
  const b = breakers.get(entry) || { fails: 0, openUntil: 0 };
  if (ok) { b.fails = 0; b.openUntil = 0; }
  else {
    b.fails += 1;
    if (b.fails >= BREAKER_FAILS) {
      b.openUntil = Date.now() + BREAKER_OPEN_MS;
      b.fails = 0;
    }
  }
  breakers.set(entry, b);
}

export async function runKeepAliveOnce() {
  const rows = getRecentVaultRows(24 * 60 * 60);
  const results = [];
  for (const row of rows) {
    const cls = classifyHost(row.host);
    if (!cls) continue;
    if (!breakerAllows(cls.entry)) { results.push({ host: row.host, skipped: "breaker-open" }); continue; }
    let cookies;
    try { cookies = JSON.parse(row.cookies); } catch { continue; }
    const header = cookieHeader(cookies);
    if (!header) { results.push({ host: row.host, skipped: "empty" }); continue; }
    const url = probeUrlFor(cls.entry, cls.kind);
    const r = await probeGet(url, { cookie: header, timeoutMs: 9000 });
    breakerReport(cls.entry, r.ok);
    results.push({ host: row.host, status: r.status, ok: r.ok });
  }
  return results;
}

let keepAliveTimer = null;

export function initCaptchaLayer() {
  if (config.captcha.refreshSeconds > 0) {
    const tick = () => {
      runKeepAliveOnce().catch(() => {});
    };
    keepAliveTimer = setInterval(tick, config.captcha.refreshSeconds * 1000);
    keepAliveTimer.unref();
    // first run is deliberately delayed so boot tests stay quiet
    const first = setTimeout(tick, Math.min(30000, config.captcha.refreshSeconds * 1000));
    first.unref();
  }
  console.log(
    `[captcha] vault active for ${config.captcha.watchHosts.length} watch hosts; ` +
    `keep-alive ${config.captcha.refreshSeconds > 0 ? `every ${config.captcha.refreshSeconds}s` : "off"}; ` +
    `stealth proxy ${config.captcha.stealthProxyUrl ? "configured" : "off"}; ` +
    `solver ${config.captcha.solverUrl ? "configured" : "off"}`
  );
}

// ---------------------------------------------------------------------------
// Optional solver sidecar (Phase 3): POST {SOLVER_URL}/solve with
// { host, url, cookies } -> { cookies: [...] }. Disabled unless configured.
// ---------------------------------------------------------------------------

const solverInflight = new Set(); // `${userId}:${host}`
const solverBreakers = new Map(); // host -> { fails, openUntil }

export async function requestSolverSolve(userId, hostEntry, url) {
  if (!config.captcha.solverUrl) return { status: "disabled" };
  const key = `${userId}:${hostEntry}`;
  if (solverInflight.has(key)) return { status: "busy" };
  const b = solverBreakers.get(hostEntry);
  if (b && b.openUntil && Date.now() < b.openUntil) return { status: "cooldown" };

  const vault = getVaultCookies(userId, hostEntry);
  let cookies = [];
  try { cookies = vault ? JSON.parse(vault.cookies) : []; } catch {}
  // vault cookies are keyed by entry; the entry here is what classify matched
  if (!vault && hostEntry !== undefined) {
    const alt = getUserVaultCookies(userId);
    for (const h of Object.keys(alt)) {
      if (classifyHost(h)?.entry === hostEntry) { cookies = alt[h]; break; }
    }
  }

  solverInflight.add(key);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), config.captcha.solverTimeoutMs);
    const res = await fetch(new URL("/solve", config.captcha.solverUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: hostEntry, url: url || null, cookies }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    const data = res.ok ? await res.json() : null;
    const clean = data && data.cookies ? sanitizeCookieSnapshot(data.cookies) : null;
    if (clean === null) {
      const b2 = solverBreakers.get(hostEntry) || { fails: 0, openUntil: 0 };
      b2.fails += 1;
      if (b2.fails >= BREAKER_FAILS) { b2.openUntil = Date.now() + 10 * 60 * 1000; b2.fails = 0; }
      solverBreakers.set(hostEntry, b2);
      return { status: "failed" };
    }
    solverBreakers.delete(hostEntry);
    saveVaultCookies(userId, hostEntry, clean);
    return { status: "solved", count: JSON.parse(clean).length };
  } catch {
    return { status: "failed" };
  } finally {
    solverInflight.delete(key);
  }
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

export const captchaRouter = express.Router();

captchaRouter.get("/vault", (req, res) => {
  const all = getUserVaultCookies(req.user.id, null);
  const hosts = {};
  for (const [host, cookies] of Object.entries(all)) {
    if (!classifyHost(host)) continue; // only watch-listed vaults are served
    hosts[host] = liveCookies(cookies);
  }
  res.json({ hosts });
});

captchaRouter.put("/vault/:host", (req, res) => {
  const host = String(req.params.host || "").toLowerCase();
  const cls = classifyHost(host);
  if (!cls) return res.status(400).json({ error: "Host is not on the watch list" });

  // merge:true merges the incoming delta into the stored snapshot (used by
  // the SW's per-response capture); a plain PUT replaces the host snapshot
  // (used by the page's full-jar sync).
  let incoming = req.body?.cookies;
  if (req.body?.merge === true) {
    const row = getVaultCookies(req.user.id, host);
    let existing = [];
    if (row) { try { existing = JSON.parse(row.cookies); } catch {} }
    const map = new Map();
    const key = (c) => `${c.domain || "." + host}@${c.path || "/"}@${c.name}`;
    for (const c of existing) if (c && c.name) map.set(key(c), c);
    if (Array.isArray(incoming)) for (const c of incoming) if (c && c.name) map.set(key(c), c);
    incoming = [...map.values()];
  }

  const clean = sanitizeCookieSnapshot(incoming);
  if (clean === null) return res.status(400).json({ error: "Invalid cookies payload" });
  // Vault keys by the concrete hostname the client saw so restores line up
  // with the exact site, while keep-alive/breakers key off the watch entry.
  saveVaultCookies(req.user.id, host, clean);
  res.json({ ok: true, count: JSON.parse(clean).length });
});

captchaRouter.delete("/vault/:host", (req, res) => {
  deleteVaultCookies(req.user.id, String(req.params.host || "").toLowerCase());
  res.json({ ok: true });
});

captchaRouter.delete("/vault", (req, res) => {
  clearUserVault(req.user.id);
  res.json({ ok: true });
});

captchaRouter.post("/event", (req, res) => {
  const host = String(req.body?.host || "").toLowerCase().slice(0, 255);
  const kind = String(req.body?.kind || "unknown").slice(0, 32);
  const url = typeof req.body?.url === "string" ? req.body.url.slice(0, 2048) : null;
  recordCaptchaEvent(req.user.id, host, kind);
  if (req.query?.solve === "1" && config.captcha.solverUrl) {
    requestSolverSolve(req.user.id, host, url).catch(() => {});
    return res.json({ ok: true, solver: "started" });
  }
  res.json({ ok: true, solver: config.captcha.solverUrl ? "idle" : "disabled" });
});

captchaRouter.get("/status", (req, res) => {
  const hosts = getVaultHosts(req.user.id);
  const events = getCaptchaEventStats(req.user.id);
  res.json({
    watchHosts: config.captcha.watchHosts.length,
    keepAliveSeconds: config.captcha.refreshSeconds,
    stealthProxy: !!config.captcha.stealthProxyUrl,
    solver: !!config.captcha.solverUrl,
    hosts,
    events,
  });
});
