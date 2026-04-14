// Blossom — Admin routes (dev-only)
// User management, feature toggling, system stats

import { Router } from "express";
import { requireAuth, requireDev } from "./auth.js";
import {
  getAllUsers,
  updateUserFeatures,
  updateUserRole,
  deleteUser,
  getUserCount,
  getActiveSessionCount,
  getRecentSignups,
} from "./db.js";

const router = Router();

// All admin routes require auth + dev role
router.use(requireAuth, requireDev);

// GET /admin/api/stats
router.get("/api/stats", (_req, res) => {
  res.json({
    totalUsers: getUserCount(),
    activeSessions: getActiveSessionCount(),
    recentSignups7d: getRecentSignups(7),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    uptime: Math.floor(process.uptime()),
  });
});

// GET /admin/api/users
router.get("/api/users", (_req, res) => {
  res.json(getAllUsers());
});

// PUT /admin/api/users/:id/features
router.put("/api/users/:id/features", (req, res) => {
  const userId = parseInt(req.params.id, 10);
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const features = JSON.parse(body);
      updateUserFeatures(userId, features);
      res.json({ ok: true });
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
    }
  });
});

// PUT /admin/api/users/:id/role
router.put("/api/users/:id/role", (req, res) => {
  const userId = parseInt(req.params.id, 10);
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const { role } = JSON.parse(body);
      if (!["user", "dev"].includes(role)) {
        return res.status(400).json({ error: "Invalid role" });
      }
      updateUserRole(userId, role);
      res.json({ ok: true });
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
    }
  });
});

// DELETE /admin/api/users/:id
router.delete("/api/users/:id", (req, res) => {
  const userId = parseInt(req.params.id, 10);
  deleteUser(userId);
  res.json({ ok: true });
});

export { router as adminRouter };
