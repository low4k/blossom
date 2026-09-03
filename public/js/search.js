

// DuckDuckGo renders cleanly through the proxy; Google's JS shell currently
// stalls under scramjet-alpha (kept as an opt-in choice).
let searchTemplate = localStorage.getItem("blossom-search-engine") || "https://duckduckgo.com/?q=%s";

export function setSearchEngine(template) {
  searchTemplate = template;
  localStorage.setItem("blossom-search-engine", template);
}

export function getSearchEngine() {
  return searchTemplate;
}

export function resolveInput(input) {
  input = input.trim();
  if (!input) return null;

  try {
    const url = new URL(input);
    return url.toString();
  } catch {}

  try {
    const url = new URL(`https://${input}`);
    if (url.hostname.includes(".")) return url.toString();
  } catch {}

  return searchTemplate.replace("%s", encodeURIComponent(input));
}
