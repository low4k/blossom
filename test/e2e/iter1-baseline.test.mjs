// Iteration 1 — baseline crawl: auth flows, page loads, console cleanliness.
import { startServer, launchBrowser, trackErrors, shot, record, summary } from "./harness.mjs";

const server = await startServer();
const base = server.base;
const { browser, context } = await launchBrowser();

// Wrap each step so a failure is recorded but doesn't abort the rest of the suite.
async function step(area, name, fn) {
  try {
    await fn();
  } catch (e) {
    record(area, name, false, `exception: ${String(e.message || e).slice(0, 200)}`);
  }
}

try {
  // --- 1. Login page loads ---
  await step("auth", "login page renders", async () => {
    const page = await context.newPage();
    trackErrors(page);
    await page.goto(`${base}/login`, { waitUntil: "networkidle" });
    await shot(page, "01-login");
    const ok = await page.locator("#login-form").isVisible();
    await page.close();
    record("auth", "login page renders", ok);
  });

  // --- 2. Register a fresh user via UI (fresh context = logged out) ---
  const stamp = Date.now();
  const userEmail = `qa-user-${stamp}@test.local`;
  await step("auth", "register lands logged in on /", async () => {
    const page = await context.newPage();
    trackErrors(page);
    await page.goto(`${base}/login`, { waitUntil: "networkidle" });
    await page.click("#tab-register");
    await page.fill("#reg-name", "QA User");
    await page.fill("#reg-email", userEmail);
    await page.fill("#reg-pass", "qa-password-1");
    await shot(page, "02-register-filled");
    await page.click("#register-form .auth-submit");
    await page.waitForURL(`${base}/`, { timeout: 10000 });
    const ok = page.url() === `${base}/` && (await page.locator("#search-form").isVisible());
    await page.waitForTimeout(2500); // allow SW + scramjet init
    await shot(page, "03-home-after-register");
    record("auth", "register lands logged in on /", ok, `url=${page.url()}`);
    await page.close();
  });

  // --- 3. Wrong password shows generic error (logged-out context) ---
  await step("auth", "wrong password shows generic error", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    trackErrors(page);
    await page.goto(`${base}/login`, { waitUntil: "networkidle" });
    await page.fill("#login-email", userEmail);
    await page.fill("#login-pass", "definitely-wrong");
    await page.click("#login-form .auth-submit");
    await page.waitForTimeout(1500);
    const errText = await page.locator("#login-error").textContent();
    await shot(page, "04-login-wrong-password");
    const generic = /invalid email or password/i.test(errText || "");
    const noEnumeration = !/no account|not found|doesn't exist|no user/i.test(errText || "");
    await ctx.close();
    record("auth", "wrong password shows generic error", generic && noEnumeration, `text="${errText}"`);
  });

  // --- 4. Logout clears the session ---
  await step("auth", "logout clears session (401 afterwards)", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    trackErrors(page);
    await page.goto(`${base}/login`, { waitUntil: "networkidle" });
    await page.fill("#login-email", userEmail);
    await page.fill("#login-pass", "qa-password-1");
    await page.click("#login-form .auth-submit");
    await page.waitForURL(`${base}/`, { timeout: 10000 });
    await page.evaluate(async () => { await fetch("/auth/logout", { method: "POST" }); });
    const status = await page.evaluate(async () => {
      const r = await fetch("/api/bookmarks", { headers: { Accept: "application/json" } });
      return r.status;
    });
    await ctx.close();
    record("auth", "logout clears session (401 afterwards)", status === 401, `got=${status}`);
  });

  // --- 5. Dev account sees admin button; dashboard renders ---
  await step("admin", "dev account opens admin dashboard", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = trackErrors(page);
    await page.goto(`${base}/login`, { waitUntil: "networkidle" });
    await page.fill("#login-email", "qa-dev@test.local");
    await page.fill("#login-pass", "qa-test-pass-1");
    await page.click("#login-form .auth-submit");
    await page.waitForURL(`${base}/`, { timeout: 10000 });
    await page.waitForTimeout(2000);
    const adminBtnVisible = await page.locator("#btn-admin").isVisible();
    await page.goto(`${base}/admin`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await shot(page, "05-admin-dashboard");
    const statsVisible = await page.locator("#stat-users").isVisible();
    const consoleErrs = errors.filter((e) => e.startsWith("[error]") || e.startsWith("[pageerror]"));
    record("admin", "dev account opens admin dashboard", adminBtnVisible && statsVisible,
      consoleErrs.length ? `console: ${consoleErrs.join(" | ").slice(0, 200)}` : "");
    await ctx.close();
  });

  // --- 6. Non-dev user hitting /admin is redirected ---
  await step("admin", "non-dev redirected away from /admin", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/login`, { waitUntil: "networkidle" });
    await page.fill("#login-email", userEmail);
    await page.fill("#login-pass", "qa-password-1");
    await page.click("#login-form .auth-submit");
    await page.waitForURL(`${base}/`, { timeout: 10000 });
    await page.goto(`${base}/admin`, { waitUntil: "load" });
    await page.waitForTimeout(2000);
    record("admin", "non-dev redirected away from /admin", !page.url().includes("/admin"), `url=${page.url()}`);
    await ctx.close();
  });
} finally {
  const failed = summary();
  await browser.close();
  server.child.kill();
  process.exit(failed > 0 ? 1 : 0);
}

