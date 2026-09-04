import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

import config from "./config.js";
import { healthHandler } from "./health.js";
import { authRouter, requireAuth, COOKIE_NAME, parseCookie } from "./auth.js";
import { adminRouter } from "./admin.js";
import { captchaRouter, initCaptchaLayer } from "./captcha.js";
import { handleAiChat, publicAiConfig, publicDonateConfig } from "./ai-proxy.js";
import {
  validateSession,
  getUserBookmarks, addUserBookmark, removeUserBookmark,
  getUserHistory, addUserHistory, clearUserHistory, updateUserHistoryTitle,
  getSaveList, getSave, putSave, deleteSave, deleteAllSaves,
} from "./db.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicPath = path.join(__dirname, "public");

logging.set_level(logging.NONE);
Object.assign(wisp.options, config.wisp);

const app = express();

// Single reverse-proxy hop in front of the app (Fly.io / Cloudflare -> Railway).
// This makes req.protocol / req.ip read X-Forwarded-*, which feeds the Secure
// cookie flag and rate limiting. Do NOT raise this number above the real hop
// count — clients could then spoof X-Forwarded-For and bypass rate limits.
app.set("trust proxy", 1);

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const color = status >= 500 ? "\x1b[31m" : status >= 400 ? "\x1b[33m" : "\x1b[32m";
    console.log(`${color}${status}\x1b[0m ${req.method} ${req.url} ${duration}ms`);
  });
  next();
});

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
}));

app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  // Permissions-Policy: block features the app doesn't use (a proxy iframe
  // loading arbitrary sites shouldn't inherit camera/mic/geolocation/etc.)
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=()");
  next();
});

app.use(compression());

app.use((req, res, next) => {
  if (req.path.startsWith("/api/saves")) return next();
  if (req.path.startsWith("/api/ai")) {
    return express.json({ limit: "1.5mb" })(req, res, next);
  }
  return express.json({ limit: "100kb" })(req, res, next);
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, try again later" },
});
app.use(rateLimit(config.rateLimit));

app.get("/health", healthHandler);

app.use("/auth", authLimiter, authRouter);

app.get("/login", (_req, res) => {
  res.sendFile(path.join(publicPath, "login.html"));
});

app.get("/donate-config.json", (_req, res) => {
  res.json(publicDonateConfig());
});

app.get(["/donate", "/donate/"], (_req, res) => {
  res.sendFile(path.join(publicPath, "donate.html"));
});

// True when the request comes from client-side fetch/XHR rather than a page
// navigation. fetch() sends sec-fetch-dest: empty; navigations send "document".
function wantsJson(req) {
  return (
    req.xhr ||
    req.headers["sec-fetch-dest"] === "empty" ||
    (req.headers.accept || "").includes("application/json")
  );
}

