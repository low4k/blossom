// Probe each games.json / apps.json URL through the catalog click path.
import { startServer, launchBrowser, trackErrors } from "./harness.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

const argIds = process.argv.slice(2);
const games = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "games.json"), "utf8"))
  .filter((g) => !argIds.length || argIds.includes(g.id));
const apps = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "apps.json"), "utf8"))
  .filter((a) => !argIds.length || argIds.includes(a.id));

const server = await startServer();
const base = server.base;
const { browser, context } = await launchBrowser();
const page = await context.newPage();
trackErrors(page);

await page.goto(`${base}/login`, { waitUntil: "load" });
await page.fill("#login-email", "qa-dev@test.local");
await page.fill("#login-pass", "qa-test-pass-1");
await page.click("#login-form .auth-submit");
await page.waitForURL(`${base}/`, { timeout: 15000 });
await page.waitForTimeout(3500);

async function goCatalog(kind) {
  await page.evaluate(() => {
    document.getElementById("error-overlay")?.setAttribute("hidden", "");
    document.getElementById("proxy-home")?.click();
  });
  await page.waitForTimeout(400);
  const btn = kind === "game" ? "#btn-games" : "#btn-apps";
  await page.click(btn);
  await page.waitForTimeout(500);
}

async function readFrame() {
  const overlayOn = await page.evaluate(() => {
    const o = document.getElementById("error-overlay");
    return !!(o && !o.hidden);
  });
  const src = await page.evaluate(() => document.getElementById("proxy-frame")?.src || "");
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  let title = "";
  let text = "";
  for (const f of frames) {
    try {
      title = await f.title();
      text = (await f.locator("body").innerText({ timeout: 1500 }).catch(() => "")) || "";
      if (title || text) break;
    } catch {}
  }
  return { overlayOn, src, title, text: text.slice(0, 500), frameCount: frames.length };
}

function classify(snap, local) {
  if (local) return { ok: true, reason: "local-frame" };
  if (snap.overlayOn) return { ok: false, reason: "error-overlay" };
  if (snap.title === "Scramjet") return { ok: false, reason: "scramjet-error" };
  const t = `${snap.title} ${snap.text}`.toLowerCase();
  if (/blossom-sw-error|failed to fetch|err_/.test(t)) return { ok: false, reason: "sw-error" };
  if (/unusual traffic|attention required|just a moment|enable javascript to/.test(t)) {
    return { ok: false, reason: "challenge-or-shell" };
  }
  if (snap.src.includes("/~/") && (snap.text.length > 80 || snap.title.length > 1)) {
    return { ok: true, reason: `ok:${snap.title || snap.text.slice(0, 40)}` };
  }
  if (snap.src.includes("/~/")) return { ok: false, reason: "blank-or-thin" };
  return { ok: false, reason: "no-frame" };
}

async function probe(entry, kind) {
  const local = entry.url.startsWith("/");
  await goCatalog(kind);
  const card = page.locator(`.game-card[data-id="${entry.id}"]`).first();
  if (!(await card.count())) {
    return { id: entry.id, kind, url: entry.url, ok: false, reason: "card-missing" };
  }
  await card.click();
  try {
    await page.waitForSelector("#proxy-frame", { timeout: 12000 });
  } catch {
    return { id: entry.id, kind, url: entry.url, ok: false, reason: "no-frame" };
  }
  await page.waitForTimeout(local ? 800 : 4500);
  const snap = await readFrame();
  const verdict = classify(snap, local);
  return { id: entry.id, kind, url: entry.url, ...verdict, title: snap.title, src: snap.src.slice(0, 80) };
}

const results = [];
for (const g of games) {
  const r = await probe(g, "game");
  results.push(r);
  console.log(`${r.ok ? "PASS" : "FAIL"}  [game] ${r.id}  ${r.reason}`);
}
for (const a of apps) {
  const r = await probe(a, "app");
  results.push(r);
  console.log(`${r.ok ? "PASS" : "FAIL"}  [app] ${r.id}  ${r.reason}`);
}

const out = path.join(__dirname, "artifacts", "catalog-probe.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(results, null, 2));
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} catalog entries loaded`);

await browser.close();
server.child.kill();
process.exit(0);
