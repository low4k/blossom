

import { registerSW } from "./register-sw.js";
import { resolveInput } from "./search.js";
import { applyCloak } from "./cloak.js";
import { initPanic } from "./panic.js";
import { loadGames, filterGames, getAllTags, toggleFavorite, isFavorite, recordGamePlayed, getRecentGames, getFavorites, getGameById } from "./games.js";
import { getBookmarks, addBookmark, removeBookmark, isBookmarked, syncBookmarksFromServer } from "./bookmarks.js";
import { getHistory, addToHistory, clearHistory, updateHistoryTitle, syncHistoryFromServer } from "./history.js";
import { initMirrors } from "./mirrors.js";
import { initSettings } from "./settings.js";

let config = {};
let scramjet = null;
let scramjetFrame = null;
let connection = null;
let proxyActive = false;
let currentUser = null;
let currentProxyUrl = "";

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

  await initScramjet();

  await loadGames();
  renderGamesTags();

  wireSearch();
  wireQuickLinks();
  wirePanels();
  wireGames();
  wireGamesView();
  wireHistoryPanel();
  wireProxyToolbar();
  wireLogoClick();
  wireAccount();

  checkHealth();

  renderRecentVisits();

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

async function navigateTo(url) {
  const searchError = document.getElementById("search-error");
  searchError.hidden = true;

  if (!scramjet) {
    searchError.textContent = "Engine failed to load. Try refreshing the page.";
    searchError.hidden = false;
    console.error("[Blossom] navigateTo called but scramjet is null");
    return;
  }

  const resolved = resolveInput(url);
  if (!resolved) return;

  console.log("[Blossom] Navigating to:", resolved);

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

  const gamesView = document.getElementById("games-view");
  if (gamesView) gamesView.hidden = true;

  if (currentUser && currentUser.features?.proxy === false) {
    loadingOverlay.hidden = true;
    proxyToolbar.hidden = true;
    searchError.textContent = "Proxy access is not enabled for your account.";
    searchError.hidden = false;
    return;
  }

  if (proxyActive && scramjetFrame) {
    scramjetFrame.frame.addEventListener("load", () => {
      loadingOverlay.hidden = true;
    }, { once: true });
    setTimeout(() => { loadingOverlay.hidden = true; }, 10000);
    scramjetFrame.go(resolved);
    updateBookmarkButton(resolved);
    return;
  }

  const homeView = document.getElementById("home-view");
  homeView.style.display = "none";
  proxyActive = true;

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
        document.title = title + " \u2014 Blossom";
        updateHistoryTitle(e.url, title);
      } else {
        const hostname = new URL(e.url).hostname.replace("www.", "");
        document.title = hostname + " \u2014 Blossom";
      }
    } catch {
      try {
        const hostname = new URL(e.url).hostname.replace("www.", "");
        document.title = hostname + " \u2014 Blossom";
      } catch {}
    }
  });

  frame.frame.addEventListener("load", () => {
    try {
      const fw = frame.frame.contentWindow;
      if (fw) {
        fw.open = () => null;
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

  setTimeout(() => { loadingOverlay.hidden = true; }, 10000);

  const oldFrame = document.getElementById("proxy-frame");
  if (oldFrame) oldFrame.remove();

  document.getElementById("app").appendChild(frame.frame);
  scramjetFrame = frame;
  frame.go(resolved);

  updateBookmarkButton(resolved);

  const captchaSites = ["google.com", "youtube.com", "discord.com", "roblox.com"];
  if (captchaSites.some((s) => resolved.includes(s))) {
    setTimeout(() => showCaptchaToast(), 1500);
  }
}

function goHome() {
  const frame = document.getElementById("proxy-frame");
  const homeView = document.getElementById("home-view");
  const gamesView = document.getElementById("games-view");
  const proxyToolbar = document.getElementById("proxy-toolbar");
  const loadingOverlay = document.getElementById("loading-overlay");
  const expandBtn = document.getElementById("proxy-expand");

  if (frame) frame.remove();
  homeView.style.display = "";
  if (gamesView) gamesView.hidden = true;
  proxyToolbar.hidden = true;
  loadingOverlay.hidden = true;
  if (expandBtn) expandBtn.hidden = true;
  proxyActive = false;
  scramjetFrame = null;
  currentProxyUrl = "";

  applyCloak();
}

function wireSearch() {
  const form = document.getElementById("search-form");
  const input = document.getElementById("search-input");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    navigateTo(input.value);
  });
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
      if (openPanel) closePanel(openPanel.id);
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

function renderGamesTags() {
  const container = document.getElementById("games-tags");
  const tags = getAllTags();
  container.innerHTML = "";

  for (const tag of tags) {
    const btn = document.createElement("button");
    btn.className = `tag-btn${tag === "all" ? " active" : ""}`;
    btn.textContent = tag;
    btn.addEventListener("click", () => {
      container.querySelectorAll(".tag-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderGamesGrid(document.getElementById("games-search").value, tag);
    });
    container.appendChild(btn);
  }
}

function wireGames() {
  const searchInput = document.getElementById("games-search");
  searchInput.addEventListener("input", () => {
    const activeTagBtn = document.querySelector(".tag-btn.active");
    const tag = activeTagBtn?.textContent || "all";
    renderGamesGrid(searchInput.value, tag);
  });

  renderGamesGrid("", "all");
}

function renderGamesGrid(query, tag) {
  const container = document.getElementById("games-grid");
  const games = filterGames(query || "", tag || "all");
  container.innerHTML = "";

  if (games.length === 0) {
    container.innerHTML = '<p class="empty-state">No games found.</p>';
    return;
  }

  for (const game of games) {
    const card = document.createElement("div");
    card.className = "game-card";
    card.style.position = "relative";

    const thumb = document.createElement("img");
    thumb.className = "game-thumb";
    thumb.src = game.thumb || "";
    thumb.alt = game.name;
    thumb.loading = "lazy";
    thumb.onerror = () => { thumb.style.display = "none"; };

    const name = document.createElement("div");
    name.className = "game-name";
    name.textContent = game.name;

    const fav = document.createElement("button");
    fav.className = `game-fav${isFavorite(game.id) ? " active" : ""}`;
    fav.textContent = "★";
    fav.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavorite(game.id);
      fav.classList.toggle("active");
    });

    card.appendChild(thumb);
    card.appendChild(name);
    card.appendChild(fav);

    card.addEventListener("click", () => {
      recordGamePlayed(game);
      if (!game.url) return;

      if (game.url.startsWith("/")) {
        window.open(game.url, "_blank");
      } else {
        navigateTo(game.url);
      }
    });

    container.appendChild(card);
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
    if (!scramjetFrame) return;
    scramjetFrame.back();
  });
  document.getElementById("proxy-forward").addEventListener("click", () => {
    if (!scramjetFrame) return;
    scramjetFrame.forward();
  });
  document.getElementById("proxy-reload").addEventListener("click", () => {
    if (!scramjetFrame) return;
    scramjetFrame.reload();
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
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = urlInput.value.trim();
      if (!val) return;
      navigateTo(val);
    }
  });

  urlInput.addEventListener("focus", () => urlInput.select());

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

  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    urlInput.value = parsed.hostname + path;
    urlInput.title = parsed.href;
    currentProxyUrl = parsed.href;
  } catch {
    urlInput.value = url;
    currentProxyUrl = url;
  }
}

