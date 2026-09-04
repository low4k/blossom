

import { registerSW } from "./register-sw.js";
import { resolveInput, getSearchEngineInfo, cycleSearchEngine } from "./search.js";
import { applyCloak, launchAboutBlankCloak } from "./cloak.js";
import { initPanic } from "./panic.js";
import { loadGames, filterGames, getAllTags, toggleFavorite, isFavorite, recordGamePlayed, getRecentGames, getFavorites, getGameById, hydrateFavorites, hydrateRecents, getGames } from "./games.js";
import { getBookmarks, addBookmark, removeBookmark, isBookmarked, syncBookmarksFromServer } from "./bookmarks.js";
import { getHistory, addToHistory, clearHistory, updateHistoryTitle, syncHistoryFromServer } from "./history.js";
import { initMirrors } from "./mirrors.js";
import { initSettings } from "./settings.js";
import { initVaultSync } from "./vault.js";
import { startSaveSession, endSaveSession, restoreSave, saveIdForUrl, flushSaveKeepalive, syncSave, bindSaveFrame, loadCatalogPrefs, scheduleCatalogPrefs } from "./saves.js";
import { loadApps, getApps, filterApps, getAppTags, toggleAppFavorite, isAppFavorite, recordAppUsed, getRecentApps, getAppFavorites, getAppById, hydrateAppFavorites, hydrateAppRecents } from "./apps.js";
import { bindOmnibox } from "./suggest.js";
import { rewriteDestination, skipSaveFor, isWatchPath } from "./dest.js";
import { wireAi, onAiRoute } from "./ai-ui.js";
import { parseRoute, hrefFor } from "./routes.js";
import { spring, withViewTransition } from "./motion.js";
import { createWatchController } from "./yt-player.js";

let config = {};
let scramjet = null;
let scramjetFrame = null;
let connection = null;
let proxyActive = false;
let currentUser = null;
let currentProxyUrl = "";
let currentRoute = "home";
let watchCtl = null;

async function init() {
  console.log("[Blossom] Initializing...");

  if (!crossOriginIsolated) {
    console.warn("[Blossom] Page is NOT cross-origin isolated. SharedArrayBuffer unavailable.");
    console.warn("[Blossom] This may happen on Safari, Firefox forks, or older browsers.");

    const errEl = document.getElementById("search-error");
    if (errEl) {
      errEl.textContent = "Your browser doesn't support required features. Try Chrome/Edge, or check browser settings.";
      errEl.hidden = false;
    }
  }

  try {
    const resp = await fetch("/blossom-config.json");
    config = await resp.json();
  } catch {
    config = {
      proxyPrefix: "/assets/wasm/",
      epoxyPrefix: "/assets/net/",
      baremuxPrefix: "/assets/worker/",
      wispPath: "/ws/",
      scramjetPrefix: "/~/",
      mirrors: [],
      version: "1.0.0",
    };
  }

  applyCloak();

  initPanic();

  initSettings();

  initMirrors(config.mirrors);

  currentUser = config.user || null;

  if (currentUser) {
    syncBookmarksFromServer().then(() => renderRecentVisits()).catch(() => {});
    syncHistoryFromServer().then(() => renderRecentVisits()).catch(() => {});
  }

  if (currentUser?.features) {
    const f = currentUser.features;
    const hide = (id) => { const el = document.getElementById(id); if (el) el.hidden = true; };
    if (f.games === false) hide("btn-games");
    if (f.apps === false) hide("btn-apps");
    if (f.ai === false) { hide("btn-ai"); hide("ai-fab"); }
    if (f.bookmarks === false) hide("btn-bookmarks");
    if (f.settings === false) hide("btn-settings");
  }

  const versionEl = document.getElementById("blossom-version");
  if (versionEl) versionEl.textContent = `v${config.version}`;

  if (currentUser?.role === "dev") {
    const adminBtn = document.getElementById("btn-admin");
    if (adminBtn) adminBtn.hidden = false;
  }

  const userNameEl = document.getElementById("user-display-name");
  if (userNameEl && currentUser) {
    userNameEl.textContent = currentUser.displayName;
  }

  try {
    await registerSW(config.version, config.proxyPrefix, config.scramjetPrefix);
    console.log("[Blossom] Service worker registered");
  } catch (err) {
    console.error("[Blossom] SW registration failed:", err);
  }

  // Anti-CAPTCHA vault: restore watched-host cookies into the jar, then keep
  // syncing jar updates back to the server-side vault.
  initVaultSync(config, {
    onChallenge: (host, kind) => showCaptchaToast(kind),
  }).catch(() => {});

  await initScramjet();

  await loadGames();
  await loadApps();
  await hydrateCatalogPrefs();
  renderGamesTags();
  renderAppsTags();

  wireSearch();
  wireQuickLinks();
  wirePanels();
  wireGames();
  wireApps();
  wireAi({ showToast, ai: config.ai });
  wireHistoryPanel();
  wireProxyToolbar();
  wireAccount();
  wireTheme();
  wireVaultSettings();
  wireSavesSettings();
  wireWatch();
  wireRoutes();

  checkHealth();

  renderRecentVisits();

  window.addEventListener("beforeunload", () => {
    flushSaveKeepalive();
  });

  applyLocationRoute({ replace: true });

  console.log("[Blossom] Ready");
}

