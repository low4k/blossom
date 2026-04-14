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
import { validateSession } from "./db.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicPath = path.join(__dirname, "public");

// --- Wisp configuration ---
logging.set_level(logging.NONE);
Object.assign(wisp.options, config.wisp);

// --- Express app ---
const app = express();

// Trust Cloudflare / Railway proxy for correct client IP in rate limiter & logs
app.set("trust proxy", 1);

// Request logging middleware
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

// Security headers via helmet (disabling some that conflict with proxy operation)
app.use(helmet({
  contentSecurityPolicy: false,     // CSP breaks proxied content
  crossOriginEmbedderPolicy: false, // We set COEP manually below
  crossOriginOpenerPolicy: false,   // We set COOP manually below
  crossOriginResourcePolicy: false, // Must allow cross-origin for proxy
}));

// COEP/COOP required for SharedArrayBuffer (bare-mux needs it)
// Use "credentialless" COEP — less restrictive than "require-corp" and allows
// cross-origin no-CORS requests (just strips credentials). This avoids blocking
// external images/resources while still enabling SharedArrayBuffer.
// Supported in Chrome 96+, Firefox 119+, Safari 17.2+.
app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  next();
});

// Gzip compression for static assets
app.use(compression());

// Rate limiting per IP
app.use(rateLimit(config.rateLimit));

// --- Health endpoint ---
app.get("/health", healthHandler);

// --- Auth routes (no auth required for these) ---
app.use("/auth", authRouter);

// --- Login page (accessible without auth) ---
app.get("/login", (_req, res) => {
  res.sendFile(path.join(publicPath, "login.html"));
});

// --- Auth middleware: everything below requires login ---
app.use((req, res, next) => {
  // Allow unauthenticated access to static assets needed by login page
  const publicPaths = ["/styles.css", "/login.html"];
  if (publicPaths.some((p) => req.path === p)) return next();

  // Allow scramjet/epoxy/baremux static assets (needed by SW after auth)
  if (req.path.startsWith(config.proxyPrefix) || req.path.startsWith(config.epoxyPrefix) || req.path.startsWith(config.baremuxPrefix)) {
    return next();
  }

  // Allow service worker and its scope (scramjetPrefix is the rewrite prefix for proxied URLs)
  if (req.path === "/sw.js" || req.path.startsWith(config.scramjetPrefix)) {
    return next();
  }

  // Allow WebSocket upgrade path (some reverse proxies send it as regular HTTP first)
  if (req.path === config.wispPath || req.path === config.wispPath.slice(0, -1)) {
    return next();
  }

  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  const user = validateSession(token);
  if (!user) {
    // API requests get 401, page requests get redirected
    if (req.headers.accept?.includes("application/json") || req.path.startsWith("/admin/api")) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    return res.redirect("/login");
  }
  req.user = user;
  next();
});

// --- Admin routes (requires dev role) ---
app.use("/admin", adminRouter);

// --- Admin page ---
app.get("/admin", (req, res) => {
  if (req.user?.role !== "dev") return res.redirect("/");
  res.sendFile(path.join(publicPath, "admin.html"));
});

// --- Inject config into frontend ---
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

// --- Static file serving ---
// Scramjet engine files
app.use(config.proxyPrefix, express.static(scramjetPath, {
  setHeaders: (res) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }
}));

// Transport files
app.use(config.epoxyPrefix, express.static(epoxyPath, {
  setHeaders: (res) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }
}));
app.use(config.baremuxPrefix, express.static(baremuxPath, {
  setHeaders: (res) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }
}));

// Frontend
app.use(express.static(publicPath));

// SPA fallback — serve index.html for unmatched routes (auth already checked above)
app.get("*", (req, res) => {
  // Admin page
  if (req.path === "/admin" || req.path === "/admin/") {
    if (req.user?.role !== "dev") return res.redirect("/");
    return res.sendFile(path.join(publicPath, "admin.html"));
  }
  res.sendFile(path.join(publicPath, "index.html"));
});

// Error handling middleware
app.use((err, _req, res, _next) => {
  console.error("\x1b[31m[Error]\x1b[0m", err.stack || err.message || err);
  res.status(500).json({ error: "Internal server error" });
});

// --- HTTP server with Wisp upgrade ---
const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
  console.log(`[WS Upgrade] ${req.url}`);
  if (req.url && req.url.endsWith(config.wispPath)) {
    wisp.routeRequest(req, socket, head);
  } else {
    console.log(`[WS Upgrade] Rejected — no match for ${config.wispPath}`);
    socket.end();
  }
});

const port = config.port;
server.listen(port, "0.0.0.0", () => {
  console.log(`\n  🌸 Blossom is running`);
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
