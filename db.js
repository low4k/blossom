// Blossom — SQLite database layer
// Uses better-sqlite3 for fast synchronous access with WAL mode

import Database from "better-sqlite3";
import { hashSync, compareSync } from "bcryptjs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "blossom.db"));

// WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// --- Schema ---
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
`);

// Default features for new users
const DEFAULT_FEATURES = {
  proxy: true,
  games: true,
  bookmarks: true,
  settings: true,
};

// --- Seed dev account ---
const DEV_EMAIL = "vendint3@gmail.com";
const DEV_PASS = "january1311";

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

// --- Session cleanup (runs every 10 minutes) ---
function cleanExpiredSessions() {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
}
setInterval(cleanExpiredSessions, 10 * 60 * 1000);
cleanExpiredSessions();

// --- User operations ---
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

  // Update last login
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

// --- Session operations ---
const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL;
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    token, userId, now, expiresAt
  );
  return { token, expiresAt };
}

export function validateSession(token) {
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const session = db.prepare(
    "SELECT s.user_id, u.id, u.email, u.display_name, u.role, u.features FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ?"
  ).get(token, now);
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
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function deleteUserSessions(userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

// --- Admin operations ---
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
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
}

export function deleteUser(userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM users WHERE id = ? AND role != 'dev'").run(userId);
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