async function initScramjet() {
  if (typeof $scramjetLoadController !== "function") {
    console.error("[Blossom] $scramjetLoadController not found. Check that scramjet.all.js is loaded.");
    return;
  }

  try {
    const { ScramjetController } = $scramjetLoadController();

    const prefix = config.proxyPrefix || "/assets/wasm/";
    const scramjetPrefix = config.scramjetPrefix || "/~/";
    const wispUrl =
      (location.protocol === "https:" ? "wss" : "ws") +
      "://" + location.host + (config.wispPath || "/ws/");

    scramjet = new ScramjetController({
      prefix: scramjetPrefix,
      // Scramjet's service worker builds its own epoxy client from this URL.
      // Without it, config defaults to a scheme-less "/wisp/" and every proxied
      // request fails with "Invalid URL scheme: None".
      wisp: wispUrl,
      files: {
        wasm: prefix + "scramjet.wasm.wasm",
        all: prefix + "scramjet.all.js",
        sync: prefix + "scramjet.sync.js",
      },
    });

    try {
      await scramjet.init();
      console.log("[Blossom] ScramjetController initialized");
    } catch (err) {
      console.warn("[Blossom] Init failed, clearing stale IDB:", err.message);

      for (const name of ["$scramjet"]) {
        await new Promise((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = resolve;
          req.onerror = resolve;
          req.onblocked = resolve;
        });
        console.log("[Blossom] Deleted stale DB:", name);
      }
      await scramjet.init();
      console.log("[Blossom] ScramjetController initialized (after IDB cleanup)");
    }

    if (typeof BareMux !== "undefined") {
      const bmPrefix = config.baremuxPrefix || "/assets/worker/";
      const epPrefix = config.epoxyPrefix || "/assets/net/";
      connection = new BareMux.BareMuxConnection(bmPrefix + "worker.js");
      const wispUrl =
        (location.protocol === "https:" ? "wss" : "ws") +
        "://" + location.host + (config.wispPath || "/ws/");
      await connection.setTransport(epPrefix + "index.mjs", [{ wisp: wispUrl }]);
      console.log("[Blossom] BareMux transport set: epoxy -> " + wispUrl);
    } else {
      console.error("[Blossom] BareMux not loaded. Check that baremux/index.js is included.");
    }
  } catch (err) {
    console.error("[Blossom] Scramjet initialization failed:", err);
  }
}

async function ensureTransport() {
  if (!connection) {
    if (typeof BareMux !== "undefined") {
      const bmPrefix = config.baremuxPrefix || "/assets/worker/";
      connection = new BareMux.BareMuxConnection(bmPrefix + "worker.js");
    } else {
      throw new Error("BareMux not available");
    }
  }
  const wispUrl =
    (location.protocol === "https:" ? "wss" : "ws") +
    "://" + location.host + (config.wispPath || "/ws/");
  try {
    const t = await connection.getTransport();
    if (!t) throw new Error("no transport");
  } catch {
    const epPrefix = config.epoxyPrefix || "/assets/net/";
    await connection.setTransport(epPrefix + "index.mjs", [{ wisp: wispUrl }]);
    console.log("[Blossom] Transport re-set: epoxy -> " + wispUrl);
  }
}

function encodeProxyUrl(url) {
  if (!url) return url;
  const prefix = config.scramjetPrefix || "/~/";
  try {
    if (scramjet && typeof scramjet.encodeUrl === "function") return scramjet.encodeUrl(url);
    if (scramjet && typeof scramjet.encodeURL === "function") return scramjet.encodeURL(url);
    if (scramjet?.url && typeof scramjet.url.encode === "function") {
      return prefix + scramjet.url.encode(url);
    }
  } catch (err) {
    console.warn("[Blossom] encodeProxyUrl codec failed:", err);
  }
  return prefix + encodeURIComponent(url);
}

async function navigateTo(url, catalogId = null) {
  const raw = typeof url === "string" && url.startsWith("/")
    ? url
    : resolveInput(url);
  if (!raw) return;
  const resolved = rewriteDestination(raw);

  if (isWatchPath(resolved)) {
    const u = new URL(resolved, location.origin);
    setRoute("watch", { search: u.search });
    watchCtl?.open({
      v: u.searchParams.get("v") || "",
      q: u.searchParams.get("q") || "",
      push: false,
    });
    return;
  }

  if (typeof resolved === "string" && resolved.startsWith("/")) {
    return navigateLocal(new URL(resolved, location.origin).href, catalogId);
  }

  const searchError = document.getElementById("search-error");
  searchError.hidden = true;

  if (!scramjet) {
    searchError.textContent = "Engine failed to load. Try refreshing the page.";
    searchError.hidden = false;
    console.error("[Blossom] navigateTo called but scramjet is null");
    return;
  }

  console.log("[Blossom] Navigating to:", resolved);

  const nextSaveId = saveIdForUrl(resolved, catalogId || catalogIdForUrl(resolved));
  const skipSave = skipSaveFor(resolved);
  try { await endSaveSession(); } catch {}
  let saveSeed = { ownedKeys: new Set(), ownedDbs: new Set() };
  if (!skipSave) {
    try { saveSeed = await restoreSave(nextSaveId); } catch {}
  }

  const loadingOverlay = document.getElementById("loading-overlay");
  const proxyToolbar = document.getElementById("proxy-toolbar");
  loadingOverlay.hidden = false;
  proxyToolbar.hidden = false;

  updateProxyUrlBar(resolved);

  try {
    await registerSW(config.version, config.proxyPrefix, config.scramjetPrefix);
    await ensureTransport();
  } catch (err) {
    loadingOverlay.hidden = true;
    proxyToolbar.hidden = true;
    searchError.textContent = "Failed to initialize connection: " + err.message;
    searchError.hidden = false;
    console.error("[Blossom] Transport setup failed:", err);
    return;
  }

  addToHistory(resolved, resolved);
  renderRecentVisits();

  hideCatalogViews();

  if (currentUser && currentUser.features?.proxy === false) {
    loadingOverlay.hidden = true;
    proxyToolbar.hidden = true;
    searchError.textContent = "Proxy access is not enabled for your account.";
    searchError.hidden = false;
    return;
  }

  const homeView = document.getElementById("home-view");
  homeView.style.display = "none";
  proxyActive = true;
  document.body.classList.add("proxying");

  if (scramjetFrame) {
    try { scramjetFrame.frame.remove(); } catch {}
    scramjetFrame = null;
  }

  const frame = scramjet.createFrame();
  frame.frame.id = "proxy-frame";
  frame.frame.className = "proxy-frame with-toolbar";

  frame.addEventListener("navigate", (e) => {
    console.log("[Blossom] Navigating:", e.url);
    currentProxyUrl = e.url;
    updateProxyUrlBar(e.url);
  });

  frame.addEventListener("urlchange", (e) => {
    currentProxyUrl = e.url;
    updateProxyUrlBar(e.url);
    updateBookmarkButton(e.url);

    try {
      const title = frame.frame.contentDocument?.title;
      if (title) {
        document.title = title + " \u00b7 Blossom";
        updateHistoryTitle(e.url, title);
      } else {
        const hostname = new URL(e.url).hostname.replace("www.", "");
        document.title = hostname + " \u00b7 Blossom";
      }
    } catch {
      try {
        const hostname = new URL(e.url).hostname.replace("www.", "");
        document.title = hostname + " \u00b7 Blossom";
      } catch {}
    }
  });

  frame.frame.addEventListener("load", () => {
    bindSaveFrame(frame.frame);
    try {
      const fw = frame.frame.contentWindow;
      if (fw) {
        fw.open = (openUrl) => {
          if (!openUrl || openUrl === "about:blank") return null;
          try {
            const abs = new URL(openUrl, currentProxyUrl || resolved).href;
            if (scramjetFrame) scramjetFrame.go(abs);
          } catch {}
          return null;
        };
        const doc = frame.frame.contentDocument;
        if (doc) doc.querySelectorAll('a[target="_blank"]').forEach(a => a.removeAttribute("target"));
      }
    } catch {  }
  });

  frame.frame.addEventListener("load", () => {
    // Detect failed proxied loads and surface the app-level error overlay:
    // 1. Our SW's 502 page (has #blossom-sw-error marker with detail), or
    // 2. Scramjet's built-in error page (titled "Scramjet"), which it serves
    //    directly when the upstream fetch fails (DNS failure, refused, etc.)
    try {
      const doc = frame.frame.contentDocument;
      const errMarker = doc?.getElementById("blossom-sw-error");
      const scramjetErrorPage = doc && doc.title === "Scramjet";
      if (errMarker || scramjetErrorPage) {
        const detail = errMarker?.dataset?.detail
          || (doc?.body?.innerText || "").trim().slice(0, 200)
          || "";
        window.showProxyError(detail);
        return;
      }
    } catch {}
    loadingOverlay.hidden = true;
  });

  setTimeout(() => { loadingOverlay.hidden = true; }, skipSave ? 20000 : 10000);

  const oldFrame = document.getElementById("proxy-frame");
  if (oldFrame) oldFrame.remove();

  document.getElementById("app").appendChild(frame.frame);
  if (!skipSave) startSaveSession(nextSaveId, frame.frame, saveSeed);
  scramjetFrame = frame;
  frame.go(resolved);

  updateBookmarkButton(resolved);
}

