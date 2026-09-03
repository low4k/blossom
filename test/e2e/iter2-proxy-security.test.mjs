// Iteration 2 — security regressions + core proxy + bookmarks/history.
import fs from "node:fs";
import path from "node:path";
import { startServer, launchBrowser, trackErrors, shot, record, summary, ROOT } from "./harness.mjs";

async function step(area, name, fn) {
  try {
    await fn();
  } catch (e) {
    record(area, name, false, `exception: ${String(e.message || e).slice(0, 200)}`);
  }
}

// ---------- Security regression: no seeding without DEV_EMAIL/DEV_PASS ----------
await step("security", "no account seeded when DEV_EMAIL/DEV_PASS unset", async () => {
  const dataDir = path.join(ROOT, "data");
  const backup = path.join(ROOT, "data-backup-qa");
  const hadDb = fs.existsSync(path.join(dataDir, "blossom.db"));
  if (hadDb) {
    fs.rmSync(backup, { recursive: true, force: true });
    fs.renameSync(dataDir, backup);
  }
  let child;
  try {
    const { spawn } = await import("node:child_process");
    child = spawn("node", ["server.js"], {
      cwd: ROOT,
      // Neutralise DB_PATH too: this step must exercise the DEFAULT data/
      // location, not inherit whatever DB_PATH the ambient shell may export.
      env: { ...process.env, PORT: "8124", DEV_EMAIL: "", DEV_PASS: "", DB_PATH: "" },
      stdio: "ignore",
    });
    const base2 = "http://localhost:8124";
    let up = false;
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`${base2}/health`); if (r.ok) { up = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!up) throw new Error("server did not start");

    const r1 = await fetch(`${base2}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: "vendint3@gmail.com", password: "january1311" }),
    });
    record("security", "old hardcoded credentials rejected", r1.status === 401, `status=${r1.status}`);

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path.join(dataDir, "blossom.db"));
    const devCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='dev'").get().c;
    const totalCount = db.prepare("SELECT COUNT(*) c FROM users").get().c;
    db.close();
    record("security", "fresh DB has zero accounts (no fallback seed)", devCount === 0 && totalCount === 0, `users=${totalCount}, devs=${devCount}`);
  } finally {
    child?.kill();
    // On Windows, a killed child can keep the SQLite file handle open briefly;
    // retry the removal (with backoff) so the restore below never half-fails.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (hadDb) fs.renameSync(backup, dataDir);
  }
});

// ---------- Main suite with browser ----------
const server = await startServer();
const base = server.base;
const { browser, context } = await launchBrowser();

// 401 detection paths: Accept header (node fetch, no Sec-Fetch-Dest) and
// browser fetch (Sec-Fetch-Dest: empty, no Accept override)
await step("security", "/api/bookmarks returns 401 JSON without session (both detection paths)", async () => {
  const r1 = await fetch(`${base}/api/bookmarks`, { headers: { Accept: "application/json" } });
  const ct1 = r1.headers.get("content-type") || "";
  record("security", "401 via Accept: application/json", r1.status === 401 && ct1.includes("application/json"), `status=${r1.status} ct=${ct1}`);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`, { waitUntil: "load" });
  const r2 = await page.evaluate(async () => {
    const r = await fetch("/api/bookmarks");
    return { status: r.status, ct: r.headers.get("content-type") };
  });
  await ctx.close();
  record("security", "401 via Sec-Fetch-Dest: empty", r2.status === 401 && (r2.ct || "").includes("application/json"), `status=${r2.status} ct=${r2.ct}`);
});

// resolveInput: moved below (needs a logged-in page; module imports are auth-gated)

// ---------- Logged-in proxy + bookmarks/history flows ----------
try {
const stamp = Date.now();
const userEmail = `qa2-${stamp}@test.local`;
const pass = "qa-password-1";
let proxyPage = null;

await step("proxy", "setup: register + login fresh user", async () => {
  const page = await context.newPage();
  globalThis.__qaErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") globalThis.__qaErrors.push(`[${msg.type()}] ${msg.text().slice(0, 160)}`);
  });
  page.on("pageerror", (err) => globalThis.__qaErrors.push(`[pageerror] ${err.message.slice(0, 160)}`));
  await page.goto(`${base}/login`, { waitUntil: "load" });
  await page.click("#tab-register");
  await page.fill("#reg-name", "QA Two");
  await page.fill("#reg-email", userEmail);
  await page.fill("#reg-pass", pass);
  await page.click("#register-form .auth-submit");
  await page.waitForURL(`${base}/`, { timeout: 10000 });
  await page.waitForTimeout(4000); // SW + scramjet init + transport
  proxyPage = page;
  globalThis.__proxyPage = page;
  record("proxy", "setup: register + login fresh user", page.url() === `${base}/`);
});

