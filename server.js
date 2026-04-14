import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

import config from "./config.js";
import { healthHandler } from "./health.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicPath = path.join(__dirname, "public");

// --- Wisp configuration ---
logging.set_level(logging.NONE);
Object.assign(wisp.options, config.wisp);

// --- Express app ---
const app = express();

// Security headers — COEP/COOP required for SharedArrayBuffer (bare-mux needs it)
app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

// Gzip compression for static assets
app.use(compression());

// Rate limiting per IP
app.use(rateLimit(config.rateLimit));

// --- Health endpoint ---
app.get("/health", healthHandler);

// --- Inject config into frontend ---
app.get("/blossom-config.json", (_req, res) => {
  res.json({
    proxyPrefix: config.proxyPrefix,
    wispPath: config.wispPath,
    mirrors: config.mirrors,
    version: config.version,
    defaultCloak: config.defaultCloak,
    defaultPanicUrl: config.defaultPanicUrl,
  });
});

// --- Static file serving ---
// Scramjet engine files (obfuscated prefix)
app.use(config.proxyPrefix, express.static(scramjetPath));

// Transport files
app.use("/epoxy/", express.static(epoxyPath));
app.use("/baremux/", express.static(baremuxPath));

// Frontend
app.use(express.static(publicPath));

// SPA fallback — serve index.html for unmatched routes
app.get("*", (_req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

// --- HTTP server with Wisp upgrade ---
const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.endsWith(config.wispPath)) {
    wisp.routeRequest(req, socket, head);
  } else {
    socket.end();
  }
});

const port = config.port;
server.listen(port, "0.0.0.0", () => {
  console.log(`\n  🌸 Blossom is running`);
  console.log(`     http://localhost:${port}`);
  console.log(`     Wisp endpoint: ${config.wispPath}`);
  console.log(`     Proxy prefix:  ${config.proxyPrefix}\n`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.log("\nShutting down...");
  server.close();
  process.exit(0);
}
