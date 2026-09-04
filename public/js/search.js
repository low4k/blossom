
// DuckDuckGo renders cleanly through the proxy; Google's JS shell currently
// stalls under scramjet-alpha (kept as an opt-in choice).
export const SEARCH_ENGINES = [
  { label: "DuckDuckGo", short: "DDG", template: "https://duckduckgo.com/?q=%s" },
  { label: "Google", short: "Google", template: "https://www.google.com/search?q=%s" },
  { label: "Bing", short: "Bing", template: "https://www.bing.com/search?q=%s" },
];

const BANGS = {
  yt: { home: "https://www.youtube.com/", search: "https://www.youtube.com/results?search_query=%s" },
  w: { home: "https://en.wikipedia.org/", search: "https://en.wikipedia.org/wiki/Special:Search?search=%s" },
  r: { home: "https://www.reddit.com/", search: "https://www.reddit.com/search/?q=%s" },
  gh: { home: "https://github.com/", search: "https://github.com/search?q=%s" },
  so: { home: "https://stackoverflow.com/", search: "https://stackoverflow.com/search?q=%s" },
  sp: { home: "https://open.spotify.com/", search: "https://open.spotify.com/search/%s" },
  maps: { home: "https://www.google.com/maps", search: "https://www.google.com/maps/search/%s" },
  g: { home: "https://www.google.com/", search: "https://www.google.com/search?q=%s" },
  ddg: { home: "https://duckduckgo.com/", search: "https://duckduckgo.com/?q=%s" },
};

let searchTemplate = localStorage.getItem("blossom-search-engine") || "https://duckduckgo.com/?q=%s";

export function setSearchEngine(template) {
  searchTemplate = template;
  localStorage.setItem("blossom-search-engine", template);
}

export function getSearchEngine() {
  return searchTemplate;
}

export function getSearchEngineInfo() {
  return SEARCH_ENGINES.find((e) => e.template === searchTemplate) || SEARCH_ENGINES[0];
}

export function cycleSearchEngine() {
  const i = SEARCH_ENGINES.findIndex((e) => e.template === searchTemplate);
  const next = SEARCH_ENGINES[(i + 1) % SEARCH_ENGINES.length];
  setSearchEngine(next.template);
  return next;
}

export function engineLabel(template = searchTemplate) {
  return (SEARCH_ENGINES.find((e) => e.template === template) || SEARCH_ENGINES[0]).label;
}

function cleanQuery(input) {
  return String(input || "").trim().replace(/^["']+|["']+$/g, "").trim();
}

function resolveBang(input) {
  const m = input.match(/^!([a-z]{1,8})(?:\s+|$)(.*)$/i);
  if (!m) return null;
  const bang = BANGS[m[1].toLowerCase()];
  if (!bang) return null;
  const rest = m[2].trim();
  if (!rest) return bang.home;
  return bang.search.replace("%s", encodeURIComponent(rest));
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/.*)?$/;
const LOCALHOST = /^(localhost)(?::\d+)?(?:\/.*)?$/i;

export function looksLikeDestination(input) {
  const q = cleanQuery(input);
  if (!q || /\s/.test(q)) return false;
  if (q.startsWith("!")) return Boolean(resolveBang(q));
  try {
    const u = new URL(q);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {}
  if (LOCALHOST.test(q) || IPV4.test(q)) return true;
  try {
    const u = new URL(`https://${q}`);
    return u.hostname.includes(".");
  } catch {
    return false;
  }
}

export function resolveInput(input) {
  input = cleanQuery(input);
  if (!input) return null;

  const bang = resolveBang(input);
  if (bang) return bang;

  try {
    const url = new URL(input);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {}

  if (LOCALHOST.test(input) || IPV4.test(input)) {
    try { return new URL(`http://${input}`).toString(); } catch {}
  }

  try {
    const url = new URL(`https://${input}`);
    if (url.hostname.includes(".")) return url.toString();
  } catch {}

  return searchTemplate.replace("%s", encodeURIComponent(input));
}

export { BANGS };
