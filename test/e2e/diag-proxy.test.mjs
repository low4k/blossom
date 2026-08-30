// Focused diagnostic: what error does the SW hit when proxying?
import { startServer, launchBrowser, summary } from "./harness.mjs";

const server = await startServer();
const base = server.base;
const { browser, context } = await launchBrowser();

try {
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message.slice(0, 200)}`));

  await page.goto(`${base}/login`, { waitUntil: "load" });
  await page.fill("#login-email", "qa-dev@test.local");
  await page.fill("#login-pass", "qa-test-pass-1");
  await page.click("#login-form .auth-submit");
  await page.waitForURL(`${base}/`, { timeout: 10000 });
  await page.waitForTimeout(6000);

  const diag = await page.evaluate(async () => {
    const out = {};
    out.swController = !!navigator.serviceWorker.controller;
    const regs = await navigator.serviceWorker.getRegistrations();
    out.regCount = regs.length;
    out.crossOriginIsolated = self.crossOriginIsolated;

    // Direct transport test: bypass scramjet, use BareMux + epoxy directly
    try {
      const conn = new BareMux.BareMuxConnection("/assets/worker/worker.js");
      await conn.setTransport("/assets/net/index.mjs", [{ wisp: `ws://${location.host}/ws/` }]);
      const client = new BareMux.BareClient();
      const r = await client.fetch("https://example.com/");
      out.directStatus = r.status;
      out.directBody = (await r.text()).slice(0, 100);
    } catch (e) {
      out.directErr = String(e && e.message || e).slice(0, 200);
    }

    try {
      const r = await fetch("/~/https%3A%2F%2Fexample.com%2F");
      out.proxyStatus = r.status;
      out.proxyBody = (await r.text()).slice(0, 300);
    } catch (e) { out.proxyFetchErr = String(e).slice(0, 200); }
    return out;
  });

  // Bad-URL diagnostic: capture the response the SW serves for an unreachable domain
  page.on("response", async (res) => {
    if (res.status() >= 400 && res.url().includes("/~/")) {
      let body = "";
      try { body = (await res.text()).slice(0, 300); } catch {}
      logs.push(`[RESP ${res.status()}] ${res.url().slice(0, 80)} :: ${body}`);
    }
  });
  const badDiag = await page.evaluate(async () => {
    const out = {};
    try {
      const r = await fetch("/~/https%3A%2F%2Fqa-invalid-domain-9x8y7z.invalid%2F");
      out.status = r.status;
      out.body = (await r.text()).slice(0, 400);
      out.ct = r.headers.get("content-type");
    } catch (e) { out.err = String(e).slice(0, 200); }
    return out;
  });
  // Bad-URL diagnostic: drive the real UI flow and dump the frame document
  await page.fill("#search-input", "qa-invalid-domain-9x8y7z.invalid");
  await page.press("#search-input", "Enter");
  await page.waitForSelector("#proxy-frame", { timeout: 30000 });
  await page.waitForTimeout(5000);
  const frameDump = await page.evaluate(() => {
    const f = document.getElementById("proxy-frame");
    let doc = "inaccessible";
    try {
      const d = f.contentDocument;
      doc = d ? JSON.stringify({
        readyState: d.readyState,
        htmlLen: (d.documentElement?.outerHTML || "").length,
        outer: (d.documentElement?.outerHTML || "").slice(0, 300),
      }) : "null-doc";
    } catch (e) { doc = "x-origin: " + e.message; }
    return { src: f.src.slice(0, 100), doc, overlayVisible: !document.getElementById("error-overlay").hidden };
  });
  console.log("FRAME DUMP:", JSON.stringify(frameDump, null, 2));
  await page.close();
} finally {
  summary();
  await browser.close();
  server.child.kill();
}