app.use((req, res, next) => {

  const publicPaths = ["/styles.css", "/login.html", "/donate.html", "/donate", "/donate/", "/donate-config.json", "/diag.html", "/manifest.webmanifest", "/icon.svg", "/js/petals.js", "/branch.svg"];
  if (publicPaths.some((p) => req.path === p)) return next();

  // Terminate common engine/probe paths immediately (before the auth gate) so
  // scanners get a clean 404 instead of a login redirect or SPA fallback.
  const PROBES = new Set(["/favicon.ico", "/robots.txt", "/.env", "/server.js", "/package.json", "/package-lock.json", "/.git/config", "/.htaccess"]);
  if (PROBES.has(req.path)) return res.status(404).end();

  if (req.path.startsWith(config.proxyPrefix) || req.path.startsWith(config.epoxyPrefix) || req.path.startsWith(config.baremuxPrefix)) {
    return next();
  }

  if (req.path === "/sw.js" || req.path.startsWith(config.scramjetPrefix)) {
    // Server-side proxy feature enforcement: accounts with proxy disabled may
    // not open proxied pages (document navigations). Subresources loaded inside
    // an already-authorised proxied page keep working.
    const dest = req.headers["sec-fetch-dest"];
    if (dest === "document" || dest === "iframe") {
      const token = parseCookie(req.headers.cookie, COOKIE_NAME);
      const user = validateSession(token);
      if (user && user.features?.proxy === false) {
        return res.status(403).json({ error: "Proxy access is not enabled for your account" });
      }
    }
    return next();
  }

  if (req.path === config.wispPath || req.path === config.wispPath.slice(0, -1)) {
    return next();
  }

  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  const user = validateSession(token);
  if (!user) {
    if (wantsJson(req) || req.path.startsWith("/admin/api") || req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const p = req.path.split("?")[0];
    const spa = p === "/games" || p === "/apps" || p === "/ai" || p === "/watch";
    const next = spa ? `?next=${encodeURIComponent(p === "/watch" ? p + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "") : p)}` : "";
    return res.redirect("/login" + next);
  }
  req.user = user;
  next();
});

app.use("/admin", adminRouter);

app.get("/api/bookmarks", requireAuth, (req, res) => {
  res.json(getUserBookmarks(req.user.id));
});

// Stored URLs must be plain http(s) URLs of sane length — anything else
// (javascript: URIs, oversized blobs) is rejected before hitting the DB.
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 256;
function validStoredUrl(url) {
  return typeof url === "string" && url.length > 0 && url.length <= MAX_URL_LENGTH && /^https?:\/\//i.test(url);
}
function validTitle(title) {
  return typeof title === "string" && title.length <= MAX_TITLE_LENGTH;
}

app.post("/api/bookmarks", requireAuth, (req, res) => {
  const { url, title } = req.body || {};
  if (!validStoredUrl(url)) return res.status(400).json({ error: "A valid http(s) url is required" });
  if (!validTitle(title || "")) return res.status(400).json({ error: "Title too long" });
  addUserBookmark(req.user.id, url, title || "");
  res.json({ ok: true });
});
app.delete("/api/bookmarks", requireAuth, (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string" || url.length > MAX_URL_LENGTH) return res.status(400).json({ error: "url is required" });
  removeUserBookmark(req.user.id, url);
  res.json({ ok: true });
});

app.get("/api/history", requireAuth, (req, res) => {
  res.json(getUserHistory(req.user.id));
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many AI requests, wait a moment" },
});
app.get("/api/ai/models", requireAuth, (_req, res) => {
  res.json(publicAiConfig());
});
app.post("/api/ai/chat", requireAuth, aiLimiter, handleAiChat);

// Anti-CAPTCHA vault + visibility endpoints
app.use("/api/captcha", requireAuth, captchaRouter);

// Per-account game/app save slots
const SAVE_ID_RE = /^[a-z0-9][a-z0-9-_.]{0,63}$/;
const MAX_SAVE_BYTES = 5 * 1024 * 1024;

app.get("/api/saves", requireAuth, (req, res) => {
  res.json({ saves: getSaveList(req.user.id) });
});

app.get("/api/saves/:id", requireAuth, (req, res) => {
  const row = getSave(req.user.id, req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json({ id: req.params.id, data: JSON.parse(row.data), updatedAt: row.updatedAt });
});

app.put("/api/saves/:id", requireAuth, express.json({ limit: MAX_SAVE_BYTES }), (req, res) => {
  if (!SAVE_ID_RE.test(String(req.params.id))) return res.status(400).json({ error: "Invalid save id" });
  const body = req.body && typeof req.body === "object" ? req.body : null;
  const payload = body && body.data !== undefined && !("local" in body) ? body.data : body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return res.status(400).json({ error: "Invalid data" });
  }
  let json;
  try { json = JSON.stringify(payload); } catch { return res.status(400).json({ error: "Invalid data" }); }
  if (!json || json.length > MAX_SAVE_BYTES) return res.status(413).json({ error: "Save too large" });
  putSave(req.user.id, req.params.id, json);
  res.json({ ok: true, bytes: json.length });
});

app.delete("/api/saves", requireAuth, (req, res) => {
  deleteAllSaves(req.user.id);
  res.json({ ok: true });
});

app.delete("/api/saves/:id", requireAuth, (req, res) => {
  deleteSave(req.user.id, req.params.id);
  res.json({ ok: true });
});
app.post("/api/history", requireAuth, (req, res) => {
  const { url, title } = req.body || {};
  if (!validStoredUrl(url)) return res.status(400).json({ error: "A valid http(s) url is required" });
  if (!validTitle(title || "")) return res.status(400).json({ error: "Title too long" });
  addUserHistory(req.user.id, url, title || "");
  res.json({ ok: true });
});
app.delete("/api/history", requireAuth, (_req, res) => {
  clearUserHistory(_req.user.id);
  res.json({ ok: true });
});
app.patch("/api/history", requireAuth, (req, res) => {
  const { url, title } = req.body || {};
  if (!validStoredUrl(url)) return res.status(400).json({ error: "A valid http(s) url is required" });
  if (!validTitle(title) || !title) return res.status(400).json({ error: "title is required" });
  updateUserHistoryTitle(req.user.id, url, title);
  res.json({ ok: true });
});

app.get(["/admin", "/admin/"], (req, res) => {
  if (req.user?.role !== "dev") return res.redirect("/");
  res.sendFile(path.join(publicPath, "admin.html"));
});

app.get("/blossom-config.json", (req, res) => {
  res.json({
    proxyPrefix: config.proxyPrefix,
    epoxyPrefix: config.epoxyPrefix,
    baremuxPrefix: config.baremuxPrefix,
    wispPath: config.wispPath,
    scramjetPrefix: config.scramjetPrefix,
    mirrors: config.mirrors,
    version: config.version,
    defaultCloak: config.defaultCloak,
    defaultPanicUrl: config.defaultPanicUrl,
    captchaWatchHosts: config.captcha.watchHosts,
    ai: publicAiConfig(),
    donate: publicDonateConfig(),
    user: req.user ? {
      id: req.user.id,
      displayName: req.user.displayName,
      role: req.user.role,
      features: req.user.features,
    } : null,
  });
});

app.use(config.proxyPrefix, express.static(scramjetPath, {
  maxAge: "1d",
  setHeaders: (res) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }
}));

