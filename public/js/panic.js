

let panicKey = localStorage.getItem("blossom-panic-key") || "`";
let panicUrl = localStorage.getItem("blossom-panic-url") || "https://classroom.google.com";

export function setPanicKey(key) {
  panicKey = key;
  localStorage.setItem("blossom-panic-key", key);
}

export function setPanicUrl(url) {
  panicUrl = url;
  localStorage.setItem("blossom-panic-url", url);
}

export function getPanicKey() { return panicKey; }
export function getPanicUrl() { return panicUrl; }

export function initPanic() {
  document.addEventListener("keydown", (e) => {

    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
    if (e.key === panicKey) {
      e.preventDefault();
      window.location.replace(panicUrl);
    }
  });
}
