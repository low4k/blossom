// Visual check: redesigned home + login pages.
// Self-contained like the other suites: boots its own server on the QA DB.
import path from "node:path";
import { startServer, launchBrowser, trackErrors, ARTIFACTS, record, summary } from "./harness.mjs";

const server = await startServer();
const base = server.base;
const { browser, context } = await launchBrowser();
const page = await context.newPage();
const errors = trackErrors(page);

try {
  // login page
  await page.goto(`${base}/login`, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(ARTIFACTS, "50-login-redesign.png") });
  record("visual", "login split-panel screenshot", true);

  // register tab (sliding underline)
  await page.click("#tab-register");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(ARTIFACTS, "51-login-register.png") });
  record("visual", "register tab screenshot", true);

  // home page (login as dev)
  await page.click("#tab-login");
  await page.fill("#login-email", "qa-dev@test.local");
  await page.fill("#login-pass", "qa-test-pass-1");
  await page.click("#login-form .auth-submit");
  await page.waitForURL(`${base}/`, { timeout: 10000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(ARTIFACTS, "52-home-redesign.png") });
  record("visual", "home page screenshot", true);

  // ensure the new assets (petals, branch, favicon) load without console errors
  const bad = errors.filter((e) => e.startsWith("[error]") || e.startsWith("[pageerror]"));
  record("visual", "no console/page errors on redesign pages", bad.length === 0, bad.join(" | ").slice(0, 200));
} finally {
  console.log("\n=== visual redesign check complete ===");
  await browser.close();
  server.child.kill();
  process.exit(summary() > 0 ? 1 : 0);
}
