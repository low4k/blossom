// Apps catalog + per-account save round-trip through the play frame.
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

  await step("ai", "Blossom AI view opens with composer", async () => {
    await page.keyboard.press("Escape");
    await page.click("#btn-ai");
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => ({
      visible: !document.getElementById("ai-view").hidden,
      composer: !!document.getElementById("ai-input"),
      starters: document.querySelectorAll(".ai-starter").length,
    }));
    record("ai", "AI view opens", info.visible && info.composer && info.starters >= 3, JSON.stringify(info));
    await page.click("#ai-back");
    await page.waitForTimeout(200);
  });

  await step("apps", "apps view opens and grid loads from manifest", async () => {
    await page.keyboard.press("Escape");
    await page.click("#btn-apps");
    await page.waitForTimeout(800);
    const info = await page.evaluate(() => ({
      visible: !document.getElementById("apps-view").hidden,
      cards: document.querySelectorAll("#apps-grid .game-card").length,
      thumbs: document.querySelectorAll("#apps-grid .game-card-thumb img").length,
    }));
    await shot(page, "60-apps-grid");
    record("apps", "apps view opens and grid renders", info.visible && info.cards >= 8, JSON.stringify(info));
  });

  await step("apps", "search filters apps", async () => {
    await page.fill("#apps-search", "wiki");
    await page.waitForTimeout(400);
    const count = await page.evaluate(() => document.querySelectorAll("#apps-grid .game-card").length);
    const name = await page.evaluate(() => document.querySelector("#apps-grid .game-card-name")?.textContent || "");
    record("apps", "search filters grid", count === 1 && /wiki/i.test(name), `count=${count} name=${name}`);
    await page.fill("#apps-search", "");
    await page.waitForTimeout(300);
  });

  await step("saves", "local game save round-trips to the account", async () => {
    await page.click("#apps-back");
    await page.waitForTimeout(400);
    await page.click("#btn-games");
    await page.waitForTimeout(800);
    await page.locator(".game-card", { hasText: "Snake" }).first().click();
    await page.waitForSelector("#proxy-frame", { timeout: 20000 });
    await page.waitForTimeout(1200);

    const inFrame = page.frameLocator("#proxy-frame");
    await inFrame.locator("body").waitFor({ timeout: 10000 }).catch(() => {});
    await page.evaluate(() => {
      localStorage.setItem("snake-e2e-score", "42");
    });
    const sync = await page.evaluate(async () => {
      if (typeof window.__blossomSyncSave !== "function") return { missing: true };
      return await window.__blossomSyncSave();
    });
    record("saves", "client sync returns ok", !!sync?.ok, JSON.stringify(sync));

    const stored = await page.evaluate(async () => {
      const r = await fetch("/api/saves/c-snake-html", { headers: { Accept: "application/json" } });
      if (!r.ok) return { status: r.status };
      return await r.json();
    });
    record(
      "saves",
      "account slot stores snake key",
      stored?.data?.local?.["snake-e2e-score"] === "42",
      JSON.stringify(stored?.data?.local || stored)
    );

    await page.click("#proxy-home");
    await page.waitForTimeout(600);
    await page.evaluate(() => localStorage.removeItem("snake-e2e-score"));
    await page.click("#btn-games");
    await page.waitForTimeout(500);
    await page.locator(".game-card", { hasText: "Snake" }).first().click();
    await page.waitForSelector("#proxy-frame", { timeout: 20000 });
    await page.waitForTimeout(1200);
    const restored = await page.evaluate(() => localStorage.getItem("snake-e2e-score"));
    record("saves", "relaunch restores snake key", restored === "42", `value=${restored}`);
    await shot(page, "61-snake-save-restore");
  });

  await step("saves", "settings lists and can forget game saves", async () => {
    await page.click("#proxy-home");
    await page.waitForTimeout(400);
    await page.click("#btn-settings");
    await page.locator("#settings-panel").waitFor({ state: "visible" });
    await page.waitForTimeout(400);
    const listed = await page.evaluate(() => {
      const items = [...document.querySelectorAll("#saves-list li")].map((li) => li.textContent);
      return {
        status: document.getElementById("saves-status")?.textContent || "",
        items,
      };
    });
    record("saves", "settings lists snake save", listed.items.some((t) => /snake/i.test(t)), JSON.stringify(listed));
    await page.click("#saves-clear");
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({
      status: document.getElementById("saves-status")?.textContent || "",
      items: document.querySelectorAll("#saves-list li").length,
    }));
    record("saves", "forget all clears listed saves", after.items === 0 && /none yet/i.test(after.status), JSON.stringify(after));
  });
} finally {
  const failed = summary();
  await browser.close();
  server.child.kill();
  process.exit(failed > 0 ? 1 : 0);
}
