// Generates flat branded tiles (SVG) for catalog entries that lack scrapeable
// art. Run: node scripts/gen-tiles.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const TILES = [
  // games — hand tiles
  { kind: "games", id: "snake-html",    name: "Snake",                    bg: "#14532d", fg: "#86efac" },
  { kind: "games", id: "breakout-html", name: "Breakout",                 bg: "#1e293b", fg: "#f8a5c2" },
  { kind: "games", id: "memory-html",   name: "Memory Match",             bg: "#312e81", fg: "#c7d2fe" },
  { kind: "games", id: "slope",         name: "Slope",                    bg: "#0f172a", fg: "#22d3ee" },
  { kind: "games", id: "cookie-clicker",name: "Cookie Clicker",           bg: "#7c2d12", fg: "#fdba74" },
  { kind: "games", id: "minecraft-classic", name: "Minecraft Classic",    bg: "#3f6212", fg: "#bef264" },
  { kind: "games", id: "tunnel-rush",   name: "Tunnel Rush",              bg: "#4c0519", fg: "#fda4af" },
  { kind: "games", id: "drift-hunters", name: "Drift Hunters",            bg: "#0c4a6e", fg: "#7dd3fc" },
  { kind: "games", id: "snow-rider-3d", name: "Snow Rider 3D",            bg: "#155e75", fg: "#e0f2fe" },
  { kind: "games", id: "jstris",        name: "Jstris",                   bg: "#1e1b4b", fg: "#a5b4fc" },
  { kind: "games", id: "1v1lol",        name: "1v1.LOL",                  bg: "#811d1d", fg: "#fecaca" },
  // apps — hand tiles
  { kind: "apps", id: "whatsapp", name: "WhatsApp",     bg: "#14532d", fg: "#86efac" },
  { kind: "apps", id: "gdocs",    name: "Google Docs",  bg: "#1e3a8a", fg: "#bfdbfe" },
  { kind: "apps", id: "gdrive",   name: "Google Drive", bg: "#065f46", fg: "#a7f3d0" },
  { kind: "apps", id: "gmail",    name: "Gmail",        bg: "#7f1d1d", fg: "#fecaca" },
  { kind: "apps", id: "maps",     name: "Google Maps",  bg: "#0f766e", fg: "#99f6e4" },
  { kind: "apps", id: "github", name: "GitHub", bg: "#111827", fg: "#e5e7eb" },
  { kind: "apps", id: "reddit", name: "Reddit", bg: "#7c2d12", fg: "#fdba74" },
  { kind: "apps", id: "mdn", name: "MDN", bg: "#0f172a", fg: "#93c5fd" },
  { kind: "apps", id: "archive", name: "Archive", bg: "#1e293b", fg: "#fde68a" },
  { kind: "apps", id: "lichess", name: "Lichess", bg: "#171717", fg: "#f5f5f5" },
  { kind: "apps", id: "scratch", name: "Scratch", bg: "#9a3412", fg: "#fdba74" },
  { kind: "apps", id: "soundcloud", name: "SoundCloud", bg: "#7c2d12", fg: "#fed7aa" },
  { kind: "apps", id: "stackoverflow", name: "Stack Overflow", bg: "#78350f", fg: "#fbbf24" },
  { kind: "apps", id: "duckduckgo", name: "DuckDuckGo", bg: "#14532d", fg: "#86efac" },
  { kind: "apps", id: "diagrams", name: "diagrams.net", bg: "#1e3a8a", fg: "#93c5fd" },
  { kind: "apps", id: "regex101", name: "Regex101", bg: "#3f1d0f", fg: "#fdba74" },
  { kind: "apps", id: "codepen", name: "CodePen", bg: "#18181b", fg: "#e4e4e7" },
  { kind: "apps", id: "itch", name: "itch.io", bg: "#881337", fg: "#fda4af" },
  { kind: "apps", id: "genius", name: "Genius", bg: "#365314", fg: "#d9f99d" },
  { kind: "apps", id: "bandcamp", name: "Bandcamp", bg: "#164e63", fg: "#a5f3fc" },
  { kind: "apps", id: "w3schools", name: "W3Schools", bg: "#14532d", fg: "#bbf7d0" },
  { kind: "apps", id: "freecodecamp", name: "freeCodeCamp", bg: "#0f172a", fg: "#99f6e4" },
  { kind: "apps", id: "pixlr", name: "Pixlr", bg: "#1e1b4b", fg: "#c4b5fd" },
  { kind: "apps", id: "mermaid", name: "Mermaid", bg: "#134e4a", fg: "#99f6e4" },
];

const TEMPLATE = (t) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 380">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bg}"/>
      <stop offset="1" stop-color="#0b0b12"/>
    </linearGradient>
  </defs>
  <rect width="640" height="380" fill="url(#g)"/>
  <circle cx="560" cy="50" r="120" fill="${t.fg}" opacity="0.08"/>
  <circle cx="60" cy="340" r="90" fill="${t.fg}" opacity="0.06"/>
  <text x="48" y="200" font-family="Georgia, 'Cormorant Garamond', serif" font-size="54" font-weight="600" fill="${t.fg}" letter-spacing="1">${esc(t.name)}</text>
  <text x="48" y="236" font-family="system-ui, sans-serif" font-size="15" fill="${t.fg}" opacity="0.75" letter-spacing="4">BLOSSOM</text>
</svg>`;

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

for (const t of TILES) {
  const dir = path.join(ROOT, "public", "imgs", t.kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${t.id}.svg`), TEMPLATE(t));
  console.log(`${t.kind}/${t.id}.svg`);
}
console.log(`generated ${TILES.length} tiles`);