// Match a proxied URL to a games/apps catalog entry (exact or hostname match)
// so its save slot is the catalog one rather than a generic hostname slot.
function catalogIdForUrl(rawUrl) {
  let target;
  try { target = new URL(rawUrl); } catch { return null; }
  const host = target.hostname.toLowerCase();
  const pools = [...getGames(), ...getApps()];
  for (const entry of pools) {
    if (!entry.url || entry.url.startsWith("/")) continue;
    try {
      const eh = new URL(entry.url).hostname.toLowerCase();
      if (host === eh || host.endsWith("." + eh)) return entry.id;
    } catch {}
  }
  return null;
}

function teardownProxy() {
  const frame = document.getElementById("proxy-frame");
  const proxyToolbar = document.getElementById("proxy-toolbar");
  const loadingOverlay = document.getElementById("loading-overlay");
  const expandBtn = document.getElementById("proxy-expand");

  if (frame) frame.remove();
  if (proxyToolbar) proxyToolbar.hidden = true;
  if (loadingOverlay) loadingOverlay.hidden = true;
  if (expandBtn) expandBtn.hidden = true;
  proxyActive = false;
  document.body.classList.remove("proxying");
  scramjetFrame = null;
  currentProxyUrl = "";
  endSaveSession().catch(() => {});
  applyCloak();
}

function goHome() {
  setRoute("home");
}

function hideCatalogViews() {
  const gamesView = document.getElementById("games-view");
  const appsView = document.getElementById("apps-view");
  const aiView = document.getElementById("ai-view");
  const ytView = document.getElementById("yt-view");
  if (gamesView) gamesView.hidden = true;
  if (appsView) appsView.hidden = true;
  if (aiView) aiView.hidden = true;
  if (ytView) ytView.hidden = true;
}

function featureAllows(name) {
  const f = currentUser?.features;
  if (!f) return true;
  if (name === "games") return f.games !== false;
  if (name === "apps") return f.apps !== false;
  if (name === "ai") return f.ai !== false;
  if (name === "watch") return f.proxy !== false;
  return true;
}

function syncNav(name) {
  const map = [
    ["btn-games", "games"],
    ["btn-apps", "apps"],
    ["btn-ai", "ai"],
  ];
  for (const [id, route] of map) {
    const el = document.getElementById(id);
    if (!el) continue;
    const on = route === name;
    el.classList.toggle("active", on);
    if (on) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }
}

function paintRoute(name) {
  const homeView = document.getElementById("home-view");
  hideCatalogViews();
  if (homeView) homeView.style.display = name === "home" ? "" : "none";
  if (name !== "ai") onAiRoute(false);
  if (name !== "watch") {
    try { document.getElementById("yt-video")?.pause(); } catch {}
  }

  if (name === "games") {
    const gamesView = document.getElementById("games-view");
    if (gamesView) gamesView.hidden = false;
    renderGamesGrid(
      document.getElementById("games-search")?.value || "",
      document.querySelector("#games-tags .tag-btn.active")?.textContent || "all"
    );
    spring(gamesView, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 380 });
  } else if (name === "apps") {
    const appsView = document.getElementById("apps-view");
    if (appsView) appsView.hidden = false;
    renderAppsGrid(
      document.getElementById("apps-search")?.value || "",
      document.querySelector("#apps-tags .tag-btn.active")?.textContent || "all"
    );
    spring(appsView, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 380 });
  } else if (name === "ai") {
    const aiView = document.getElementById("ai-view");
    if (aiView) aiView.hidden = false;
    onAiRoute(true);
  } else if (name === "watch") {
    const ytView = document.getElementById("yt-view");
    if (ytView) ytView.hidden = false;
  }
  syncNav(name);
}

function setRoute(name, opts = {}) {
  const { search = "", replace = false, skipHistory = false } = opts;
  let route = name;
  if (!featureAllows(route)) route = "home";

  closeAllPanels();
  if (proxyActive) teardownProxy();

  const href = hrefFor(route, search);
  const apply = () => {
    currentRoute = route;
    paintRoute(route);
  };
  withViewTransition(apply);

  if (!skipHistory) {
    const method = replace ? "replaceState" : "pushState";
    const here = location.pathname + location.search;
    if (replace || here !== href) history[method]({ route }, "", href);
  }
}

