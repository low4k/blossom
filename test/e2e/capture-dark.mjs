// One-off: capture home page in dark theme + login gate frames.
import path from "node:path";
import { startServer, launchBrowser, ARTIFACTS } from "./harness.mjs";

const server = await startServer();
const base = server.base;
const { browser, context } = await launchBrowser();
const page = await context.newPage();

try {
  await context.addInitScript(() => {
    localStorage.setItem("blossom-theme", "dark");
  });
  await page.goto(`${base}/login`, { waitUntil: "load" });
  await page.fill("#login-email", "qa-dev@test.local");
  await page.fill("#login-pass", "qa-test-pass-1");
  await page.click("#login-form .auth-submit");
  await page.waitForURL(`${base}/`, { timeout: 10000 });
  await page.waitForTimeout(2600);
  await page.screenshot({ path: path.join(ARTIFACTS, "53-home-dark.png") });

  // proxy mode: topbar should be hidden
  await page.fill("#search-input", "https://example.com");
  await page.click("#search-form .search-go");
  await page.waitForSelector("#proxy-frame", { timeout: 15000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(ARTIFACTS, "54-proxying-dark.png") });

  // logout modal
  await page.click("#proxy-home");
  await page.waitForTimeout(500);
  await page.click("#btn-logout");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(ARTIFACTS, "55-logout-modal.png") });
  console.log("dark captures done");
} finally {
  await browser.close();
  server.child.kill();
  process.exit(0);
}
