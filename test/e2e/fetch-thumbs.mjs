// One-off: downloads a thumbnail for every catalog entry (og:image >
// apple-touch-icon > favicon), saving into public/imgs/{games,apps}/.
// Regenerate anytime with: node test/e2e/fetch-thumbs.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchText(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": UA, "Accept": "text/html" } });
    const buf = await res.arrayBuffer();
    return { html: Buffer.from(buf).slice(0, 600 * 1024).toString("utf8"), finalUrl: res.url };
  } finally { clearTimeout(t); }
}

function pickImage(html, base) {
  const og =
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i.exec(html);
  const tw = /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)/i.exec(html);
  const appleTouch = /<link[^>]+rel=["']apple-touch-icon(?:-precomposed)?["'][^>]+href=["']([^"']+)/i.exec(html);
  const icon = /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)/i.exec(html);
  return og?.[1] || tw?.[1] || appleTouch?.[1] || icon?.[1] || null;
}

async function downloadImage(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": UA, "Referer": new URL(url).origin } });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 80) return null;
    if (buf.length > 8 * 1024 * 1024) return null;
    const ext = type.includes("png") ? ".png"
      : type.includes("webp") ? ".webp"
      : type.includes("svg") ? ".svg"
      : type.includes("gif") ? ".gif"
      : ".jpg";
    return { buf, ext, bytes: buf.length };
  } finally { clearTimeout(t); }
}

async function one(kind, entry) {
  if (entry.url.startsWith("/")) return { id: entry.id, status: "skip-local" };
  try {
    const page = await fetchText(entry.url);
    const imgPath = pickImage(page.html, entry.url);
    if (!imgPath) return { id: entry.id, status: "no-image" };
    const abs = new URL(imgPath, page.finalUrl).href;
    const got = await downloadImage(abs);
    if (!got) return { id: entry.id, status: "download-failed" };
    const dir = path.join(ROOT, "public", "imgs", kind);
    fs.mkdirSync(dir, { recursive: true });
    // clean any previous file of other ext
    for (const f of fs.readdirSync(dir)) if (f.startsWith(entry.id + ".")) fs.rmSync(path.join(dir, f));
    const out = path.join(dir, `${entry.id}${got.ext}`);
    fs.writeFileSync(out, got.buf);
    return { id: entry.id, status: "ok", file: `imgs/${kind}/${entry.id}${got.ext}`, bytes: got.bytes };
  } catch (e) {
    return { id: entry.id, status: "error", err: String(e).slice(0, 80) };
  }
}

const kinds = [
  ["games", JSON.parse(fs.readFileSync(path.join(ROOT, "public", "games.json"), "utf8"))],
  ["apps", JSON.parse(fs.readFileSync(path.join(ROOT, "public", "apps.json"), "utf8"))],
];

const results = [];
for (const [kind, list] of kinds) {
  // small concurrency
  const queue = [...list];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const e = queue.shift();
      const r = await one(kind, e);
      results.push({ kind, ...r });
      console.log(kind.padEnd(6), e.id.padEnd(18), r.status, r.file ? `(${r.bytes}b)` : r.err || "");
    }
  });
  await Promise.all(workers);
}

const bad = results.filter((r) => r.status !== "ok" && r.status !== "skip-local");
console.log(`\nDONE: ${results.filter((r) => r.status === "ok").length}/${results.length} downloaded; ${bad.length} need hand art:`);
for (const b of bad) console.log(" -", b.kind, b.id, b.status);
