// Iteration 3 — settings (cloak/panic/search) + games view.
import { startServer, launchBrowser, trackErrors, shot, record, summary } from "./harness.mjs";

async function step(area, name, fn) {
  try {
    await fn();
  } catch (e) {
    record(area, name, false, `exception: ${String(e.message || e).slice(0, 200)}`);
  }
}

const server = await startServer();
const base = server.base;
const { browser, context } = await launchBrowser();

try {
  let page;

  await step("setup", "login as user", async () => {
    page = await context.newPage();
    trackErrors(page);
    await page.goto(`${base}/login`, { waitUntil: "load" });
    await page.fill("#login-email", "qa-dev@test.local");
    await page.fill("#login-pass", "qa-test-pass-1");
    await page.click("#login-form .auth-submit");
    await page.waitForURL(`${base}/`, { timeout: 10000 });
    await page.waitForTimeout(3000);
    record("setup", "login as user", page.url() === `${base}/`);
  });

  // ---------- Settings: cloak ----------
  await step("settings", "changing cloak updates title/favicon and persists", async () => {
    await page.keyboard.press("Escape");
    await page.click("#btn-settings");
    await page.waitForTimeout(500);
    await page.selectOption("#setting-cloak", "classroom");
    await page.waitForTimeout(300);
    const title = await page.title();
    const favicon = await page.evaluate(() => document.querySelector("link[rel*='icon']")?.href || "");
    await shot(page, "20-settings-cloak");
    record("settings", "cloak applies immediately", title === "Google Classroom" && favicon.includes("classroom.google.com"), `title=${title} favicon=${favicon}`);

    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(2500);
    const afterReload = await page.title();
    record("settings", "cloak persists across reload", afterReload === "Google Classroom", `title=${afterReload}`);
  });

  // ---------- Settings: panic key ----------
  await step("settings", "panic key fires outside inputs, not inside", async () => {
    await page.evaluate((url) => {
      localStorage.setItem("blossom-panic-url", url);
      localStorage.setItem("blossom-panic-key", "1");
    }, `${base}/health`);
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(2000);

    await page.click("#search-input");
    await page.keyboard.press("1");
    await page.waitForTimeout(400);
    const stillHome = page.url() === `${base}/`;
    record("settings", "panic key does not fire in a text input", stillHome, `url=${page.url()}`);

    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("1");
    await page.waitForURL(`${base}/health`, { timeout: 5000 });
    record("settings", "panic key redirects when not focused in input", page.url() === `${base}/health`, `url=${page.url()}`);
  });

  // ---------- Settings: search engine persistence ----------
  await step("settings", "search engine selection persists", async () => {
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.waitForTimeout(2000);
    await page.click("#btn-settings");
    await page.waitForTimeout(400);
    await page.selectOption("#setting-search-engine", "https://www.bing.com/search?q=%s");
    await page.waitForTimeout(200);
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(2000);
    const val = await page.inputValue("#setting-search-engine");
    record("settings", "search engine persists across reload", val === "https://www.bing.com/search?q=%s", `value=${val}`);
  });

  // ---------- Games ----------
  await step("games", "games view opens, grid loads from manifest", async () => {
    await page.keyboard.press("Escape");
    await page.click("#btn-games");
    await page.waitForTimeout(1200);
    const gamesVisible = await page.evaluate(() => !document.getElementById("games-view").hidden);
    const cardCount = await page.evaluate(() => document.querySelectorAll("#games-grid .game-card").length);
    await shot(page, "21-games-grid");
    record("games", "games view opens and grid renders", gamesVisible && cardCount > 10, `cards=${cardCount}`);
  });

  await step("games", "search + tag filters work together", async () => {
    await page.fill("#games-search", "snake");
    await page.waitForTimeout(400);
    const snakeCount = await page.evaluate(() => document.querySelectorAll("#games-grid .game-card").length);
    record("games", "search filters grid", snakeCount === 1, `count=${snakeCount}`);

    await page.fill("#games-search", "");
    await page.waitForTimeout(300);
    const arcadeBtn = page.locator(".tag-btn", { hasText: "arcade" }).first();
    await arcadeBtn.click();
    await page.waitForTimeout(400);
    const arcadeCount = await page.evaluate(() => document.querySelectorAll("#games-grid .game-card").length);
    record("games", "tag filter works", arcadeCount >= 1, `count=${arcadeCount}`);
    await page.locator(".tag-btn", { hasText: "all" }).first().click();
    await page.waitForTimeout(300);
  });

  await step("games", "favoriting persists across reload", async () => {
    await page.locator("#games-grid .game-card .game-fav").first().click();
    await page.waitForTimeout(300);
    const favActive = await page.evaluate(() => document.querySelector("#games-grid .game-card .game-fav").classList.contains("active"));
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(2000);
    await page.click("#btn-games");
    await page.waitForTimeout(800);
    const favAfterReload = await page.evaluate(() => {
      const got = document.querySelector("#games-grid .game-card .game-fav");
      return { active: got?.classList.contains("active") };
    });
    record("games", "favorite persists across reload", favAfterReload.active === true, JSON.stringify(favAfterReload));
  });

  await step("games", "local game opens in new tab; external routes via proxy", async () => {
    const [popup] = await Promise.all([
      context.waitForEvent("page", { timeout: 15000 }).catch(() => [null]),
      page.locator(".game-card", { hasText: "Snake" }).first().click(),
    ]);
    await page.waitForTimeout(800);
    let localOk = false;
    if (popup && popup.url) {
      localOk = popup.url().includes("/games/snake.html");
      await popup.close();
    }
    record("games", "local game opens in new tab", localOk, popup ? popup.url() : "no popup");

    await page.locator(".game-card", { hasText: "2048" }).first().click();
    await page.waitForSelector("#proxy-frame", { timeout: 20000 });
    await page.waitForTimeout(1500);
    const src = await page.evaluate(() => document.getElementById("proxy-frame")?.src || "");
    const toolbar = await page.evaluate(() => !document.getElementById("proxy-toolbar").hidden);
    record("games", "external game routes via proxy", src.includes("/~/") && toolbar, `src=${src}`);
  });
} finally {
  const failed = summary();
  await browser.close();
  server.child.kill();
  process.exit(failed > 0 ? 1 : 0);
}