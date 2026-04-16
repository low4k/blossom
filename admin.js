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
  const features = req.body;
  if (!features || typeof features !== "object") {
    return res.status(400).json({ error: "Invalid features object" });
  }
  updateUserFeatures(userId, features);
  res.json({ ok: true });
});

// PUT /admin/api/users/:id/role
router.put("/api/users/:id/role", (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { role } = req.body || {};
  if (!role || !["user", "dev"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  updateUserRole(userId, role);
  res.json({ ok: true });
});

// DELETE /admin/api/users/:id
router.delete("/api/users/:id", (req, res) => {
  const userId = parseInt(req.params.id, 10);
  deleteUser(userId);
  res.json({ ok: true });
});

export { router as adminRouter };
