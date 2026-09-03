// Iteration 7: anti-CAPTCHA session vault round trip.
// Proves: watched-host cookies captured from the Scramjet jar into the server
// vault, then re-seeded into a FRESH jar after an IDB purge, so the target
// site sees the token again without a new challenge.
import http from "node:http";
import path from "node:path";
import { startServer, launchBrowser, trackErrors, record, summary, ARTIFACTS } from "./harness.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- mock "hostile" target site: sets a session cookie on first visit ---
let lastCookie = "(none)";
const cookieLog = [];
const target = http.createServer((req, res) => {
  lastCookie = req.headers.cookie || "";
  cookieLog.push(lastCookie);
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Set-Cookie": "NID=test-nid-123; Path=/; SameSite=Lax",
  });
  res.end("<!doctype html><title>Mock Site</title><h1>mock</h1>ok");
});
await new Promise((r) => target.listen(0, "127.0.0.1", r));
const targetPort = target.address().port;
const targetUrl = `http://127.0.0.1:${targetPort}/`;

// Env must be set BEFORE startServer so the spawned server process picks it up.
process.env.CAPTCHA_WATCH_HOSTS = `127.0.0.1:${targetPort}`;
process.env.WISP_ALLOW_PRIVATE = "1";        // test-only: allow proxying to local targets
process.env.CAPTCHA_REFRESH_SECONDS = "0";   // keep-alive tested separately
process.env.SOLVER_URL = "";                 // solver off by default

const server = await startServer();
const base = server.base;
const { browser, context } = await launchBrowser();
const page = await context.newPage();
trackErrors(page);

async function navToTarget(p, tag) {
  // When already browsing, the home search is hidden; use the proxy URL bar.
  const inProxy = await p.evaluate(() => !!document.getElementById("proxy-frame") && document.getElementById("home-view").style.display === "none");
  const input = inProxy ? "#proxy-url-input" : "#search-input";
  await p.fill(input, targetUrl);
  await p.press(input, "Enter");
  await p.waitForTimeout(1600);
}

