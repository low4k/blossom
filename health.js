// Health check endpoint — exposes server status as JSON
// No existing proxy site does this

import { performance } from "node:perf_hooks";

const startTime = Date.now();

export function healthHandler(_req, res) {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const mem = process.memoryUsage();

  res.json({
    status: "ok",
    version: process.env.npm_package_version || "1.0.0",
    uptime,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    timestamp: new Date().toISOString(),
  });
}
