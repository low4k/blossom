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
import {
  validateSession,
  getUserBookmarks, addUserBookmark, removeUserBookmark,
  getUserHistory, addUserHistory, clearUserHistory, updateUserHistoryTitle,
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
  next();
});

app.use(compression());

app.use(express.json({ limit: "100kb" }));

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

  const publicPaths = ["/styles.css", "/login.html", "/diag.html"];
  if (publicPaths.some((p) => req.path === p)) return next();

  if (req.path.startsWith(config.proxyPrefix) || req.path.startsWith(config.epoxyPrefix) || req.path.startsWith(config.baremuxPrefix)) {
    return next();
  }

  if (req.path === "/sw.js" || req.path.startsWith(config.scramjetPrefix)) {
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
    return res.redirect("/login");
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

app.use(express.static(publicPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

app.use((err, _req, res, _next) => {
  console.error("\x1b[31m[Error]\x1b[0m", err.stack || err.message || err);
  res.status(500).json({ error: "Internal server error" });
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