// resolveInput unit checks against the live module
await step("search", "resolveInput: search term / bare domain / full URL", async () => {
  const page = globalThis.__proxyPage;
  const res = await page.evaluate(async () => {
    const m = await import("/js/search.js");
    return {
      searchTerm: m.resolveInput("cute cats"),
      bareDomain: m.resolveInput("example.com"),
      fullUrl: m.resolveInput("https://example.com/page?a=1"),
      empty: m.resolveInput("   "),
    };
  });
  const ok =
    res.searchTerm === "https://duckduckgo.com/?q=" + encodeURIComponent("cute cats") &&
    res.bareDomain === "https://example.com/" &&
    res.fullUrl === "https://example.com/page?a=1" &&
    res.empty === null;
  record("search", "resolveInput resolution rules", ok, JSON.stringify(res));
});

await step("proxy", "navigate to example.com through the proxy", async () => {
  const page = proxyPage;
  await page.fill("#search-input", "example.com");
  await page.press("#search-input", "Enter");
  await page.waitForSelector("#proxy-frame", { timeout: 30000 });
  await page.waitForTimeout(8000); // wasm + wisp + remote fetch
  const state = await page.evaluate(() => {
    const f = document.getElementById("proxy-frame");
    let docInfo = "inaccessible";
    try {
      const d = f.contentDocument;
      docInfo = d ? JSON.stringify({
        readyState: d.readyState,
        title: (d.title || "").slice(0, 60),
        htmlLen: (d.documentElement?.outerHTML || "").length,
        text: (d.body?.innerText || "").slice(0, 120),
      }) : "null-doc";
    } catch (e) { docInfo = "cross-origin: " + e.message; }
    return {
      src: (f?.src || "").slice(0, 120),
      toolbarVisible: !document.getElementById("proxy-toolbar").hidden,
      overlayHidden: document.getElementById("loading-overlay").hidden,
      docInfo,
    };
  });
  const errs = globalThis.__qaErrors || [];
  await shot(page, "10-proxy-example");
  record("proxy", "DEBUG frame state", true, JSON.stringify({ ...state, errs: errs.slice(-8) }));
  const ok =
    state.src.includes("/~/") &&
    state.toolbarVisible &&
    state.overlayHidden &&
    /Example Domain/i.test(state.docInfo);
  record("proxy", "example.com renders in proxy frame with toolbar", ok, JSON.stringify(state).slice(0, 400));
});

await step("proxy", "unreachable URL shows error overlay; Home button recovers", async () => {
  const page = proxyPage;
  await page.fill("#proxy-url-input", "qa-invalid-domain-9x8y7z.invalid");
  await page.press("#proxy-url-input", "Enter");
  await page.waitForTimeout(8000);
  const state = await page.evaluate(() => ({
    overlayVisible: !document.getElementById("error-overlay").hidden,
    detail: document.getElementById("error-detail").textContent.slice(0, 100),
  }));
  await shot(page, "11-proxy-error-overlay");
  record("proxy", "error overlay appears on bad URL", state.overlayVisible && state.detail.length > 0, JSON.stringify(state));

  await page.click("#error-home");
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    homeVisible: document.getElementById("home-view").style.display !== "none",
    frameGone: !document.getElementById("proxy-frame"),
    overlayHidden: document.getElementById("error-overlay").hidden,
  }));
  record("proxy", "Home button closes overlay and returns home", after.homeVisible && after.frameGone && after.overlayHidden, JSON.stringify(after));
});

