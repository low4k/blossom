

import { Router } from "express";
import {
  createUser,
  authenticateUser,
  createSession,
  validateSession,
  deleteSession,
} from "./db.js";

const router = Router();

const COOKIE_NAME = "_bsid";
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

router.post("/register", (req, res) => {
  const { email, password, displayName } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email format" });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const result = createUser(email, password, displayName);
  if (result.error) {
    return res.status(409).json({ error: result.error });
  }

  const user = authenticateUser(email, password);
  const session = createSession(user.id);

  const secure = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
  res.cookie(COOKIE_NAME, session.token, { ...COOKIE_OPTS, secure });

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      features: user.features,
    },
  });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const user = authenticateUser(email, password);
  if (!user) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const session = createSession(user.id);
  const secure = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
  res.cookie(COOKIE_NAME, session.token, { ...COOKIE_OPTS, secure });

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      features: user.features,
    },
  });
});

router.post("/logout", (req, res) => {
  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  if (token) deleteSession(token);
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  const user = validateSession(token);
  if (!user) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      features: user.features,
    },
  });
});

export function requireAuth(req, res, next) {
  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  const user = validateSession(token);
  if (!user) {

    if (req.path.startsWith("/auth/") || req.path.startsWith("/admin/")) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    return res.redirect("/login");
  }
  req.user = user;
  next();
}

export function requireDev(req, res, next) {
  if (!req.user || req.user.role !== "dev") {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(";").find((c) => c.trim().startsWith(name + "="));
  return match ? match.split("=")[1]?.trim() : null;
}

export { router as authRouter, COOKIE_NAME, parseCookie };
