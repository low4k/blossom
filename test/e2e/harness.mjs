// Shared E2E harness: boots the server with .env, manages a Playwright browser,
// captures console/page/request errors, and saves screenshots.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, "..", "..");
export const ARTIFACTS = path.join(__dirname, "artifacts");

export function loadEnv(file = path.join(ROOT, ".env")) {
  const env = { ...process.env };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}

export async function startServer() {
  const env = loadEnv();
  const port = env.PORT || "8123";
  const child = spawn("node", ["server.js"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => console.error("[server:err]", String(d)));

  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return { child, base };
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error("Server failed to start within 20s");
}

export async function launchBrowser() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ["--allow-popups"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  return { browser, context };
}

// Collects console errors/warnings, page errors, and failed responses per page.
export function trackErrors(page) {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      errors.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
  page.on("response", (res) => {
    if (res.status() >= 500) errors.push(`[http ${res.status()}] ${res.url()}`);
  });
  return errors;
}

export async function shot(page, name) {
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`), fullPage: false });
}

const results = [];
export function record(area, name, pass, detail = "") {
  results.push({ area, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  [${area}] ${name}${detail ? " — " + detail : ""}`);
}

export function summary() {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed, ${failed.length} failed ===`);
  for (const f of failed) console.log(`FAIL [${f.area}] ${f.name} — ${f.detail}`);
  return failed.length;
}
