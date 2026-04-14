// Bookmarks — save proxied sites to revisit later
// All stored in localStorage

const STORAGE_KEY = "blossom-bookmarks";

let bookmarks = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");

export function getBookmarks() { return bookmarks; }

export function addBookmark(url, title) {
  // Don't duplicate
  if (bookmarks.some((b) => b.url === url)) return;
  bookmarks.unshift({
    url,
    title: title || url,
    time: Date.now(),
  });
  save();
}

export function removeBookmark(url) {
  bookmarks = bookmarks.filter((b) => b.url !== url);
  save();
}

export function isBookmarked(url) {
  return bookmarks.some((b) => b.url === url);
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
}
