

import Database from "better-sqlite3";
import { hashSync, compareSync } from "bcryptjs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Allow overriding the DB location (e.g. a mounted volume in production, or an
// isolated file for tests). Directory is created if missing.
const dbPath = process.env.DB_PATH || path.join(dataDir, "blossom.db");
if (dbPath !== path.join(dataDir, "blossom.db")) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    features TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_login INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(user_id, url)
  );

  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    visited_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
  CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id);

  CREATE TABLE IF NOT EXISTS admin_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    actor_email TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    target_id INTEGER,
    details TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

const DEFAULT_FEATURES = {
  proxy: true,
  games: true,
  bookmarks: true,
  settings: true,
};

// Dev account is only seeded when DEV_EMAIL and DEV_PASS are explicitly provided
// (e.g. via environment secrets on the host). No hardcoded fallbacks.
const DEV_EMAIL = process.env.DEV_EMAIL;
const DEV_PASS = process.env.DEV_PASS;

if (DEV_EMAIL && DEV_PASS) {
  const existingDev = db.prepare("SELECT id FROM users WHERE email = ?").get(DEV_EMAIL);
  if (!existingDev) {
    db.prepare(
      "INSERT INTO users (email, display_name, password_hash, role, features) VALUES (?, ?, ?, ?, ?)"
    ).run(
      DEV_EMAIL,
      "Developer",
      hashSync(DEV_PASS, 10),
      "dev",
      JSON.stringify({ proxy: true, games: true, bookmarks: true, settings: true, admin: true })
    );
    console.log("[DB] Dev account seeded");
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function cleanExpiredSessions() {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
}
setInterval(cleanExpiredSessions, 10 * 60 * 1000);
cleanExpiredSessions();

export function createUser(email, password, displayName) {
  const hash = hashSync(password, 10);
  const features = JSON.stringify(DEFAULT_FEATURES);
  try {
    const result = db.prepare(
      "INSERT INTO users (email, display_name, password_hash, features) VALUES (?, ?, ?, ?)"
    ).run(email, displayName || email.split("@")[0], hash, features);
    return { id: result.lastInsertRowid };
  } catch (err) {
    if (err.message.includes("UNIQUE constraint")) {
      return { error: "Email already registered" };
    }
    throw err;
  }
}

export function authenticateUser(email, password) {
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return null;
  if (!compareSync(password, user.password_hash)) return null;

  db.prepare("UPDATE users SET last_login = unixepoch() WHERE id = ?").run(user.id);

  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    features: JSON.parse(user.features),
  };
}

export function getUserById(id) {
  const user = db.prepare("SELECT id, email, display_name, role, features, created_at, last_login FROM users WHERE id = ?").get(id);
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    features: JSON.parse(user.features),
    createdAt: user.created_at,
    lastLogin: user.last_login,
  };
}

const SESSION_TTL = 7 * 24 * 60 * 60;

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL;
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    hashToken(token), userId, now, expiresAt
  );
  return { token, expiresAt };
}

export function validateSession(token) {
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const session = db.prepare(
    "SELECT s.user_id, u.id, u.email, u.display_name, u.role, u.features FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ?"
  ).get(hashToken(token), now);
  if (!session) return null;
  return {
    id: session.id,
    email: session.email,
    displayName: session.display_name,
    role: session.role,
    features: JSON.parse(session.features),
  };
}

export function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(hashToken(token));
}

export function deleteUserSessions(userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function getAllUsers() {
  const users = db.prepare(
    "SELECT id, email, display_name, role, features, created_at, last_login FROM users ORDER BY created_at DESC"
  ).all();
  return users.map((u) => ({
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    features: JSON.parse(u.features),
    createdAt: u.created_at,
    lastLogin: u.last_login,
  }));
}

export function updateUserFeatures(userId, features) {
  db.prepare("UPDATE users SET features = ? WHERE id = ?").run(JSON.stringify(features), userId);
}

export function updateUserRole(userId, role) {
  const target = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
  if (!target) return { error: "User not found" };
  // Prevent demoting the last remaining dev account (self-lockout guard)
  if (target.role === "dev" && role !== "dev") {
    const devCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'dev'").get().count;
    if (devCount <= 1) return { error: "Cannot demote the last dev account" };
  }
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
  return { ok: true };
}

export function logAdminAction(actor, action, targetId, details) {
  db.prepare(
    "INSERT INTO admin_log (actor_id, actor_email, action, target_id, details) VALUES (?, ?, ?, ?, ?)"
  ).run(actor?.id || null, actor?.email || "", action, targetId ?? null, details || "");
}

export function getAdminLog(limit = 100) {
  return db.prepare(
    "SELECT actor_email, action, target_id, details, created_at FROM admin_log ORDER BY created_at DESC, id DESC LIMIT ?"
  ).all(limit);
}

export function deleteUser(userId) {
  const target = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
  if (!target) return { error: "User not found" };
  if (target.role === "dev") {
    // Never delete or revoke sessions for dev accounts.
    return { error: "Cannot delete a dev account" };
  }
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  return { ok: true };
}

export function getUserCount() {
  return db.prepare("SELECT COUNT(*) as count FROM users").get().count;
}

export function getActiveSessionCount() {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare("SELECT COUNT(DISTINCT user_id) as count FROM sessions WHERE expires_at > ?").get(now).count;
}

export function getRecentSignups(days = 7) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  return db.prepare("SELECT COUNT(*) as count FROM users WHERE created_at > ?").get(since).count;
}

export function getUserBookmarks(userId) {
  return db.prepare(
    "SELECT url, title, created_at FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC"
  ).all(userId);
}

export function addUserBookmark(userId, url, title) {
  try {
    db.prepare(
      "INSERT INTO bookmarks (user_id, url, title) VALUES (?, ?, ?)"
    ).run(userId, url, title || "");
    return { ok: true };
  } catch (err) {
    if (err.message.includes("UNIQUE constraint")) return { ok: true };
    throw err;
  }
}

export function removeUserBookmark(userId, url) {
  db.prepare("DELETE FROM bookmarks WHERE user_id = ? AND url = ?").run(userId, url);
}

export function getUserHistory(userId, limit = 200) {
  return db.prepare(
    "SELECT url, title, visited_at FROM history WHERE user_id = ? ORDER BY visited_at DESC LIMIT ?"
  ).all(userId, limit);
}

export function addUserHistory(userId, url, title) {
  db.prepare(
    "INSERT INTO history (user_id, url, title) VALUES (?, ?, ?)"
  ).run(userId, url, title || "");

  // Keep history bounded per user: prune beyond the last 400 entries so the
  // table can't grow without limit as users browse.
  db.prepare(
    "DELETE FROM history WHERE user_id = ? AND id NOT IN (SELECT id FROM history WHERE user_id = ? ORDER BY visited_at DESC, id DESC LIMIT 400)"
  ).run(userId, userId);
}

export function clearUserHistory(userId) {
  db.prepare("DELETE FROM history WHERE user_id = ?").run(userId);
}

export function updateUserHistoryTitle(userId, url, title) {
  // Always sync to the latest real title; history titles aren't user-customized
  // so keeping the newest one is correct (prevents permanently stale titles).
  db.prepare(
    "UPDATE history SET title = ? WHERE user_id = ? AND url = ?"
  ).run(title, userId, url);
}