try {
  await page.goto(`${base}/login`, { waitUntil: "load" });
  await page.fill("#login-email", "qa-dev@test.local");
  await page.fill("#login-pass", "qa-test-pass-1");
  await page.click("#login-form .auth-submit");
  await page.waitForURL(`${base}/`, { timeout: 10000 });
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => !!window.__blossomVault, null, { timeout: 10000 });
  record("vault", "client vault module active on home", true);

  // --- API guards ---
  const guards = await page.evaluate(async () => {
    const put = (host, body) =>
      fetch(`/api/captcha/vault/${encodeURIComponent(host)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
    const notWatched = await put("example.org", { cookies: [] });
    const badShape = await put("127.0.0.1", { cookies: [{ name: 42 }] });
    const tooMany = await put(
      "127.0.0.1",
      { cookies: Array(140).fill({ name: "x", value: "y" }) }
    );
    return { notWatched: notWatched.status, badShape: badShape.status, tooMany: tooMany.status };
  });
  record("vault", "rejects unwatched host / bad cookie shape / oversize batch",
    guards.notWatched === 400 && guards.badShape === 400 && guards.tooMany === 400,
    JSON.stringify(guards));

  // --- first proxied visit: cookie set by target should land in jar + vault ---
  await page.fill("#search-input", targetUrl);
  await page.press("#search-input", "Enter");
  await page.waitForSelector("#proxy-frame", { timeout: 15000 });

  // Poll: jar write -> SW capture -> vault POST can take a few seconds.
  let vaultAfterFirst = null;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.__blossomVault?.syncNow?.()).catch(() => {});
    await page.waitForTimeout(400);
    vaultAfterFirst = await page.evaluate(async () => {
      const r = await fetch("/api/captcha/vault", { headers: { Accept: "application/json" } });
      return r.ok ? await r.json() : null;
    });
    if ((vaultAfterFirst?.hosts?.["127.0.0.1"] || []).some((c) => c.name === "NID")) break;
  }
  const captured = vaultAfterFirst?.hosts?.["127.0.0.1"] || [];
  const hasNid = captured.some((c) => c.name === "NID" && c.value === "test-nid-123");
  record("vault", "watch-host cookie captured into server vault", hasNid,
    hasNid ? "NID vaulted" : `hosts=${JSON.stringify(Object.keys(vaultAfterFirst?.hosts || {}))} captured=${JSON.stringify(captured).slice(0, 200)}`);

  // --- same-session revisit: the jar is hot, so the cookie rides the wire ---
  // (This is the loop-breaker: user solves once, next requests reuse it.)
  await navToTarget(page, "revisit");
  await page.waitForTimeout(1200);
  const revisitSawCookie = cookieLog.some((c) => c.includes("NID=test-nid-123"));
  record("vault", "captured cookie reused on same-session revisit", revisitSawCookie,
    `cookieLog=${JSON.stringify(cookieLog)}`);

  console.log("[iter7] new-device simulation (fresh browser context)...");
  // --- simulate jar loss: a "new device" = fresh browser context (empty IDB,
  // no service worker) carrying only the auth session cookie. The vault
  // restore path must re-seed the jar so the target sees the cookie again.
  const authCookies = await context.cookies();
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx2.addCookies(authCookies);
  const page2 = await ctx2.newPage();

  await page2.goto(`${base}/`, { waitUntil: "load" });
  await page2.waitForFunction(() => !!window.__blossomVault, null, { timeout: 10000 });
  await page2.waitForTimeout(2000); // vault restore posts before navigation

  const jarAfterRestore = await page2.evaluate(async () => {
    try {
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === "$scramjet")) return "no-db";
      const db = await new Promise((res, rej) => { const r = indexedDB.open("$scramjet", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      if (!db.objectStoreNames.contains("cookies")) { db.close(); return "no-store"; }
      const row = await new Promise((res) => { const g = db.transaction("cookies", "readonly").objectStore("cookies").get("cookies"); g.onsuccess = () => res(g.result || {}); g.onerror = () => res({}); });
      db.close();
      return row;
    } catch (e) { return "ex:" + e.message; }
  });
  const restoreOk = JSON.stringify(jarAfterRestore).includes("test-nid-123");
  record("vault", "vault cookies re-seeded into fresh jar after 'new device'", restoreOk,
    typeof jarAfterRestore === "string" ? jarAfterRestore : JSON.stringify(jarAfterRestore).slice(0, 160));

  // --- second visit: in a fresh context the first nav can outrace jar
  // hydration (scramjet-alpha), so navigate until a request carries the
  // cookie — within a few tries the re-seeded jar must deliver on the wire.
  console.log("[iter7] fresh-context visits until cookie rides the wire...");
  const lenBefore = cookieLog.length;
  let freshWireOk = false;
  for (let i = 0; i < 4 && !freshWireOk; i++) {
    await navToTarget(page2, `fresh-${i}`);
    await page2.waitForTimeout(1200);
    freshWireOk = cookieLog.slice(lenBefore).some((c) => c.includes("NID=test-nid-123"));
  }
  record("vault", "restored cookie reaches target from fresh context", freshWireOk,
    `cookieLog=${JSON.stringify(cookieLog)}`);

  // --- event + status endpoints ---
  console.log("[iter7] event + status...");
  const eventResult = await page.evaluate(async () => {
    const ev = await fetch("/api/captcha/event?solve=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "www.google.com", kind: "google", url: "https://www.google.com/sorry/index" }),
    });
    const evJson = await ev.json();
    const st = await fetch("/api/captcha/status", { headers: { Accept: "application/json" } });
    const stJson = await st.json();
    return { evStatus: ev.status, solver: evJson.solver, hosts: stJson.hosts.length, events: stJson.events };
  });
  const googleSeen = (eventResult.events || []).some((e) => e.host === "www.google.com" && e.kind === "google");
  record("vault", "challenge event logged, solver correctly reports disabled",
    eventResult.evStatus === 200 && (eventResult.solver === "disabled" || eventResult.solver === "idle") && googleSeen,
    JSON.stringify(eventResult).slice(0, 200));

  // --- vault clear ---
  console.log("[iter7] vault clear...");
  const cleared = await page.evaluate(async () => {
    await fetch("/api/captcha/vault", { method: "DELETE" });
    const r = await fetch("/api/captcha/vault", { headers: { Accept: "application/json" } });
    const j = await r.json();
    return Object.keys(j.hosts || {}).length;
  });
  record("vault", "vault clear empties saved sessions", cleared === 0, `remaining=${cleared}`);
} finally {
  console.log("\n=== iter7 anti-CAPTCHA vault complete ===");
  await browser.close();
  target.close();
  server.child.kill();
  process.exit(summary() > 0 ? 1 : 0);
}
