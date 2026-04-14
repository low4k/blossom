// Games section — searchable, categorized, with favorites and recents
// All state stored in localStorage

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

export function getAllTags() {
  const tags = new Set();
  for (const g of gamesManifest) {
    if (g.tags) g.tags.forEach((t) => tags.add(t));
  }
  return ["all", ...Array.from(tags).sort()];
}

export function filterGames(query, tag) {
  searchQuery = query.toLowerCase();
  activeTag = tag;

  return gamesManifest.filter((g) => {
    const matchTag = tag === "all" || (g.tags && g.tags.includes(tag));
    const matchSearch = !searchQuery ||
      g.name.toLowerCase().includes(searchQuery) ||
      (g.tags && g.tags.some((t) => t.includes(searchQuery)));
    return matchTag && matchSearch;
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

export function recordGamePlayed(game) {
  // Remove if already in recents, add to front
  recentGames = recentGames.filter((r) => r.id !== game.id);
  recentGames.unshift({ id: game.id, name: game.name, time: Date.now() });
  // Keep max 20
  if (recentGames.length > 20) recentGames.length = 20;
  localStorage.setItem("blossom-game-recents", JSON.stringify(recentGames));
}
