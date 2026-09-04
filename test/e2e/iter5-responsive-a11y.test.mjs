// Iteration 5 — session-expiry client redirect, mirrors failover, PWA version
// purge, responsive layout (375/768), accessibility basics.
import http from "node:http";
import { startServer, launchBrowser, trackErrors, shot, record, summary } from "./harness.mjs";

async function step(area, name, fn) {
  try {
    await fn();
  } catch (e) {
    record(area, name, false, `exception: ${String(e.message || e).slice(0, 200)}`);
  }
}

// Local "mirror" that answers /health with CORS headers (for the failover test)
const mirror = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ status: "ok" }));
});
await new Promise((r) => mirror.listen(9992, r));

const server = await startServer();
const base = server.base;
const { browser, context } = await launchBrowser();

try {
  let page;
  await step("setup", "login", async () => {
    page = await context.newPage();
    trackErrors(page);
    await page.goto(`${base}/login`, { waitUntil: "load" });
    await page.fill("#login-email", "qa-dev@test.local");
    await page.fill("#login-pass", "qa-test-pass-1");
    await page.click("#login-form .auth-submit");
    await page.waitForURL(`${base}/`, { timeout: 10000 });
    await page.waitForTimeout(2500);
    record("setup", "login", page.url() === `${base}/`);
  });

  // ---------- Session expiry mid-session ----------
  await step("session", "expired session mid-use redirects to /login on sync action", async () => {
    // Wipe cookies to simulate server-side expiry while the app stays loaded
    await context.clearCookies();
    // Trigger the same code path a UI action would (module-level sync)
    const result = await page.evaluate(async () => {
      const m = await import("/js/bookmarks.js");
      await m.syncBookmarksFromServer();
      return { url: location.pathname };
    });
    await page.waitForURL(/\/login/, { timeout: 5000 }).catch(() => {});
    record("session", "401 sync redirects to /login", page.url().includes("/login"), JSON.stringify(result));
  });

  // ---------- Mirrors failover ----------
  await step("mirrors", "best healthy mirror is selected from MIRRORS list", async () => {
    // Re-login and reload with mirrors configured in localStorage-free way:
    // mirrors come from /blossom-config.json (MIRRORS env). Simulate by
    // driving initMirrors directly with one dead + one healthy mirror.
    await page.goto(`${base}/login`, { waitUntil: "load" });
    await page.fill("#login-email", "qa-dev@test.local");
    await page.fill("#login-pass", "qa-test-pass-1");
    await page.click("#login-form .auth-submit");
    await page.waitForURL(`${base}/`, { timeout: 10000 });
    await page.waitForTimeout(2000);
    const best = await page.evaluate(async () => {
      const m = await import("/js/mirrors.js");
      // one dead port, one healthy local mirror (127.0.0.1 — mirrors.js excludes
      // candidates whose URL contains location.hostname, i.e. "localhost")
      await m.initMirrors(["http://127.0.0.1:9991", "http://127.0.0.1:9992"]);
      await new Promise((r) => setTimeout(r, 3000));
      return m.getBestMirror();
    });
    record("mirrors", "healthy mirror wins the race", best === "http://127.0.0.1:9992", `best=${best}`);
  });

  // ---------- PWA version purge ----------
  await step("pwa", "version bump triggers purgeStaleData and SW re-registers", async () => {
    const logs = [];
    page.on("console", (m) => logs.push(m.text()));
    // Pretend the stored version is older than the server's
    await page.evaluate(() => localStorage.setItem("blossom_version", "0.0.1-old"));
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(4000);
    const purged = logs.some((t) => t.includes("Purging stale SW data"));
    const swOk = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length >= 1;
    });
    record("pwa", "stale-data purge runs on version change", purged && swOk, `purged=${purged} sw=${swOk}`);
  });

  // ---------- Responsive: phone 375px ----------
// Fixed-position elements have null offsetParent; use geometry instead.
const isVisible = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
};
const checkViewport = async (width, height, label) => {
  await page.setViewportSize({ width, height });
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  const home = await page.evaluate(() => ({
    hOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    searchVisible: (() => { const el = document.getElementById("search-input"); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0; })(),
    topbarVisible: (() => { const el = document.getElementById("topbar"); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0; })(),
  }));
  await shot(page, `30-home-${label}`);

  await page.click("#btn-games");
  await page.waitForTimeout(800);
  const games = await page.evaluate(() => ({
    hOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    gridVisible: (() => { const el = document.getElementById("games-grid"); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0; })(),
    cardWidth: document.querySelector(".game-card")?.getBoundingClientRect().width || 0,
  }));
  await shot(page, `31-games-${label}`);

  await page.keyboard.press("Escape");
  await page.click("#btn-bookmarks");
  await page.waitForTimeout(600);
  const panel = await page.evaluate(() => ({
    panelVisible: (() => { const el = document.getElementById("bookmarks-panel"); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0; })(),
    panelWithin: document.getElementById("bookmarks-panel").getBoundingClientRect().right <= window.innerWidth + 2,
  }));
  await shot(page, `32-panel-${label}`);
  await page.keyboard.press("Escape");

  // Return home before driving the search box (games view hides it)
  await page.click("#games-back");
  await page.waitForTimeout(500);

  await page.fill("#search-input", "example.com");
  await page.press("#search-input", "Enter");
  await page.waitForSelector("#proxy-frame", { timeout: 30000 });
  await page.waitForTimeout(3000);
  const toolbar = await page.evaluate(() => ({
    hOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    toolbarVisible: (() => { const el = document.getElementById("proxy-toolbar"); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0; })(),
    framePresent: !!document.getElementById("proxy-frame"),
  }));
  await shot(page, `33-proxy-${label}`);

  return { home, games, panel, toolbar };
};

