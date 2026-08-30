

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

// Registration gating (set via env):
//   REGISTRATION=closed  -> disable self-registration entirely
//   INVITE_CODE=secret   -> require this code to register
const REGISTRATION_CLOSED = ["0", "false", "closed", "off"].includes(
  (process.env.REGISTRATION || "").toLowerCase()
);
const INVITE_CODE = process.env.INVITE_CODE || "";

router.post("/register", (req, res) => {
  if (REGISTRATION_CLOSED) {
    return res.status(403).json({ error: "Registration is disabled" });
  }
  if (INVITE_CODE && req.body?.inviteCode !== INVITE_CODE) {
    return res.status(403).json({ error: "Invalid invite code" });
  }

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

// 200-always variant used by client pages (e.g. the login page) to avoid
// noisy 401 console errors on every logged-out page load.
router.get("/status", (req, res) => {
  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  const user = validateSession(token);
  res.json({
    authenticated: !!user,
    user: user ? {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      features: user.features,
    } : null,
  });
});

export function requireAuth(req, res, next) {
  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  const user = validateSession(token);
  if (!user) {
    // XHR/fetch callers get a 401 so they can handle expiry explicitly
    // instead of transparently following a redirect to the login HTML page.
    const isXhr =
      req.xhr ||
      req.headers["sec-fetch-dest"] === "empty" ||
      (req.headers.accept || "").includes("application/json");
    if (isXhr || req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    return res.redirect("/login");
  }
  req.user = user;
  next();
}

export function requireDev(req, res, next) {
  if (!req.user || req.user.role !== "dev") {
    // Browser navigations to /admin get redirected home; API/fetch callers
    // get a machine-readable 403.
    const isXhr =
      req.xhr ||
      req.headers["sec-fetch-dest"] === "empty" ||
      (req.headers.accept || "").includes("application/json");
    if (!isXhr) return res.redirect("/");
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
