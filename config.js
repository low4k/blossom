// Blossom configuration
// Change these values per deployment to avoid path-pattern blocking

const config = {
  // Port to listen on (overridden by PORT env var)
  port: parseInt(process.env.PORT || "8080", 10),

  // Randomized proxy prefix — change this per deployment
  // School filters detect /scramjet/, /uv/, /bare/ etc.
  // Use something random like /xq7r4m/ so they can't pattern-match
  proxyPrefix: process.env.PROXY_PREFIX || "/scram/",

  // Wisp endpoint path
  wispPath: process.env.WISP_PATH || "/wisp/",

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
    dns_servers: ["1.1.1.3", "1.0.0.3"],
  },

  // Tab cloaking defaults
  defaultCloak: {
    title: "Google",
    favicon: "https://www.google.com/favicon.ico",
  },

  // Default panic URL
  defaultPanicUrl: "https://classroom.google.com",

  // Build version — increment on deploys so SW knows to update
  version: "1.0.0",
};

export default config;
