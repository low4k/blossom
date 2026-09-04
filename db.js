

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

  -- Anti-CAPTCHA session vault: scramjet cookie-store objects per watched
  -- host, restored into the SW jar after IDB purges / new devices.
  CREATE TABLE IF NOT EXISTS cookie_vault (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    cookies TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, host)
  );

  CREATE TABLE IF NOT EXISTS captcha_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    host TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_captcha_events_user ON captcha_events(user_id, created_at);

  -- Per-account game/app save slots (storage snapshots: localStorage + IDB)
  CREATE TABLE IF NOT EXISTS saves (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    save_id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, save_id)
  );
`);

// 2FA columns (safe to re-run: duplicate-column errors are expected/ignored)
for (const stmt of [
  "ALTER TABLE users ADD COLUMN totp_secret TEXT",
  "ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0",
]) {
  try {
    db.exec(stmt);
  } catch (e) {
    if (!/duplicate column/i.test(String(e.message))) throw e;
  }
}

const DEFAULT_FEATURES = {
  proxy: true,
  games: true,
  apps: true,
  bookmarks: true,
  settings: true,
  ai: true,
};

function parseFeatures(raw) {
  try {
    return { ...DEFAULT_FEATURES, ...(typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {}) };
  } catch {
    return { ...DEFAULT_FEATURES };
  }
}

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
      JSON.stringify({ ...DEFAULT_FEATURES, admin: true })
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
    features: parseFeatures(user.features),
    totpEnabled: !!user.totp_enabled,
    totpSecret: user.totp_secret || null,
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
    features: parseFeatures(user.features),
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
    features: parseFeatures(session.features),
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
    features: parseFeatures(u.features),
    createdAt: u.created_at,
    lastLogin: u.last_login,
  }));
}

export function updateUserFeatures(userId, features) {
  db.prepare("UPDATE users SET features = ? WHERE id = ?").run(JSON.stringify(parseFeatures(features)), userId);
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

export function setTotpSecret(userId, secret) {
  db.prepare("UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?").run(secret, userId);
}

export function enableTotp(userId) {
  db.prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?").run(userId);
}

export function disableTotp(userId) {
  db.prepare("UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?").run(userId);
}

export function getTotpState(userId) {
  const u = db.prepare("SELECT totp_secret, totp_enabled FROM users WHERE id = ?").get(userId);
  return u ? { secret: u.totp_secret || null, enabled: !!u.totp_enabled } : { secret: null, enabled: false };
}

export function getActiveSessionCount() {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare("SELECT COUNT(DISTINCT user_id) as count FROM sessions WHERE expires_at > ?").get(now).count;
}

export function getRecentSignups(days = 7) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  return db.prepare("SELECT COUNT(*) as count FROM users WHERE created_at > ?").get(since).count;
}

export function revokeUserSessions(userId) {
  const target = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
  if (!target) return { error: "User not found" };
  if (target.role === "dev") return { error: "Cannot revoke sessions for a dev account" };
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return { ok: true };
}

function fillDays(rows, days) {
  const map = new Map(rows.map((r) => [r.day, r.count]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, count: map.get(key) || 0 });
  }
  return out;
}

export function getAdminOverview() {
  const mem = process.memoryUsage();
  const signups = db.prepare(
    `SELECT date(created_at, 'unixepoch') AS day, COUNT(*) AS count
     FROM users WHERE created_at >= unixepoch('now', '-14 days')
     GROUP BY day ORDER BY day`
  ).all();
  const visits = db.prepare(
    `SELECT date(visited_at, 'unixepoch') AS day, COUNT(*) AS count
     FROM history WHERE visited_at >= unixepoch('now', '-14 days')
     GROUP BY day ORDER BY day`
  ).all();
  const captcha = db.prepare(
    `SELECT date(created_at, 'unixepoch') AS day, COUNT(*) AS count
     FROM captcha_events WHERE created_at >= unixepoch('now', '-14 days')
     GROUP BY day ORDER BY day`
  ).all();
  const topHosts = db.prepare(
    `SELECT host, COUNT(*) AS count FROM (
       SELECT CASE
         WHEN instr(substr(url, instr(url, '://') + 3), '/') > 0
         THEN substr(url, instr(url, '://') + 3, instr(substr(url, instr(url, '://') + 3), '/') - 1)
         ELSE substr(url, instr(url, '://') + 3)
       END AS host
       FROM history
       WHERE visited_at >= unixepoch('now', '-14 days') AND url LIKE 'http%'
     )
     WHERE host != ''
     GROUP BY host
     ORDER BY count DESC
     LIMIT 8`
  ).all();
  const roles = db.prepare(`SELECT role, COUNT(*) AS count FROM users GROUP BY role`).all();
  const totpOn = db.prepare(`SELECT COUNT(*) AS count FROM users WHERE totp_enabled = 1`).get().count;
  return {
    totalUsers: getUserCount(),
    activeSessions: getActiveSessionCount(),
    recentSignups7d: getRecentSignups(7),
    memoryMB: Math.round(mem.heapUsed / 1024 / 1024),
    rssMB: Math.round(mem.rss / 1024 / 1024),
    uptime: Math.floor(process.uptime()),
    totpEnabled: totpOn,
    bookmarks: db.prepare("SELECT COUNT(*) AS c FROM bookmarks").get().c,
    historyRows: db.prepare("SELECT COUNT(*) AS c FROM history").get().c,
    saves: db.prepare("SELECT COUNT(*) AS c FROM saves").get().c,
    captchaEvents7d: db.prepare(
      "SELECT COUNT(*) AS c FROM captcha_events WHERE created_at >= unixepoch('now', '-7 days')"
    ).get().c,
    roles: Object.fromEntries(roles.map((r) => [r.role, r.count])),
    signupsByDay: fillDays(signups, 14),
    visitsByDay: fillDays(visits, 14),
    captchaByDay: fillDays(captcha, 14),
    topHosts,
  };
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

// ---- Anti-CAPTCHA cookie vault ----

const VAULT_TTL = 30 * 24 * 60 * 60; // vault entries older than 30d are dropped

export function saveVaultCookies(userId, host, cookiesJson) {
  db.prepare(
    `INSERT INTO cookie_vault (user_id, host, cookies, updated_at) VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(user_id, host) DO UPDATE SET cookies = excluded.cookies, updated_at = unixepoch()`
  ).run(userId, host, cookiesJson);
}

export function getVaultCookies(userId, host) {
  const row = db.prepare(
    "SELECT cookies, updated_at FROM cookie_vault WHERE user_id = ? AND host = ?"
  ).get(userId, host);
  return row || null;
}

export function getVaultHosts(userId) {
  const rows = db.prepare(
    `SELECT host, cookies, updated_at FROM cookie_vault
     WHERE user_id = ? AND updated_at > unixepoch() - ? ORDER BY updated_at DESC`
  ).all(userId, VAULT_TTL);
  return rows.map((r) => ({
    host: r.host,
    cookieCount: JSON.parse(r.cookies).length,
    updatedAt: r.updated_at,
  }));
}

export function getUserVaultCookies(userId, hosts = null) {
  const rows = db.prepare(
    `SELECT host, cookies FROM cookie_vault
     WHERE user_id = ? AND updated_at > unixepoch() - ?`
  ).all(userId, VAULT_TTL);
  const out = {};
  for (const r of rows) {
    if (hosts && !hosts.includes(r.host)) continue;
    out[r.host] = JSON.parse(r.cookies);
  }
  return out;
}

export function deleteVaultCookies(userId, host) {
  db.prepare("DELETE FROM cookie_vault WHERE user_id = ? AND host = ?").run(userId, host);
}

export function clearUserVault(userId) {
  db.prepare("DELETE FROM cookie_vault WHERE user_id = ?").run(userId);
}

export function recordCaptchaEvent(userId, host, kind) {
  db.prepare(
    "INSERT INTO captcha_events (user_id, host, kind) VALUES (?, ?, ?)"
  ).run(userId, host, kind);
  // bound the log: keep the newest 1000 events per user
  db.prepare(
    "DELETE FROM captcha_events WHERE user_id = ? AND id NOT IN (SELECT id FROM captcha_events WHERE user_id = ? ORDER BY id DESC LIMIT 1000)"
  ).run(userId, userId);
}

// All users' vault rows touched within the window (drives the keep-alive loop).
export function getRecentVaultRows(maxAgeSeconds = 24 * 60 * 60) {
  return db.prepare(
    `SELECT user_id, host, cookies, updated_at FROM cookie_vault
     WHERE updated_at > unixepoch() - ?`
  ).all(maxAgeSeconds);
}

// ---- Per-account game/app saves ----

export function getSaveList(userId) {
  return db.prepare(
    "SELECT save_id AS id, length(data) AS sizeBytes, updated_at AS updatedAt FROM saves WHERE user_id = ? ORDER BY updated_at DESC"
  ).all(userId);
}

export function getSave(userId, saveId) {
  const row = db.prepare(
    "SELECT data, updated_at AS updatedAt FROM saves WHERE user_id = ? AND save_id = ?"
  ).get(userId, saveId);
  return row || null;
}

export function putSave(userId, saveId, dataJson) {
  db.prepare(
    `INSERT INTO saves (user_id, save_id, data, updated_at) VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(user_id, save_id) DO UPDATE SET data = excluded.data, updated_at = unixepoch()`
  ).run(userId, saveId, dataJson);
}

export function deleteSave(userId, saveId) {
  db.prepare("DELETE FROM saves WHERE user_id = ? AND save_id = ?").run(userId, saveId);
}

export function deleteAllSaves(userId, exceptId = "c-catalog-prefs") {
  db.prepare("DELETE FROM saves WHERE user_id = ? AND save_id != ?").run(userId, exceptId);
}

export function getCaptchaEventStats(userId) {
  return db.prepare(
    `SELECT host, kind, COUNT(*) AS count, MAX(created_at) AS last_at
     FROM captcha_events WHERE user_id = ? GROUP BY host, kind ORDER BY last_at DESC`
  ).all(userId);
}

export function updateUserHistoryTitle(userId, url, title) {
  // Always sync to the latest real title; history titles aren't user-customized
  // so keeping the newest one is correct (prevents permanently stale titles).
  db.prepare(
    "UPDATE history SET title = ? WHERE user_id = ? AND url = ?"
  ).run(title, userId, url);
}
