// Iteration 6 — 2FA (TOTP) end-to-end: setup → enable → login challenge →
// wrong code rejected → correct code works → disable → normal login again.
import crypto from "node:crypto";
import { startServer, launchBrowser, record, summary } from "./harness.mjs";
import { base32Decode } from "../../totp.js";

async function step(area, name, fn) {
  try {
    await fn();
  } catch (e) {
    record(area, name, false, `exception: ${String(e.message || e).slice(0, 200)}`);
  }
}

// Compute the current RFC 6238 code for a secret (mirrors totp.js).
function currentCode(secret) {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const val =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(val % 1_000_000).padStart(6, "0");
}

const server = await startServer();
const base = server.base;
const { browser } = await launchBrowser();

try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let secret = null;

  await step("2fa", "login as dev", async () => {
    await page.goto(`${base}/login`, { waitUntil: "load" });
    await page.fill("#login-email", "qa-dev@test.local");
    await page.fill("#login-pass", "qa-test-pass-1");
    await page.click("#login-form .auth-submit");
    await page.waitForURL(`${base}/`, { timeout: 10000 });
    await page.waitForTimeout(1500);
    record("2fa", "login as dev", page.url() === `${base}/`);
  });

  await step("2fa", "admin setup returns secret + otpauth URI", async () => {
    const r = await page.evaluate(async () => {
      const res = await fetch("/admin/api/totp/setup", { method: "POST", headers: { Accept: "application/json" } });
      return { status: res.status, body: await res.json() };
    });
    secret = r.body?.secret || null;
    const ok = r.status === 200 && !!secret && /^otpauth:\/\//.test(r.body?.otpauthUri || "");
    record("2fa", "setup returns secret + otpauth URI", ok, `secret?=${!!secret} uri?=${/^otpauth:\/\//.test(r.body?.otpauthUri || "")}`);
  });

  await step("2fa", "enable with correct TOTP code", async () => {
    const real = currentCode(secret);
    const r = await page.evaluate(async (c) => {
      const res = await fetch("/admin/api/totp/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code: c }),
      });
      return { status: res.status, body: await res.json() };
    }, real);
    record("2fa", "enable with correct code", r.status === 200, JSON.stringify(r));
  });

  await step("2fa", "login without code shows 2FA challenge + reveals field", async () => {
    await ctx.clearCookies();
    await page.goto(`${base}/login`, { waitUntil: "load" });
    await page.fill("#login-email", "qa-dev@test.local");
    await page.fill("#login-pass", "qa-test-pass-1");
    await page.click("#login-form .auth-submit");
    await page.waitForTimeout(800);
    const challenge = await page.evaluate(() => ({
      totpFieldVisible: !document.getElementById("login-totp-group").hidden,
      error: document.getElementById("login-error").textContent,
    }));
    record("2fa", "login without code shows 2FA challenge + reveals field", challenge.totpFieldVisible && /2FA/.test(challenge.error), JSON.stringify(challenge));
  });

  await step("2fa", "wrong TOTP code is rejected", async () => {
    await page.fill("#login-totp", "000000");
    await page.click("#login-form .auth-submit");
    await page.waitForTimeout(800);
    const err = await page.evaluate(() => document.getElementById("login-error").textContent);
    record("2fa", "wrong code rejected", /Invalid 2FA/.test(err), `err=${err}`);
  });

    await step("2fa", "correct TOTP code logs in", async () => {
    const code = currentCode(secret);
    await page.fill("#login-totp", code);
    await page.click("#login-form .auth-submit");
    await page.waitForURL(`${base}/`, { timeout: 10000 });
    record("2fa", "correct code logs in", page.url() === `${base}/`, `url=${page.url()}`);
  });

  await step("2fa", "disable 2FA with a current code", async () => {
    const code = currentCode(secret);
    const r = await page.evaluate(async (c) => {
      const res = await fetch("/admin/api/totp/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code: c }),
      });
      return { status: res.status };
    }, code);
    record("2fa", "disable 2FA with current code", r.status === 200, `status=${r.status}`);
  });

  await step("2fa", "login without code works after disable", async () => {
    await ctx.clearCookies();
    await page.goto(`${base}/login`, { waitUntil: "load" });
    await page.fill("#login-email", "qa-dev@test.local");
    await page.fill("#login-pass", "qa-test-pass-1");
    await page.click("#login-form .auth-submit");
    await page.waitForURL(`${base}/`, { timeout: 10000 });
    record("2fa", "login without code after disable", page.url() === `${base}/`, `url=${page.url()}`);
  });

  await ctx.close();
} finally {
  const failed = summary();
  await browser.close();
  server.child.kill();
  process.exit(failed > 0 ? 1 : 0);
}