app.use(config.epoxyPrefix, express.static(epoxyPath, {
  maxAge: "1d",
  setHeaders: (res) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }
}));
app.use(config.baremuxPrefix, express.static(baremuxPath, {
  maxAge: "1d",
  setHeaders: (res) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }
}));

// SPA shells must win over the public/games/ directory so /games is the
// catalog, while /games/snake.html still serves the local game file.
app.get(["/games", "/games/", "/apps", "/apps/", "/ai", "/ai/", "/watch", "/watch/"], (_req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

app.use(express.static(publicPath));

// Unknown /api/* and /admin/api/* routes: 404 JSON, not the index.html SPA
// fallback. Keeps API consumers (and API crawlers) from getting HTML back.
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use("/admin/api", (_req, res) => res.status(404).json({ error: "Not found" }));

app.get("*", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

app.use((err, req, res, _next) => {
  console.error("\x1b[31m[Error]\x1b[0m", err.stack || err.message || err);
  // Don't leak stack traces to clients in production.
  const wantsJson = req.headers.accept?.includes("application/json") || req.path.startsWith("/api/") || req.path.startsWith("/admin/api");
  if (wantsJson) {
    return res.status(500).json({ error: "Internal server error" });
  }
  res.status(500).send(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Something went wrong</title>
    <style>
      body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d0d0f;color:#e8e8ed;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px;text-align:center}
      .box{max-width:420px}
      h1{font-size:28px;margin:0 0 8px}
      p{color:#8888a0;line-height:1.5;margin:0 0 24px}
      a{display:inline-block;background:#e8a0bf;color:#1a1020;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:10px}
    </style></head>
    <body><div class="box"><h1>500</h1><p>Something went wrong on our end. Please try again.</p><a href="/">Go Home</a></div></body></html>`
  );
});

const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
  console.log(`[WS Upgrade] ${req.url}`);
  if (req.url && req.url.endsWith(config.wispPath)) {
    wisp.routeRequest(req, socket, head);
  } else {
    console.log(`[WS Upgrade] Rejected - no match for ${config.wispPath}`);
    socket.end();
  }
});

const port = config.port;
server.listen(port, "0.0.0.0", () => {
  initCaptchaLayer();
  console.log(`\n  Blossom is running`);
  console.log(`     http://localhost:${port}`);
  console.log(`     Wisp endpoint:    ${config.wispPath}`);
  console.log(`     Proxy prefix:     ${config.proxyPrefix}`);
  console.log(`     Epoxy prefix:     ${config.epoxyPrefix}`);
  console.log(`     BareMux prefix:   ${config.baremuxPrefix}`);
  console.log(`     Scramjet prefix:  ${config.scramjetPrefix}\n`);
});

server.on("error", (err) => {
  console.error("\x1b[31m[Server Error]\x1b[0m", err);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.log("\nShutting down...");
  server.close();
  process.exit(0);
}
