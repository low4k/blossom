// Blossom — Authentication routes and middleware
// Session-based auth with httpOnly cookies

import { Router } from "express";
import {
  createUser,
  authenticateUser,
  createSession,
  validateSession,
  deleteSession,
} from "./db.js";

const router = Router();
router.use(express_json());

function express_json() {
  return (req, res, next) => {
    if (req.headers["content-type"]?.includes("application/json")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          req.body = JSON.parse(body);
        } catch {
          req.body = {};
        }
        next();
      });
    } else {
      next();
    }
  };
}

const COOKIE_NAME = "_bsid"; // Innocent-looking cookie name
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// POST /auth/register
router.post("/register", (req, res) => {
  const { email, password, displayName } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  // Validate email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email format" });
  }

  // Password strength
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const result = createUser(email, password, displayName);
  if (result.error) {
    return res.status(409).json({ error: result.error });
  }

  // Auto-login after registration
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

// POST /auth/login
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

// POST /auth/logout
router.post("/logout", (req, res) => {
  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  if (token) deleteSession(token);
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

// GET /auth/me — check current session
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

// --- Auth middleware for protecting routes ---
export function requireAuth(req, res, next) {
  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  const user = validateSession(token);
  if (!user) {
    // For API routes, return 401
    if (req.path.startsWith("/auth/") || req.path.startsWith("/admin/")) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    // For page routes, redirect to login
    return res.redirect("/login");
  }
  req.user = user;
  next();
}

// --- Dev role middleware ---
export function requireDev(req, res, next) {
  if (!req.user || req.user.role !== "dev") {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

// Cookie parser (no dependency needed)
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(";").find((c) => c.trim().startsWith(name + "="));
  return match ? match.split("=")[1]?.trim() : null;
}

export { router as authRouter, COOKIE_NAME, parseCookie };
