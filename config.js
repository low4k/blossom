// Blossom configuration
// Change these values per deployment to avoid path-pattern blocking

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pkg = require("./package.json");

const config = {
  // Port to listen on (overridden by PORT env var)
  port: parseInt(process.env.PORT || "8080", 10),

  // --- Path randomization ---
  // These paths serve Scramjet engine files, transport libs, and WebSocket.
  // School filters detect /scramjet/, /epoxy/, /baremux/, /wisp/ etc.
  // Use innocent-looking paths that blend with normal web app assets.
  // Override via env vars per deployment for maximum uniqueness.
  proxyPrefix: process.env.PROXY_PREFIX || "/assets/wasm/",
  epoxyPrefix: process.env.EPOXY_PREFIX || "/assets/net/",
  baremuxPrefix: process.env.BAREMUX_PREFIX || "/assets/worker/",
  wispPath: process.env.WISP_PATH || "/ws/",

  // Scramjet's internal rewrite prefix (what proxied URLs start with)
  // Default /scramjet/ is a dead giveaway. Use something innocuous.
  scramjetPrefix: process.env.SCRAMJET_PREFIX || "/~/",

  // Mirror domains for domain survival system
  // Frontend pings these and auto-redirects if current domain dies
  mirrors: [
    // Add your domains here:
    // "https://blossom-main.example.com",
    // "https://blossom-backup1.example.com",
    // "https://blossom-backup2.example.net",
  ],

  // Rate limiting
  rateLimit: {
    windowMs: 60 * 1000,       // 1 minute window
    max: 300,                   // 300 requests per window per IP
    standardHeaders: true,
    legacyHeaders: false,
  },

  // Wisp server options
  wisp: {
    allow_udp_streams: false,
    // Block loopback/private ranges from being proxied
    hostname_blacklist: [
      /^localhost$/,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^0\./,
      /^::1$/,
      /^fe80:/,
      /^\[::1\]$/,
    ],
    dns_servers: (process.env.DNS_SERVERS || "1.1.1.3,1.0.0.3").split(",").map(s => s.trim()),
  },

  // Tab cloaking defaults
  defaultCloak: {
    title: "Google",
    favicon: "https://www.google.com/favicon.ico",
  },

  // Default panic URL
  defaultPanicUrl: "https://classroom.google.com",

  // Build version — read from package.json so there's one source of truth
  version: pkg.version,
};

export default config;
