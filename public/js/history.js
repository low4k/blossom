// Browsing history — tracks proxied sites visited
// No existing proxy site does this
// All stored in localStorage

const STORAGE_KEY = "blossom-history";
const MAX_ENTRIES = 200;

let history = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");

export function getHistory() { return history; }

export function addToHistory(url, title) {
  // Remove duplicate if exists
  history = history.filter((h) => h.url !== url);
  history.unshift({
    url,
    title: title || url,
    time: Date.now(),
  });
  if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES;
  save();
}

export function clearHistory() {
  history = [];
  save();
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}
