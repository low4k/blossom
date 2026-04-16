// Bookmarks — save proxied sites to revisit later
// localStorage as fast cache, server-backed sync for persistence across devices

const STORAGE_KEY = "blossom-bookmarks";

let bookmarks = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");

export function getBookmarks() { return bookmarks; }

export function addBookmark(url, title) {
  if (bookmarks.some((b) => b.url === url)) return;
  bookmarks.unshift({ url, title: title || url, time: Date.now() });
  save();
  // Sync to server (fire-and-forget)
  fetch("/api/bookmarks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, title: title || "" }),
  }).catch(() => {});
}

export function removeBookmark(url) {
  bookmarks = bookmarks.filter((b) => b.url !== url);
  save();
  fetch("/api/bookmarks", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  }).catch(() => {});
}

export function isBookmarked(url) {
  return bookmarks.some((b) => b.url === url);
}

// Pull from server on login — server is source of truth
export async function syncBookmarksFromServer() {
  try {
    const resp = await fetch("/api/bookmarks");
    if (!resp.ok) return;
    const data = await resp.json();
    bookmarks = data.map((b) => ({
      url: b.url,
      title: b.title || b.url,
      time: (b.created_at || 0) * 1000,
    }));
    save();
  } catch {}
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
}
