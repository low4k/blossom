// Standalone node check for the keep-alive refresher + circuit breaker.
// No browser: imports captcha.js in-process with a mock keep-alive target.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..", "..");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
}

// mock target that records the Cookie header
let lastCookie = null;
const target = http.createServer((req, res) => {
  lastCookie = req.headers.cookie || "";
  res.writeHead(204).end();
});
await new Promise((r) => target.listen(0, "127.0.0.1", r));
const port = target.address().port;

process.env.DB_PATH = path.join("test", "e2e", "qa-data-keepalive", "blossom.db");
process.env.CAPTCHA_WATCH_HOSTS = `127.0.0.1:${port},127.0.0.1:59999`; // one alive, one dead
fs.rmSync(path.join(root, "test", "e2e", "qa-data-keepalive"), { recursive: true, force: true });

const { createUser, saveVaultCookies, getVaultCookies } = await import("../../db.js");
const { runKeepAliveOnce, classifyHost } = await import("../../captcha.js");

try {
  const u = createUser("keepalive@test.local", "pass1234a", "ka");
  if (u.error) throw new Error(u.error);

  // classifier semantics
  const cls = classifyHost("127.0.0.1"); // bare hostname must match ported entry
  check("classifier matches bare host against ported entry", !!cls && cls.entry.includes(":"));
  check("classifier rejects unlisted host", classifyHost("not-watched.example") === null);

  // Vault row for the LIVE target: one fresh cookie + one expired cookie.
  saveVaultCookies(u.id, "127.0.0.1", JSON.stringify([
    { name: "NID", value: "test-nid-123", domain: ".127.0.0.1", path: "/" },
    { name: "OLD", value: "stale", domain: ".127.0.0.1", path: "/", expires: "Sat, 01 Jan 2000 00:00:00 GMT" },
  ]));
  // Vault row for the DEAD target: classifyHost("127.0.0.1:59999") maps to the
  // dead watch entry, so its breaker can be exercised independently.
  saveVaultCookies(u.id, "127.0.0.1:59999", JSON.stringify([
    { name: "DEAD", value: "host", domain: ".127.0.0.1", path: "/" },
  ]));

  // Expired cookies must not be sent.
  let r = await runKeepAliveOnce();
  const liveHit = r.find((x) => x.host === "127.0.0.1" && x.ok);
  check("keep-alive probe reaches target with vault cookie", !!liveHit && lastCookie.includes("NID=test-nid-123"),
    `results=${JSON.stringify(r)} cookie=${lastCookie}`);
  check("expired cookies are not sent", !lastCookie.includes("OLD=stale"), lastCookie);

  // The dead host should trip its breaker after 3 consecutive failures.
  const deadRuns = [];
  for (let i = 0; i < 4; i++) deadRuns.push(await runKeepAliveOnce());
  const deadSkipped = deadRuns[3].some((x) => x.host === "127.0.0.1:59999" && x.skipped === "breaker-open");
  check("dead host breaker opens after repeated failures", deadSkipped,
    JSON.stringify(deadRuns[3]));

  // vault read confirms the saved row
  const row = getVaultCookies(u.id, "127.0.0.1");
  check("vault row readable", !!row, JSON.stringify(row && row.cookies?.slice(0, 60)));
} catch (e) {
  console.log("ERROR:", e);
  failed++;
} finally {
  target.close();
  process.exit(failed > 0 ? 1 : 0);
}
