

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
  logAdminAction,
  getAdminLog,
} from "./db.js";

const router = Router();

router.use(requireAuth, requireDev);

router.get("/api/stats", (_req, res) => {
  res.json({
    totalUsers: getUserCount(),
    activeSessions: getActiveSessionCount(),
    recentSignups7d: getRecentSignups(7),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    uptime: Math.floor(process.uptime()),
  });
});

router.get("/api/users", (_req, res) => {
  res.json(getAllUsers());
});

router.get("/api/log", (_req, res) => {
  res.json(getAdminLog(100));
});

router.put("/api/users/:id/features", (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const features = req.body;
  if (!features || typeof features !== "object") {
    return res.status(400).json({ error: "Invalid features object" });
  }
  updateUserFeatures(userId, features);
  logAdminAction(req.user, "update_features", userId, JSON.stringify(features));
  res.json({ ok: true });
});

router.put("/api/users/:id/role", (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { role } = req.body || {};
  if (!role || !["user", "dev"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  const result = updateUserRole(userId, role);
  if (result.error) {
    return res.status(409).json({ error: result.error });
  }
  logAdminAction(req.user, "update_role", userId, role);
  res.json({ ok: true });
});

router.delete("/api/users/:id", (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const result = deleteUser(userId);
  if (result.error) {
    return res.status(409).json({ error: result.error });
  }
  logAdminAction(req.user, "delete_user", userId, "");
  res.json({ ok: true });
});

export { router as adminRouter };
