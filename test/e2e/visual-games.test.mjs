// Visual check: games grid with emoji fallback thumbnails.
import { startServer, launchBrowser, shot, record, summary } from "./harness.mjs";

const server = await startServer();
const base = server.base;
const { browser, context } = await launchBrowser();

try {
  const page = await context.newPage();
  await page.goto(`${base}/login`, { waitUntil: "load" });
  await page.fill("#login-email", "qa-dev@test.local");
  await page.fill("#login-pass", "qa-test-pass-1");
  await page.click("#login-form .auth-submit");
  await page.waitForURL(`${base}/`, { timeout: 10000 });
  await page.waitForTimeout(3000);
  await page.click("#btn-games");
  await page.waitForTimeout(4000); // let external thumbs try to load
  const info = await page.evaluate(() => ({
    cards: document.querySelectorAll("#games-grid .game-card").length,
    withThumbBox: document.querySelectorAll("#games-grid .game-card-thumb").length,
    fallbacks: [...document.querySelectorAll("#games-grid .game-card-thumb")]
      .filter((el) => el.textContent.trim().length > 0).length,
    loadedImgs: [...document.querySelectorAll("#games-grid .game-card-thumb img")]
      .filter((el) => el.complete && el.naturalWidth > 0).length,
    cardHeight: document.querySelector(".game-card")?.getBoundingClientRect().height || 0,
  }));
  await shot(page, "40-games-grid-fixed");
  record("games", "cards render with thumb box + fallback", info.cards > 10 && info.withThumbBox === info.cards && info.cardHeight > 100, JSON.stringify(info));
} finally {
  summary();
  await browser.close();
  server.child.kill();
}
