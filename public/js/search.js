// URL/search resolution — determines if input is a URL or search query

let searchTemplate = localStorage.getItem("blossom-search-engine") || "https://www.google.com/search?q=%s";

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

  // Already a full URL
  try {
    const url = new URL(input);
    return url.toString();
  } catch {}

  // Looks like a domain (has a dot)
  try {
    const url = new URL(`https://${input}`);
    if (url.hostname.includes(".")) return url.toString();
  } catch {}

  // Treat as search query
  return searchTemplate.replace("%s", encodeURIComponent(input));
}
