// Standalone prune check: isolated server + direct login + 450 inserts.
// Avoids the shared harness to rule out path/port issues.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..", "..");

// fresh isolated QA DB
const dataDir = path.join(root, "test", "e2e", "qa-data");
fs.rmSync(dataDir, { recursive: true, force: true });

const env = { ...process.env, PORT: "8123", DEV_EMAIL: "qa-dev@test.local", DEV_PASS: "qa-test-pass-1", DB_PATH: "test/e2e/qa-data/blossom.db" };
const child = spawn("node", ["server.js"], { cwd: root, env, stdio: "ignore" });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch("http://localhost:8123/health"); if (r.ok) { up = true; break; } } catch {}
    await wait(250);
  }
  if (!up) throw new Error("server did not start");
  console.log("server up");

  const login = await fetch("http://localhost:8123/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: "qa-dev@test.local", password: "qa-test-pass-1" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("no cookie");
  console.log("logged in");

  for (let i = 0; i < 450; i++) {
    await fetch("http://localhost:8123/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: cookie },
      body: JSON.stringify({ url: `https://p.local/page-${i}`, title: "p" }),
    });
  }
  const hist = await (await fetch("http://localhost:8123/api/history", { headers: { Accept: "application/json", Cookie: cookie } })).json();
  console.log("API history entries returned:", hist.length);

  // Read the DB directly to confirm the prune kept exactly the newest 400
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(dataDir, "blossom.db"));
  const total = db.prepare("SELECT COUNT(*) c FROM history").get().c;
  const prunedRows = db.prepare("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY visited_at DESC, id DESC LIMIT 400)").run().changes;
  const after = db.prepare("SELECT COUNT(*) c FROM history").get().c;
  db.close();
  console.log("DB history total:", total);
  console.log("DB prune (extra rows removed):", prunedRows);
  console.log("DB history after explicit prune:", after);
  console.log(total === 400 && prunedRows === 0 ? "PRUNE OK (DB capped at 400)" : (total > 400 ? "PRUNE FAILED (DB still > 400)" : "DB under 400, nothing to prune"));
} catch (e) {
  console.log("ERROR:", e.message);
} finally {
  child.kill();
  process.stdout.write("done\n");
  process.exit(0);
}