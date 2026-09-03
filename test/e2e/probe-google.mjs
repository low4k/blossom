// Live probe: real Google Search through the proxy. Records whether the
// unusual-traffic interstitial appears, and what the vault captured.
// NOT part of run-all (network-dependent).
import path from "node:path";
import { startServer, launchBrowser, trackErrors, ARTIFACTS, shot } from "./harness.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Default watch list (google.com is in it); keep-alive stays off for the probe.
process.env.CAPTCHA_REFRESH_SECONDS = "0";

const server = await startServer();
const base = server.base;
const { browser, context } = await launchBrowser();

async function detect(page) {
  return page.evaluate(() => {
    const f = document.getElementById("proxy-frame");
    if (!f) return { state: "no-frame" };
    try {
      const doc = f.contentDocument;
      const txt = (doc?.body?.innerText || "").slice(0, 4000);
      const title = doc?.title || "";
      const isSorry = /unusual traffic|Our systems have detected|before you continue/i.test(txt) || /ipinfo|sorry/i.test(title);
      return {
        state: isSorry ? "challenge" : "content",
        title,
        bodySnippet: txt.replace(/\s+/g, " ").slice(0, 220),
      };
    } catch (e) {
      return { state: "frame-unreadable", err: String(e) };
    }
  });
}

try {
  const page = await context.newPage();
  trackErrors(page);

  await page.goto(`${base}/login`, { waitUntil: "load" });
  await page.fill("#login-email", "qa-dev@test.local");
  await page.fill("#login-pass", "qa-test-pass-1");
  await page.click("#login-form .auth-submit");
  await page.waitForURL(`${base}/`, { timeout: 10000 });
  await wait(1500);

  console.log("--- Probe 1: google.com/search fresh session ---");
  await page.fill("#search-input", "https://www.google.com/search?q=hello");
  await page.press("#search-input", "Enter");
  await page.waitForSelector("#proxy-frame", { timeout: 20000 });
  await wait(6000);
  let r1 = await detect(page);
  console.log("probe1:", JSON.stringify(r1, null, 1));
  await shot(page, "60-google-probe1");

  console.log("--- Probe 2: immediate revisit (same session) ---");
  await page.evaluate(() => document.getElementById("proxy-reload")?.click());
  await wait(6000);
  let r2 = await detect(page);
  console.log("probe2:", JSON.stringify(r2, null, 1));
  await shot(page, "61-google-probe2");

  const vault = await page.evaluate(async () => (await fetch("/api/captcha/vault")).json());
  const hosts = Object.keys(vault.hosts || {});
  const googleCookies = (vault.hosts?.["www.google.com"] || []).map((c) => c.name);
  console.log("vault hosts:", JSON.stringify(hosts));
  console.log("google cookies captured:", JSON.stringify(googleCookies));
  await shot(page, "62-google-vault");

  const status = await page.evaluate(async () => (await fetch("/api/captcha/status")).json());
  console.log("status events:", JSON.stringify(status.events));
  console.log(`RESULT: "${r1.state}"/"${r2.state}" vault=${JSON.stringify(googleCookies)}`);
} finally {
  await browser.close();
  server.child.kill();
  process.exit(0);
}