function applyLocationRoute({ replace = false } = {}) {
  const parsed = parseRoute(location.pathname, location.search);
  setRoute(parsed.name, { search: parsed.search, replace, skipHistory: true });
  history.replaceState({ route: parsed.name }, "", hrefFor(parsed.name, parsed.search));
  if (parsed.name === "watch") {
    const u = new URL(location.href);
    watchCtl?.open({
      v: u.searchParams.get("v") || "",
      q: u.searchParams.get("q") || "",
      push: false,
    });
  }
}

function interceptRouteClick(el, name) {
  if (!el) return;
  el.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    setRoute(name);
  });
}

function wireRoutes() {
  interceptRouteClick(document.getElementById("logo-home"), "home");
  interceptRouteClick(document.getElementById("btn-games"), "games");
  interceptRouteClick(document.getElementById("btn-apps"), "apps");
  interceptRouteClick(document.getElementById("btn-ai"), "ai");
  interceptRouteClick(document.getElementById("games-back"), "home");
  interceptRouteClick(document.getElementById("apps-back"), "home");
  interceptRouteClick(document.getElementById("ai-back"), "home");
  interceptRouteClick(document.getElementById("yt-back"), "home");
  window.addEventListener("popstate", () => applyLocationRoute());
}

function wireWatch() {
  watchCtl = createWatchController({
    encodeUrl: encodeProxyUrl,
    ensureTransport,
    toast: showToast,
    onLocation: (href) => {
      const u = new URL(href, location.origin);
      setRoute("watch", { search: u.search });
    },
    playEmbed: (id) => {
      const embed = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1`;
      navigateTo(embed);
    },
  });
  watchCtl.wire();
}

function hideCatalogToHome() {
  setRoute("home");
}

async function navigateLocal(absUrl, catalogId = null) {
  const searchError = document.getElementById("search-error");
  if (searchError) searchError.hidden = true;

  const nextSaveId = saveIdForUrl(absUrl, catalogId);
  try { await endSaveSession(); } catch {}
  let saveSeed = { ownedKeys: new Set(), ownedDbs: new Set() };
  try { saveSeed = await restoreSave(nextSaveId); } catch {}

  const homeView = document.getElementById("home-view");
  const loadingOverlay = document.getElementById("loading-overlay");
  const proxyToolbar = document.getElementById("proxy-toolbar");
  if (homeView) homeView.style.display = "none";
  hideCatalogViews();
  if (loadingOverlay) loadingOverlay.hidden = false;
  if (proxyToolbar) proxyToolbar.hidden = false;

  document.body.classList.add("proxying");
  proxyActive = true;
  scramjetFrame = null;
  updateProxyUrlBar(absUrl);
  addToHistory(absUrl, absUrl);
  renderRecentVisits();

  const oldFrame = document.getElementById("proxy-frame");
  if (oldFrame) oldFrame.remove();

  const iframe = document.createElement("iframe");
  iframe.id = "proxy-frame";
  iframe.className = "proxy-frame with-toolbar";
  iframe.title = "Game";
  iframe.addEventListener("load", () => {
    bindSaveFrame(iframe);
    if (loadingOverlay) loadingOverlay.hidden = true;
  });
  document.getElementById("app").appendChild(iframe);
  startSaveSession(nextSaveId, iframe, saveSeed);
  iframe.src = absUrl;
  updateBookmarkButton(absUrl);
  setTimeout(() => { if (loadingOverlay) loadingOverlay.hidden = true; }, 8000);
}

function catalogSources() {
  return {
    history: getHistory(),
    bookmarks: getBookmarks(),
    games: getGames(),
    apps: getApps(),
  };
}

function refreshEngineChip() {
  const chip = document.getElementById("search-engine-chip");
  if (!chip) return;
  const info = getSearchEngineInfo();
  chip.textContent = info.short;
  chip.title = `Search with ${info.label} (click to switch)`;
}

function wireSearch() {
  const form = document.getElementById("search-form");
  const input = document.getElementById("search-input");
  const chip = document.getElementById("search-engine-chip");

  bindOmnibox({
    input,
    list: document.getElementById("search-suggest"),
    clearBtn: document.getElementById("search-clear"),
    getSources: catalogSources,
    onNavigate: (url, catalogId) => navigateTo(url, catalogId),
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    navigateTo(input.value);
  });

  if (chip) {
    chip.addEventListener("click", () => {
      cycleSearchEngine();
      const select = document.getElementById("setting-search-engine");
      if (select) select.value = getSearchEngineInfo().template;
      refreshEngineChip();
      const list = document.getElementById("search-suggest");
      if (list && !list.hidden) {
        input.dispatchEvent(new Event("input"));
      }
    });
  }
  refreshEngineChip();
  window.addEventListener("blossom-search-engine", refreshEngineChip);
}

function wireQuickLinks() {
  document.querySelectorAll(".quick-card[data-url]").forEach((card) => {
    card.addEventListener("click", () => {
      navigateTo(card.dataset.url);
    });
  });
}

function wirePanels() {

  const panelMap = {
    "btn-bookmarks": "bookmarks-panel",
    "btn-history": "history-panel",
    "btn-settings": "settings-panel",
  };

  for (const [btnId, panelId] of Object.entries(panelMap)) {
    document.getElementById(btnId).addEventListener("click", () => {
      closeAllPanels();
      const panel = document.getElementById(panelId);
      panel.hidden = false;

      requestAnimationFrame(() => panel.classList.add("open"));

      if (panelId === "bookmarks-panel") renderBookmarks();
      if (panelId === "history-panel") renderHistory();
      if (panelId === "settings-panel") {
        refreshVaultStatus();
        refreshSavesStatus();
      }
    });
  }

  document.querySelectorAll(".panel-close").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panelId = btn.dataset.close;
      closePanel(panelId);
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const openPanel = document.querySelector(".side-panel.open");
      if (openPanel) {
        closePanel(openPanel.id);
        return;
      }
      const aiView = document.getElementById("ai-view");
      if (aiView && !aiView.hidden) { hideCatalogToHome(); return; }
      const ytView = document.getElementById("yt-view");
      if (ytView && !ytView.hidden) hideCatalogToHome();
    }
  });

  document.addEventListener("click", (e) => {
    const openPanel = document.querySelector(".side-panel.open");
    if (!openPanel) return;

    if (openPanel.contains(e.target) || e.target.closest(".topbar-btn")) return;
    closePanel(openPanel.id);
  });
}

function closeAllPanels() {
  document.querySelectorAll(".side-panel").forEach((p) => {
    p.classList.remove("open");
    p.hidden = true;
  });
}

function closePanel(panelId) {
  const panel = document.getElementById(panelId);
  panel.classList.remove("open");
  setTimeout(() => { panel.hidden = true; }, 250);
}

const STAR_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 17.3l-6.18 3.7 1.64-7.03L2 9.24l7.19-.61L12 2l2.81 6.63 7.19.61-5.46 4.73 1.64 7.03z"/></svg>';

function createCatalogCard(entry, { favorited, onFav, onOpen }) {
  const card = document.createElement("div");
  card.className = "game-card";
  card.style.position = "relative";
  card.dataset.id = entry.id;

  const thumbWrap = document.createElement("div");
  thumbWrap.className = "game-card-thumb";
  if (entry.thumb) {
    const thumb = document.createElement("img");
    thumb.src = entry.thumb;
    thumb.alt = "";
    thumb.loading = "lazy";
    thumb.onerror = () => { thumb.remove(); };
    thumbWrap.appendChild(thumb);
  }

  const info = document.createElement("div");
  info.className = "game-card-info";
  const name = document.createElement("div");
  name.className = "game-card-name";
  name.textContent = entry.name;
  info.appendChild(name);
  if (entry.tags?.length) {
    const tags = document.createElement("div");
    tags.className = "game-card-tags";
    tags.textContent = entry.tags.slice(0, 3).join(" · ");
    info.appendChild(tags);
  }

  const fav = document.createElement("button");
  fav.className = `game-fav${favorited ? " active" : ""}`;
  fav.innerHTML = STAR_SVG;
  fav.setAttribute("aria-label", `${favorited ? "Unfavorite" : "Favorite"} ${entry.name}`);
  fav.addEventListener("click", (e) => {
    e.stopPropagation();
    onFav(entry.id);
    fav.classList.toggle("active");
    const nowFav = fav.classList.contains("active");
    fav.setAttribute("aria-label", `${nowFav ? "Unfavorite" : "Favorite"} ${entry.name}`);
  });

  card.appendChild(thumbWrap);
  card.appendChild(info);
  card.appendChild(fav);
  card.addEventListener("click", () => onOpen(entry));
  return card;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function persistCatalogPrefs() {
  if (!currentUser) return;
  scheduleCatalogPrefs({
    gameFavs: getFavorites(),
    gameRecents: getRecentGames(),
    appFavs: getAppFavorites(),
    appRecents: getRecentApps(),
  });
}

function applyPrefList(remote, getLocal, hydrate) {
  if (!Array.isArray(remote)) return false;
  if (remote.length) {
    hydrate(remote);
    return false;
  }
  return getLocal().length > 0;
}

async function hydrateCatalogPrefs() {
  if (!currentUser) return;
  const remote = await loadCatalogPrefs();
  if (!remote) return;
  const recovered = [
    applyPrefList(remote.gameFavs, getFavorites, hydrateFavorites),
    applyPrefList(remote.gameRecents, getRecentGames, hydrateRecents),
    applyPrefList(remote.appFavs, getAppFavorites, hydrateAppFavorites),
    applyPrefList(remote.appRecents, getRecentApps, hydrateAppRecents),
  ].some(Boolean);
  if (recovered) persistCatalogPrefs();
}

function launchCatalogEntry(entry, kind) {
  if (!entry?.url) return;
  if (kind === "game") recordGamePlayed(entry);
  else recordAppUsed(entry);
  persistCatalogPrefs();
  navigateTo(entry.url, entry.id);
}

function renderTagBar(containerId, tags, searchId, renderGrid) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";
  for (const tag of tags) {
    const btn = document.createElement("button");
    btn.className = `tag-btn${tag === "all" ? " active" : ""}`;
    btn.textContent = tag;
    btn.addEventListener("click", () => {
      container.querySelectorAll(".tag-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderGrid(document.getElementById(searchId)?.value || "", tag);
    });
    container.appendChild(btn);
  }
}

function renderGamesTags() {
  renderTagBar("games-tags", getAllTags(), "games-search", renderGamesGrid);
}

function wireGames() {
  const searchInput = document.getElementById("games-search");
  if (searchInput) {
    searchInput.addEventListener("input", debounce(() => {
      const tag = document.querySelector("#games-tags .tag-btn.active")?.textContent || "all";
      renderGamesGrid(searchInput.value, tag);
    }, 120));
  }
  renderGamesGrid("", "all");
}

function renderGamesGrid(query, tag) {
  const browsingAll = !String(query || "").trim() && (!tag || tag === "all");
  const main = document.getElementById("games-grid");
  const games = filterGames(query || "", tag || "all");
  if (main) {
    main.innerHTML = "";
    if (!games.length) {
      main.innerHTML = '<p class="empty-state">No games found.</p>';
    } else {
      for (const g of games) {
        main.appendChild(createCatalogCard(g, {
          favorited: isFavorite(g.id),
          onFav: (id) => { toggleFavorite(id); persistCatalogPrefs(); renderGamesGrid(query, tag); },
          onOpen: (entry) => launchCatalogEntry(entry, "game"),
        }));
      }
    }
  }

  const favSection = document.getElementById("games-fav-section");
  const favGrid = document.getElementById("games-fav-grid");
  const favEntries = getFavorites().map(getGameById).filter(Boolean);
  if (favSection && favGrid) {
    favSection.hidden = !browsingAll || favEntries.length === 0;
    if (!favSection.hidden) {
      favGrid.innerHTML = "";
      for (const g of favEntries) {
        favGrid.appendChild(createCatalogCard(g, {
          favorited: true,
          onFav: (id) => { toggleFavorite(id); persistCatalogPrefs(); renderGamesGrid(query, tag); },
          onOpen: (entry) => launchCatalogEntry(entry, "game"),
        }));
      }
    }
  }

  const recentSection = document.getElementById("games-recent-section");
  const recentGrid = document.getElementById("games-recent-grid");
  const recentEntries = getRecentGames().map((r) => getGameById(r.id)).filter(Boolean);
  if (recentSection && recentGrid) {
    recentSection.hidden = !browsingAll || recentEntries.length === 0;
    if (!recentSection.hidden) {
      recentGrid.innerHTML = "";
      for (const g of recentEntries) {
        recentGrid.appendChild(createCatalogCard(g, {
          favorited: isFavorite(g.id),
          onFav: (id) => { toggleFavorite(id); persistCatalogPrefs(); renderGamesGrid(query, tag); },
          onOpen: (entry) => launchCatalogEntry(entry, "game"),
        }));
      }
    }
  }
}

function renderAppsTags() {
  renderTagBar("apps-tags", getAppTags(), "apps-search", renderAppsGrid);
}

function wireApps() {
  const searchInput = document.getElementById("apps-search");
  if (searchInput) {
    searchInput.addEventListener("input", debounce(() => {
      const tag = document.querySelector("#apps-tags .tag-btn.active")?.textContent || "all";
      renderAppsGrid(searchInput.value, tag);
    }, 120));
  }
  renderAppsGrid("", "all");
}

function renderAppsGrid(query, tag) {
  const browsingAll = !String(query || "").trim() && (!tag || tag === "all");
  const main = document.getElementById("apps-grid");
  const apps = filterApps(query || "", tag || "all");
  if (main) {
    main.innerHTML = "";
    if (!apps.length) {
      main.innerHTML = '<p class="empty-state">No apps found.</p>';
    } else {
      for (const a of apps) {
        main.appendChild(createCatalogCard(a, {
          favorited: isAppFavorite(a.id),
          onFav: (id) => { toggleAppFavorite(id); persistCatalogPrefs(); renderAppsGrid(query, tag); },
          onOpen: (entry) => launchCatalogEntry(entry, "app"),
        }));
      }
    }
  }

  const favSection = document.getElementById("apps-fav-section");
  const favGrid = document.getElementById("apps-fav-grid");
  const favEntries = getAppFavorites().map(getAppById).filter(Boolean);
  if (favSection && favGrid) {
    favSection.hidden = !browsingAll || favEntries.length === 0;
    if (!favSection.hidden) {
      favGrid.innerHTML = "";
      for (const a of favEntries) {
        favGrid.appendChild(createCatalogCard(a, {
          favorited: true,
          onFav: (id) => { toggleAppFavorite(id); persistCatalogPrefs(); renderAppsGrid(query, tag); },
          onOpen: (entry) => launchCatalogEntry(entry, "app"),
        }));
      }
    }
  }

  const recentSection = document.getElementById("apps-recent-section");
  const recentGrid = document.getElementById("apps-recent-grid");
  const recentEntries = getRecentApps().map((r) => getAppById(r.id)).filter(Boolean);
  if (recentSection && recentGrid) {
    recentSection.hidden = !browsingAll || recentEntries.length === 0;
    if (!recentSection.hidden) {
      recentGrid.innerHTML = "";
      for (const a of recentEntries) {
        recentGrid.appendChild(createCatalogCard(a, {
          favorited: isAppFavorite(a.id),
          onFav: (id) => { toggleAppFavorite(id); persistCatalogPrefs(); renderAppsGrid(query, tag); },
          onOpen: (entry) => launchCatalogEntry(entry, "app"),
        }));
      }
    }
  }
}

function renderBookmarks() {
  const list = document.getElementById("bookmarks-list");
  const empty = document.getElementById("bookmarks-empty");
  const bookmarks = getBookmarks();

  list.innerHTML = "";
  empty.hidden = bookmarks.length > 0;

  for (const bm of bookmarks) {
    const item = createListItem(bm.title, bm.url, bm.time, () => navigateTo(bm.url), () => {
      removeBookmark(bm.url);
      renderBookmarks();
    });
    list.appendChild(item);
  }
}

function wireHistoryPanel() {
  document.getElementById("clear-history").addEventListener("click", () => {
    clearHistory();
    renderHistory();
  });
}

function renderHistory() {
  const list = document.getElementById("history-list");
  const empty = document.getElementById("history-empty");
  const hist = getHistory();

  list.innerHTML = "";
  empty.hidden = hist.length > 0;

  for (const h of hist) {
    const item = createListItem(h.title, h.url, h.time, () => navigateTo(h.url));
    list.appendChild(item);
  }
}

function renderRecentVisits() {
  const section = document.getElementById("recent-section");
  const container = document.getElementById("recent-list");
  const hist = getHistory().slice(0, 6);

  if (hist.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  container.innerHTML = "";

  for (const h of hist) {
    const card = document.createElement("button");
    card.className = "quick-card";

    let hostname = h.url;
    try { hostname = new URL(h.url).hostname; } catch {}

    const icon = document.createElement("span");
    icon.className = "quick-icon";
    icon.textContent = "🌐";

    const label = document.createElement("span");
    label.textContent = hostname;

    card.appendChild(icon);
    card.appendChild(label);
    card.addEventListener("click", () => navigateTo(h.url));
    container.appendChild(card);
  }
}

function createListItem(title, url, time, onClick, onRemove) {
  const item = document.createElement("div");
  item.className = "list-item";

  const info = document.createElement("div");
  info.className = "list-item-info";

  const titleEl = document.createElement("div");
  titleEl.className = "list-item-title";
  titleEl.textContent = title;

  const urlEl = document.createElement("div");
  urlEl.className = "list-item-url";
  urlEl.textContent = url;

  info.appendChild(titleEl);
  info.appendChild(urlEl);

  const timeEl = document.createElement("span");
  timeEl.className = "list-item-time";
  timeEl.textContent = formatTime(time);

  item.appendChild(info);
  item.appendChild(timeEl);

  if (onRemove) {
    const removeBtn = document.createElement("button");
    removeBtn.className = "list-item-remove";
    removeBtn.textContent = "✕";
    removeBtn.setAttribute("aria-label", `Remove ${title}`);
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onRemove();
    });
    item.appendChild(removeBtn);
  }

  item.addEventListener("click", onClick);
  return item;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;

  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

function wireProxyToolbar() {
  document.getElementById("proxy-back").addEventListener("click", () => {
    if (scramjetFrame) {
      scramjetFrame.back();
      return;
    }
    try { document.getElementById("proxy-frame")?.contentWindow?.history.back(); } catch {}
  });
  document.getElementById("proxy-forward").addEventListener("click", () => {
    if (scramjetFrame) {
      scramjetFrame.forward();
      return;
    }
    try { document.getElementById("proxy-frame")?.contentWindow?.history.forward(); } catch {}
  });
  document.getElementById("proxy-reload").addEventListener("click", () => {
    if (scramjetFrame) {
      scramjetFrame.reload();
      return;
    }
    const frame = document.getElementById("proxy-frame");
    if (frame?.src) frame.src = frame.src;
  });
  document.getElementById("proxy-home").addEventListener("click", goHome);

  document.getElementById("proxy-bookmark").addEventListener("click", () => {
    if (!currentProxyUrl) return;
    if (isBookmarked(currentProxyUrl)) {
      removeBookmark(currentProxyUrl);
    } else {
      let title = currentProxyUrl;
      try { title = new URL(currentProxyUrl).hostname; } catch {}
      addBookmark(currentProxyUrl, title);
    }
    updateBookmarkButton(currentProxyUrl);
  });

  const urlInput = document.getElementById("proxy-url-input");
  bindOmnibox({
    input: urlInput,
    list: document.getElementById("proxy-suggest"),
    getSources: catalogSources,
    onNavigate: (url, catalogId) => navigateTo(url, catalogId),
  });
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && document.getElementById("proxy-suggest")?.hidden) {
      e.preventDefault();
      const val = urlInput.value.trim();
      if (!val) return;
      navigateTo(val);
    }
  });

  urlInput.addEventListener("focus", () => {
    if (urlInput.dataset.href) urlInput.value = urlInput.dataset.href;
    urlInput.select();
    const clear = document.getElementById("proxy-url-clear");
    if (clear) clear.hidden = !urlInput.value;
  });
  urlInput.addEventListener("blur", () => {
    if (urlInput.dataset.href) updateProxyUrlBar(urlInput.dataset.href);
  });
  urlInput.addEventListener("input", () => {
    const clear = document.getElementById("proxy-url-clear");
    if (clear) clear.hidden = !urlInput.value;
  });

  const urlClear = document.getElementById("proxy-url-clear");
  if (urlClear) {
    urlClear.addEventListener("mousedown", (e) => e.preventDefault());
    urlClear.addEventListener("click", () => {
      urlInput.value = "";
      urlInput.focus();
      urlClear.hidden = true;
    });
  }

  document.getElementById("proxy-copy")?.addEventListener("click", async () => {
    const href = currentProxyUrl || urlInput.dataset.href || urlInput.value;
    try { await navigator.clipboard.writeText(href); showToast("Copied URL"); } catch { showToast("Could not copy"); }
  });

  const moreBtn = document.getElementById("proxy-more");
  const moreMenu = document.getElementById("proxy-more-menu");
  moreBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (moreMenu) moreMenu.hidden = !moreMenu.hidden;
  });
  document.addEventListener("click", () => { if (moreMenu) moreMenu.hidden = true; });
  moreMenu?.addEventListener("click", async (e) => {
    const act = e.target?.dataset?.act;
    if (!act) return;
    moreMenu.hidden = true;
    const href = currentProxyUrl || urlInput.dataset.href || "";
    if (act === "copy") {
      try { await navigator.clipboard.writeText(href); showToast("Copied URL"); } catch {}
    } else if (act === "copy-host") {
      try { await navigator.clipboard.writeText(new URL(href).hostname); showToast("Copied host"); } catch {}
    } else if (act === "hard-reload") {
      if (scramjetFrame) {
        scramjetFrame.frame.remove();
        scramjetFrame = null;
      }
      if (href) navigateTo(href);
    } else if (act === "popout") {
      launchAboutBlankCloak();
    }
  });

  document.getElementById("proxy-collapse").addEventListener("click", () => {
    const toolbar = document.getElementById("proxy-toolbar");
    const expandBtn = document.getElementById("proxy-expand");
    const frame = document.getElementById("proxy-frame");
    toolbar.hidden = true;
    expandBtn.hidden = false;
    if (frame) {
      frame.classList.remove("with-toolbar");
    }
  });

  document.getElementById("proxy-expand").addEventListener("click", () => {
    const toolbar = document.getElementById("proxy-toolbar");
    const expandBtn = document.getElementById("proxy-expand");
    const frame = document.getElementById("proxy-frame");
    toolbar.hidden = false;
    expandBtn.hidden = true;
    if (frame) {
      frame.classList.add("with-toolbar");
    }
  });
}

function updateProxyUrlBar(url) {
  const urlInput = document.getElementById("proxy-url-input");
  const lock = document.getElementById("proxy-secure");
  const clear = document.getElementById("proxy-url-clear");

  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const compact = parsed.hostname + path + (parsed.search || "");
    urlInput.dataset.href = parsed.href;
    urlInput.title = parsed.href;
    if (document.activeElement !== urlInput) urlInput.value = compact;
    currentProxyUrl = parsed.href;
    if (lock) {
      lock.classList.toggle("insecure", parsed.protocol !== "https:");
      lock.title = parsed.protocol === "https:" ? "HTTPS" : "Not HTTPS";
    }
  } catch {
    urlInput.value = url;
    urlInput.dataset.href = String(url || "");
    currentProxyUrl = url;
  }
  if (clear) clear.hidden = !urlInput.value;
}

function updateBookmarkButton(url) {
  const btn = document.getElementById("proxy-bookmark");
  if (isBookmarked(url)) {
    btn.classList.add("bookmarked");
  } else {
    btn.classList.remove("bookmarked");
  }
}

function wireAccount() {
  const logoutModal = document.getElementById("logout-modal");
  const openLogout = () => { if (logoutModal) logoutModal.hidden = false; };
  const closeLogout = () => { if (logoutModal) logoutModal.hidden = true; };
  const performLogout = async () => {
    await fetch("/auth/logout", { method: "POST" });
    window.location.replace("/login");
  };

  const logoutBtn = document.getElementById("btn-logout");
  if (logoutBtn) logoutBtn.addEventListener("click", openLogout);
  const settingsLogout = document.getElementById("setting-logout");
  if (settingsLogout) settingsLogout.addEventListener("click", openLogout);

  const confirmBtn = document.getElementById("logout-confirm");
  if (confirmBtn) confirmBtn.addEventListener("click", performLogout);
  const cancelBtn = document.getElementById("logout-cancel");
  if (cancelBtn) cancelBtn.addEventListener("click", closeLogout);
  if (logoutModal) {
    logoutModal.addEventListener("click", (e) => { if (e.target === logoutModal) closeLogout(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !logoutModal.hidden) closeLogout();
    });
  }

  const adminBtn = document.getElementById("btn-admin");
  if (adminBtn) {
    adminBtn.addEventListener("click", () => {
      window.location.href = "/admin";
    });
  }

  const settingsEmail = document.getElementById("settings-user-email");
  if (settingsEmail && currentUser) {
    settingsEmail.textContent = currentUser.displayName;
  }
}

function wireTheme() {
  const btn = document.getElementById("btn-theme");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const root = document.documentElement;
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("blossom-theme", next); } catch {}
    window.dispatchEvent(new Event("blossom:theme"));
  });
}

async function checkHealth() {
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");

  try {
    const resp = await fetch("/health");
    if (resp.ok) {
      const data = await resp.json();
      dot.className = "dot dot-ok";
      text.textContent = `Online - ${data.uptime}s uptime`;
    } else {
      dot.className = "dot dot-fail";
      text.textContent = "Server error";
    }
  } catch {
    dot.className = "dot dot-fail";
    text.textContent = "Offline";
  }
}

const CAPTCHA_COPY = {
  google: "Google wants to check you're human. Solve it once and Blossom remembers this site.",
  reddit: "Reddit asked for a quick check. Solve it once and Blossom remembers this site.",
  cloudflare: "Quick security check. Solve it and Blossom remembers this site.",
  recaptcha: "Solve the CAPTCHA once. Blossom keeps the session so it stops looping.",
  hcaptcha: "Solve the CAPTCHA once. Blossom keeps the session so it stops looping.",
  generic: "Solving a CAPTCHA? Complete it slowly, since the page can sometimes loop if you go too fast.",
};

function showCaptchaToast(kind) {
  const toast = document.getElementById("captcha-toast");
  const text = document.getElementById("captcha-toast-text");
  if (text) text.textContent = CAPTCHA_COPY[kind] || CAPTCHA_COPY.generic;
  toast.hidden = false;

  const timeout = setTimeout(() => { toast.hidden = true; }, 8000);

  const closeBtn = toast.querySelector(".toast-close");
  closeBtn.addEventListener("click", () => {
    toast.hidden = true;
    clearTimeout(timeout);
  }, { once: true });
}

async function refreshVaultStatus() {
  const el = document.getElementById("vault-status");
  if (!el) return;
  try {
    const r = await fetch("/api/captcha/status", { headers: { Accept: "application/json" } });
    if (!r.ok) { el.textContent = "Unavailable"; return; }
    const s = await r.json();
    if (!s.hosts.length) {
      el.textContent = "None yet. Sessions are saved after you solve a check on a watched site.";
      return;
    }
    el.textContent = "Saved: " + s.hosts.map((h) => `${h.host} (${h.cookieCount})`).join(", ");
  } catch {
    el.textContent = "Unavailable";
  }
}

function wireVaultSettings() {
  const clearBtn = document.getElementById("vault-clear");
  if (!clearBtn) return;
  clearBtn.addEventListener("click", async () => {
    clearBtn.disabled = true;
    try {
      await fetch("/api/captcha/vault", { method: "DELETE" });
    } finally {
      clearBtn.disabled = false;
      refreshVaultStatus();
    }
  });
}

function saveSlotLabel(id) {
  if (id.startsWith("c-")) {
    const catalogId = id.slice(2);
    return getGameById(catalogId)?.name || getAppById(catalogId)?.name || catalogId;
  }
  if (id.startsWith("h-")) return id.slice(2);
  return id;
}

async function refreshSavesStatus() {
  const el = document.getElementById("saves-status");
  const list = document.getElementById("saves-list");
  if (!el) return;
  try {
    const r = await fetch("/api/saves", { headers: { Accept: "application/json" } });
    if (!r.ok) { el.textContent = "Unavailable"; return; }
    const j = await r.json();
    const slots = (j.saves || []).filter((s) => s.id !== "c-catalog-prefs");
    if (!slots.length) {
      el.textContent = "None yet. Play a game or open an app and progress is saved here.";
      if (list) { list.innerHTML = ""; list.hidden = true; }
      return;
    }
    el.textContent = `${slots.length} saved ${slots.length === 1 ? "title" : "titles"}.`;
    if (list) {
      list.hidden = false;
      list.innerHTML = "";
      for (const s of slots) {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = saveSlotLabel(s.id);
        const del = document.createElement("button");
        del.type = "button";
        del.className = "saves-list-del";
        del.textContent = "Forget";
        del.setAttribute("aria-label", `Forget save for ${name.textContent}`);
        del.addEventListener("click", async () => {
          await fetch(`/api/saves/${encodeURIComponent(s.id)}`, { method: "DELETE" });
          refreshSavesStatus();
        });
        li.appendChild(name);
        li.appendChild(del);
        list.appendChild(li);
      }
    }
  } catch {
    el.textContent = "Unavailable";
  }
}

function wireSavesSettings() {
  const clearBtn = document.getElementById("saves-clear");
  if (!clearBtn) return;
  clearBtn.addEventListener("click", async () => {
    clearBtn.disabled = true;
    try {
      await fetch("/api/saves", { method: "DELETE" });
    } finally {
      clearBtn.disabled = false;
      refreshSavesStatus();
    }
  });
}

function showToast(message) {
  const existing = document.querySelector(".toast.dynamic");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = "toast dynamic";

  const text = document.createTextNode(message + " ");
  const closeBtn = document.createElement("button");
  closeBtn.className = "toast-close";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => toast.remove());

  toast.appendChild(text);
  toast.appendChild(closeBtn);
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 8000);
}

window.showProxyError = function (detail) {
  const overlay = document.getElementById("error-overlay");
  const detailEl = document.getElementById("error-detail");

  detailEl.textContent = detail || "The proxied site failed to load. It may be blocked, down, or require a different proxy engine.";
  overlay.hidden = false;

  document.getElementById("error-retry").onclick = () => {
    overlay.hidden = true;
    if (scramjetFrame) scramjetFrame.reload();
    else {
      const frame = document.getElementById("proxy-frame");
      if (frame?.src) frame.src = frame.src;
    }
  };

  document.getElementById("error-home").onclick = () => {
    overlay.hidden = true;
    goHome();
  };
};

init().catch(console.error);

window.__blossomSyncSave = syncSave;
