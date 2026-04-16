// Browsing history — tracks proxied sites visited
// localStorage as fast cache, server-backed sync

const STORAGE_KEY = "blossom-history";
const MAX_ENTRIES = 200;

let history = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");

export function getHistory() { return history; }

export function addToHistory(url, title) {
  history = history.filter((h) => h.url !== url);
  history.unshift({ url, title: title || url, time: Date.now() });
  if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES;
  save();
  // Sync to server
  fetch("/api/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, title: title || "" }),
  }).catch(() => {});
}

export function updateHistoryTitle(url, title) {
  const entry = history.find((h) => h.url === url);
  if (entry && entry.title !== title) {
    entry.title = title;
    save();
    fetch("/api/history", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, title }),
    }).catch(() => {});
  }
}

export function clearHistory() {
  history = [];
  save();
  fetch("/api/history", { method: "DELETE" }).catch(() => {});
}

export async function syncHistoryFromServer() {
  try {
    const resp = await fetch("/api/history");
    if (!resp.ok) return;
    const data = await resp.json();
    history = data.map((h) => ({
      url: h.url,
      title: h.title || h.url,
      time: (h.visited_at || 0) * 1000,
    }));
    if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES;
    save();
  } catch {}
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}
