let gamesManifest = [];
let favorites = JSON.parse(localStorage.getItem("blossom-game-favs") || "[]");
let recentGames = JSON.parse(localStorage.getItem("blossom-game-recents") || "[]");
let activeTag = "all";
let searchQuery = "";

export async function loadGames() {
  try {
    const resp = await fetch("/games.json");
    gamesManifest = await resp.json();
  } catch {
    gamesManifest = [];
  }
  return gamesManifest;
}

export function getGames() { return gamesManifest; }
export function getFavorites() { return favorites; }
export function getRecentGames() { return recentGames; }
export function getGameById(id) { return gamesManifest.find((g) => g.id === id) || null; }

export function getAllTags() {
  const tags = new Set();
  for (const g of gamesManifest) {
    if (g.tags) g.tags.forEach((t) => tags.add(t));
  }
  return ["all", ...Array.from(tags).sort()];
}

export function filterGames(query, tag) {
  searchQuery = String(query || "").trim().toLowerCase();
  activeTag = tag || "all";
  const tagLc = String(activeTag).toLowerCase();

  return gamesManifest.filter((g) => {
    const matchTag = tagLc === "all" || (g.tags && g.tags.some((t) => t.toLowerCase() === tagLc));
    if (!matchTag) return false;
    if (!searchQuery) return true;
    const hay = [g.name, g.id, g.url, ...(g.tags || [])].join(" ").toLowerCase();
    return hay.includes(searchQuery);
  });
}

export function toggleFavorite(id) {
  const idx = favorites.indexOf(id);
  if (idx >= 0) {
    favorites.splice(idx, 1);
  } else {
    favorites.push(id);
  }
  localStorage.setItem("blossom-game-favs", JSON.stringify(favorites));
}

export function isFavorite(id) {
  return favorites.includes(id);
}

export function hydrateFavorites(ids) {
  if (!Array.isArray(ids)) return;
  favorites = ids.filter((id) => typeof id === "string");
  localStorage.setItem("blossom-game-favs", JSON.stringify(favorites));
}

export function hydrateRecents(list) {
  if (!Array.isArray(list)) return;
  recentGames = list.filter((r) => r && r.id).slice(0, 20);
  localStorage.setItem("blossom-game-recents", JSON.stringify(recentGames));
}

export function recordGamePlayed(game) {
  recentGames = recentGames.filter((r) => r.id !== game.id);
  recentGames.unshift({ id: game.id, name: game.name, time: Date.now() });
  if (recentGames.length > 20) recentGames.length = 20;
  localStorage.setItem("blossom-game-recents", JSON.stringify(recentGames));
}