await step("bookmarks", "bookmark via toolbar, persists across reload and re-login", async () => {
  const page = proxyPage;
  // Navigate from whichever search box is currently active (proxy URL bar if
  // a proxy session is already open, otherwise the home search).
  const inProxy = await page.evaluate(() => !!document.getElementById("proxy-frame") && document.getElementById("home-view").style.display === "none");
  if (inProxy) {
    await page.fill("#proxy-url-input", "example.com");
    await page.press("#proxy-url-input", "Enter");
  } else {
    await page.fill("#search-input", "example.com");
    await page.press("#search-input", "Enter");
  }
  await page.waitForSelector("#proxy-frame", { timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.click("#proxy-bookmark");
  await page.waitForTimeout(800);
  // The topbar is hidden while browsing; go home to reach the bookmarks panel.
  await page.click("#proxy-home");
  await page.waitForTimeout(600);
  await page.click("#btn-bookmarks");
  await page.waitForTimeout(500);
  const panelState = await page.evaluate(() => document.getElementById("bookmarks-list").innerText.slice(0, 200));
  await shot(page, "12-bookmarks-panel");
  record("bookmarks", "bookmark appears in panel after toolbar click", /example/i.test(panelState), panelState);

  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(3500);
  await page.click("#btn-bookmarks");
  await page.waitForTimeout(500);
  const afterReload = await page.evaluate(() => document.getElementById("bookmarks-list").innerText.slice(0, 200));
  record("bookmarks", "bookmark persists across reload", /example/i.test(afterReload), afterReload);

  await page.evaluate(async () => { await fetch("/auth/logout", { method: "POST" }); });
  await page.goto(`${base}/login`, { waitUntil: "load" });
  await page.fill("#login-email", userEmail);
  await page.fill("#login-pass", pass);
  await page.click("#login-form .auth-submit");
  await page.waitForURL(`${base}/`, { timeout: 10000 });
  await page.waitForTimeout(3500);
  await page.click("#btn-bookmarks");
  await page.waitForTimeout(500);
  const afterLogin = await page.evaluate(() => document.getElementById("bookmarks-list").innerText.slice(0, 200));
  record("bookmarks", "bookmark persists across logout/login (server-synced)", /example/i.test(afterLogin), afterLogin);
});

await step("history", "history records visit, clear empties client+server", async () => {
  const page = proxyPage;
  // Close any open side panel (Escape) first — an open panel covers the toolbar
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  // If still browsing (chrome hidden while proxying), go home first.
  const stillProxying = await page.evaluate(() => document.body.classList.contains("proxying"));
  if (stillProxying) {
    await page.click("#proxy-home");
    await page.waitForTimeout(600);
  }
  await page.click("#btn-history");
  await page.waitForTimeout(500);
  const hist = await page.evaluate(() => document.getElementById("history-list").innerText.slice(0, 300));
  await shot(page, "13-history-panel");
  record("history", "visit recorded in history panel", /example/i.test(hist), hist);

  await page.click("#clear-history");
  await page.waitForTimeout(800);
  const serverHist = await page.evaluate(async () => {
    const r = await fetch("/api/history", { headers: { Accept: "application/json" } });
    return await r.json();
  });
  const clientEmpty = await page.evaluate(() => document.getElementById("history-empty").hidden === false);
  record("history", "clear history empties client and server", Array.isArray(serverHist) && serverHist.length === 0 && clientEmpty, `server=${JSON.stringify(serverHist).slice(0, 100)}`);
});

await step("security", "API rejects javascript:, data:, and oversized URLs", async () => {
  const page = proxyPage;
  const results = await page.evaluate(async () => {
    const post = async (url) => {
      const r = await fetch("/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ url, title: "x" }),
      });
      return r.status;
    };
    return {
      jsUri: await post("javascript:alert(1)"),
      oversized: await post("https://" + "a".repeat(2100) + ".com"),
      dataUri: await post("data:text/html,<h1>hi</h1>"),
      valid: await post("https://example.com/valid"),
    };
  });
  const ok = results.jsUri === 400 && results.oversized === 400 && results.dataUri === 400 && results.valid === 200;
  record("security", "stored-URL validation at API level", ok, JSON.stringify(results));
});

} finally {
  const failed = summary();
  await browser.close();
  server.child.kill();
  process.exit(failed > 0 ? 1 : 0);
}