function updateBookmarkButton(url) {
  const btn = document.getElementById("proxy-bookmark");
  if (isBookmarked(url)) {
    btn.classList.add("bookmarked");
  } else {
    btn.classList.remove("bookmarked");
  }
}

function wireGamesView() {
  const gamesBtn = document.getElementById("btn-games");
  const backBtn = document.getElementById("games-back");
  if (gamesBtn) gamesBtn.addEventListener("click", showGamesView);
  if (backBtn) backBtn.addEventListener("click", hideGamesView);
}

function showGamesView() {
  closeAllPanels();
  if (proxyActive) goHome();
  const homeView = document.getElementById("home-view");
  const gamesView = document.getElementById("games-view");
  if (homeView) homeView.style.display = "none";
  if (gamesView) gamesView.hidden = false;
}

function hideGamesView() {
  const homeView = document.getElementById("home-view");
  const gamesView = document.getElementById("games-view");
  if (gamesView) gamesView.hidden = true;
  if (homeView) homeView.style.display = "";
}

function wireLogoClick() {
  const logo = document.querySelector(".topbar-left .logo");
  if (logo) {
    logo.style.cursor = "pointer";
    logo.addEventListener("click", () => {
      if (proxyActive) goHome();
      else hideGamesView();
    });
  }
}

function wireAccount() {
  const logoutBtn = document.getElementById("btn-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await fetch("/auth/logout", { method: "POST" });
      window.location.replace("/login");
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
  const settingsLogout = document.getElementById("setting-logout");
  if (settingsLogout) {
    settingsLogout.addEventListener("click", async () => {
      await fetch("/auth/logout", { method: "POST" });
      window.location.replace("/login");
    });
  }
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

function showCaptchaToast() {
  const toast = document.getElementById("captcha-toast");
  toast.hidden = false;

  const timeout = setTimeout(() => { toast.hidden = true; }, 8000);

  const closeBtn = toast.querySelector(".toast-close");
  closeBtn.addEventListener("click", () => {
    toast.hidden = true;
    clearTimeout(timeout);
  }, { once: true });
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
  };

  document.getElementById("error-home").onclick = () => {
    overlay.hidden = true;
    goHome();
  };
};

init().catch(console.error);
