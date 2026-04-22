

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pkg = require("./package.json");

const config = {

  port: parseInt(process.env.PORT || "8080", 10),

  proxyPrefix: process.env.PROXY_PREFIX || "/assets/wasm/",
  epoxyPrefix: process.env.EPOXY_PREFIX || "/assets/net/",
  baremuxPrefix: process.env.BAREMUX_PREFIX || "/assets/worker/",
  wispPath: process.env.WISP_PATH || "/ws/",

  scramjetPrefix: process.env.SCRAMJET_PREFIX || "/~/",

  mirrors: [

  ],

  rateLimit: {
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  },

  wisp: {
    allow_udp_streams: false,

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

  defaultCloak: {
    title: "Google",
    favicon: "https://www.google.com/favicon.ico",
  },

  defaultPanicUrl: "https://classroom.google.com",

  version: pkg.version,
};

export default config;
