// App catalog — same card/search/fav/recents model as games.js.
let appsManifest = [];
let favorites = JSON.parse(localStorage.getItem("blossom-app-favs") || "[]");
let recentApps = JSON.parse(localStorage.getItem("blossom-app-recents") || "[]");
let searchQuery = "";
let activeTag = "all";

export async function loadApps() {
  try {
    const resp = await fetch("/apps.json");
    appsManifest = await resp.json();
  } catch {
    appsManifest = [];
  }
  return appsManifest;
}

export function getApps() {
  return appsManifest;
}

export function getAppById(id) {
  return appsManifest.find((a) => a.id === id) || null;
}

export function getAppFavorites() {
  return favorites;
}

export function getRecentApps() {
  return recentApps;
}

export function getAppTags() {
  const tags = new Set();
  for (const a of appsManifest) {
    if (a.tags) a.tags.forEach((t) => tags.add(t));
  }
  return ["all", ...Array.from(tags).sort()];
}

export function filterApps(query, tag) {
  searchQuery = String(query || "").trim().toLowerCase();
  activeTag = tag || "all";
  const tagLc = String(activeTag).toLowerCase();
  return appsManifest.filter((a) => {
    const matchTag = tagLc === "all" || (a.tags && a.tags.some((t) => t.toLowerCase() === tagLc));
    if (!matchTag) return false;
    if (!searchQuery) return true;
    const hay = [a.name, a.id, a.url, ...(a.tags || [])].join(" ").toLowerCase();
    return hay.includes(searchQuery);
  });
}

export function toggleAppFavorite(id) {
  const idx = favorites.indexOf(id);
  if (idx >= 0) favorites.splice(idx, 1);
  else favorites.push(id);
  localStorage.setItem("blossom-app-favs", JSON.stringify(favorites));
}

export function isAppFavorite(id) {
  return favorites.includes(id);
}

export function recordAppUsed(app) {
  recentApps = recentApps.filter((r) => r.id !== app.id);
  recentApps.unshift({ id: app.id, name: app.name, time: Date.now() });
  if (recentApps.length > 20) recentApps.length = 20;
  localStorage.setItem("blossom-app-recents", JSON.stringify(recentApps));
}

export function hydrateAppFavorites(ids) {
  if (!Array.isArray(ids)) return;
  favorites = ids.filter((id) => typeof id === "string");
  localStorage.setItem("blossom-app-favs", JSON.stringify(favorites));
}

export function hydrateAppRecents(list) {
  if (!Array.isArray(list)) return;
  recentApps = list.filter((r) => r && r.id).slice(0, 20);
  localStorage.setItem("blossom-app-recents", JSON.stringify(recentApps));
}
