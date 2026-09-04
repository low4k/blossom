
const PATHS = {
  home: "/",
  games: "/games",
  apps: "/apps",
  ai: "/ai",
  watch: "/watch",
};

const BY_PATH = {
  "/": "home",
  "/games": "games",
  "/apps": "apps",
  "/ai": "ai",
  "/watch": "watch",
};

export function normalizePath(pathname) {
  const p = String(pathname || "/").replace(/\/+$/, "");
  return p || "/";
}

export function parseRoute(pathname, search = "") {
  const path = normalizePath(pathname);
  const name = BY_PATH[path] || "home";
  const qs = name === "watch" ? String(search || "") : "";
  return { name, path: PATHS[name], search: qs };
}

export function hrefFor(name, search = "") {
  const path = PATHS[name] || "/";
  if (name === "watch" && search) return path + (search.startsWith("?") ? search : `?${search}`);
  return path;
}

export function safeNextPath(raw) {
  const value = String(raw || "").trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  let u;
  try { u = new URL(value, "https://blossom.invalid"); } catch { return "/"; }
  const parsed = parseRoute(u.pathname, u.search);
  if (parsed.name === "home") return "/";
  return hrefFor(parsed.name, parsed.search);
}

export { PATHS };
