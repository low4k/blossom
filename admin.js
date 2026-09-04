

import { Router } from "express";
import { requireAuth, requireDev } from "./auth.js";
import {
  getAllUsers,
  updateUserFeatures,
  updateUserRole,
  deleteUser,
  logAdminAction,
  getAdminLog,
  setTotpSecret,
  enableTotp,
  disableTotp,
  getTotpState,
  getAdminOverview,
  revokeUserSessions,
} from "./db.js";
import { generateTotpSecret, verifyTotp, otpauthUri } from "./totp.js";

const router = Router();

router.use(requireAuth, requireDev);

router.get("/api/stats", (_req, res) => {
  res.json(getAdminOverview());
});

router.get("/api/users", (_req, res) => {
  res.json(getAllUsers());
});

router.get("/api/log", (_req, res) => {
  res.json(getAdminLog(100));
});

// ---------- Two-factor auth (TOTP) for the signed-in dev ----------
router.get("/api/totp", (req, res) => {
  const state = getTotpState(req.user.id);
  res.json({ enabled: state.enabled });
});

router.post("/api/totp/setup", (req, res) => {
  if (getTotpState(req.user.id).enabled) {
    return res.status(409).json({ error: "2FA is already enabled" });
  }
  const secret = generateTotpSecret();
  setTotpSecret(req.user.id, secret);
  res.json({ secret, otpauthUri: otpauthUri(req.user.email, secret) });
});

router.post("/api/totp/enable", (req, res) => {
  const { code } = req.body || {};
  const state = getTotpState(req.user.id);
  if (state.enabled) return res.status(409).json({ error: "2FA is already enabled" });
  if (!state.secret) return res.status(400).json({ error: "Run setup first" });
  if (!verifyTotp(state.secret, code)) {
    return res.status(400).json({ error: "Invalid code — try the next one" });
  }
  enableTotp(req.user.id);
  logAdminAction(req.user, "enable_2fa", req.user.id, "");
  res.json({ ok: true });
});

router.post("/api/totp/disable", (req, res) => {
  const { code } = req.body || {};
  const state = getTotpState(req.user.id);
  if (!state.enabled) return res.status(409).json({ error: "2FA is not enabled" });
  if (!verifyTotp(state.secret, code)) {
    return res.status(400).json({ error: "Invalid code" });
  }
  disableTotp(req.user.id);
  logAdminAction(req.user, "disable_2fa", req.user.id, "");
  res.json({ ok: true });
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

router.delete("/api/users/:id/sessions", (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const result = revokeUserSessions(userId);
  if (result.error) return res.status(409).json({ error: result.error });
  logAdminAction(req.user, "revoke_sessions", userId, "");
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
