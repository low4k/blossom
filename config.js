

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");
const rootDir = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(name) {
  try {
    const text = fs.readFileSync(path.join(rootDir, name), "utf8");
    for (const line of text.split("\n")) {
      if (!line || line.trimStart().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // missing file is fine
  }
}

if (!(process.env.DB_PATH || "").includes("qa-data")) {
  loadEnvFile(".env.local");
}

export const AI_MODELS = [
  { id: "glm-5.3-flash", label: "GLM-5.3 Flash", aliases: ["GLM-5.3-Flash"] },
  { id: "mimo-v2.5", label: "MiMo V2.5", aliases: ["MiMo-V2.5"] },
  { id: "hy3", label: "Hy3", aliases: ["Hy3", "hy3-preview"] },
  { id: "qwen3.8-flash", label: "Qwen3.8 Flash", aliases: ["Qwen3.8-Flash"] },
];

const config = {

  port: parseInt(process.env.PORT || "8080", 10),

  proxyPrefix: process.env.PROXY_PREFIX || "/assets/wasm/",
  epoxyPrefix: process.env.EPOXY_PREFIX || "/assets/net/",
  baremuxPrefix: process.env.BAREMUX_PREFIX || "/assets/worker/",
  wispPath: process.env.WISP_PATH || "/ws/",

  scramjetPrefix: process.env.SCRAMJET_PREFIX || "/~/",

  mirrors: (process.env.MIRRORS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  rateLimit: {
    windowMs: 60 * 1000,
    max: 1200,
    standardHeaders: true,
    legacyHeaders: false,
  },

  wisp: {
    allow_udp_streams: false,

    hostname_blacklist: process.env.WISP_ALLOW_PRIVATE === "1" ? [] : [
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
    // wisp-js additionally blocks private/loopback IPs outright unless these
    // flags are on; WISP_ALLOW_PRIVATE lifts both (local test targets only).
    ...(process.env.WISP_ALLOW_PRIVATE === "1"
      ? { allow_private_ips: true, allow_loopback_ips: true }
      : {}),
    dns_servers: (process.env.DNS_SERVERS || "1.1.1.3,1.0.0.3").split(",").map(s => s.trim()),
  },

  // Anti-CAPTCHA middleware.
  captcha: {
    // Hosts whose cookie sessions are vaulted + refreshed. Entries may carry a
    // port ("127.0.0.1:9000") for local testing; production entries are bare
    // hostnames matched with subdomain tolerance.
    watchHosts: (process.env.CAPTCHA_WATCH_HOSTS || "google.com,reddit.com,recaptcha.net,hcaptcha.com,challenges.cloudflare.com")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    // Server-side keep-alive pings that hold vaulted sessions warm. 0 = off.
    refreshSeconds: parseInt(process.env.CAPTCHA_REFRESH_SECONDS || "300", 10),
    // Optional HTTP CONNECT proxy for server-origin keep-alive requests
    // (e.g. a uTLS/curl-impersonate sidecar). Empty = direct egress.
    stealthProxyUrl: process.env.STEALTH_PROXY_URL || "",
    // Optional open-source solver sidecar (e.g. Camoufox/Turnstile-solver
    // style HTTP service). Disabled unless configured. Contract: POST /solve
    // {host,url,cookies} -> {cookies:[...]}; see README "Solver sidecar".
    solverUrl: process.env.SOLVER_URL || "",
    solverTimeoutMs: parseInt(process.env.SOLVER_TIMEOUT_MS || "45000", 10),
  },

  defaultCloak: {
    title: "Google",
    favicon: "https://www.google.com/favicon.ico",
  },

  defaultPanicUrl: "https://classroom.google.com",

  ai: {
    apiKey: process.env.BAI_API_KEY || "",
    baseUrl: (process.env.BAI_BASE_URL || "https://api.b.ai/v1").replace(/\/+$/, ""),
    models: AI_MODELS,
    defaultModel: AI_MODELS[0].id,
  },

  donate: {
    cashapp: process.env.DONATE_CASHAPP_URL || "",
    paypal: process.env.DONATE_PAYPAL_URL || "",
  },

  version: pkg.version,
};

export default config;