await step("responsive", "phone 375px: home, games, panel, proxy toolbar usable", async () => {
  const r = await checkViewport(375, 667, "375");
  const ok =
    !r.home.hOverflow && r.home.searchVisible && r.home.topbarVisible &&
    !r.games.hOverflow && r.games.gridVisible && r.games.cardWidth > 0 &&
    r.panel.panelVisible && r.panel.panelWithin &&
    !r.toolbar.hOverflow && r.toolbar.toolbarVisible && r.toolbar.framePresent;
  record("responsive", "phone 375px usable", ok, JSON.stringify(r));
});

await step("responsive", "tablet 768px: home, games, panel, proxy toolbar usable", async () => {
  const r = await checkViewport(768, 1024, "768");
  const ok =
    !r.home.hOverflow && r.home.searchVisible &&
    !r.games.hOverflow && r.games.gridVisible &&
    r.panel.panelVisible &&
    !r.toolbar.hOverflow && r.toolbar.toolbarVisible;
  record("responsive", "tablet 768px usable", ok, JSON.stringify(r));
});

await step("responsive", "admin dashboard at 375px usable", async () => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto(`${base}/admin`, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  const admin = await page.evaluate(() => ({
    hOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    statsVisible: (() => { const el = document.getElementById("stat-users"); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0; })(),
    tableScrollable: (() => { const el = document.querySelector(".table-scroll"); if (!el) return false; return el.scrollWidth >= el.clientWidth; })(),
  }));
  await shot(page, "34-admin-375");
  record("responsive", "admin at 375px usable", !admin.hOverflow && admin.statsVisible, JSON.stringify(admin));
});

// ---------- Accessibility ----------
await step("a11y", "keyboard Shift+Tab reaches topbar buttons with visible focus", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  await page.focus("#search-input");
  const focused = [];
  // Walk backwards: the topbar precedes main in the DOM
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Shift+Tab");
    const f = await page.evaluate(() => {
      const el = document.activeElement;
      const style = getComputedStyle(el);
      return {
        id: el.id || el.className || el.tagName,
        outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
      };
    });
    focused.push(f);
    if (f.id.includes("btn-") && focused.filter((x) => x.id.includes("btn-")).length >= 2) break;
  }
  const btnCount = focused.filter((f) => f.id.includes("btn-")).length;
  const focusOk = focused.filter((f) => f.id.includes("btn-")).every((f) => f.outline);
  record("a11y", "keyboard reaches topbar buttons", btnCount >= 2, focused.map((f) => f.id).join(","));
  record("a11y", "focus-visible outline present on focused buttons", focusOk, JSON.stringify(focused));
});

await step("a11y", "icon-only buttons expose accessible names", async () => {
  const names = await page.evaluate(() => {
    const check = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return "missing";
      return el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent.trim() || "NONE";
    };
    return {
      panelClose: check(".panel-close"),
      btnBookmarks: check("#btn-bookmarks"),
      btnHistory: check("#btn-history"),
      btnSettings: check("#btn-settings"),
      btnGames: check("#btn-games"),
      btnApps: check("#btn-apps"),
      btnAi: check("#btn-ai"),
    };
  });
  const ok = Object.values(names).every((v) => v !== "NONE" && v !== "missing" && !v.startsWith("✕") && !v.startsWith("★"));
  record("a11y", "icon buttons have accessible names", ok, JSON.stringify(names));
});

await step("a11y", "settings panel opens and Escape closes it", async () => {
  await page.click("#btn-settings");
  await page.waitForTimeout(500);
  const open = await page.evaluate(() => !document.getElementById("settings-panel").hidden);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const closed = await page.evaluate(() => document.getElementById("settings-panel").hidden);
  record("a11y", "settings panel opens and Escape closes", open && closed, `open=${open} closed=${closed}`);
});
} finally {
  const failed = summary();
  await browser.close();
  server.child.kill();
  mirror.close();
  process.exit(failed > 0 ? 1 : 0);
}