// Blossom — main app controller
// Wires all modules together and handles UI interactions

import { registerSW } from "./register-sw.js";
import { resolveInput } from "./search.js";
import { applyCloak } from "./cloak.js";
import { initPanic } from "./panic.js";
import { loadGames, filterGames, getAllTags, toggleFavorite, isFavorite, recordGamePlayed } from "./games.js";
import { getBookmarks, addBookmark, removeBookmark } from "./bookmarks.js";
import { getHistory, addToHistory, clearHistory } from "./history.js";
import { initMirrors } from "./mirrors.js";
import { initSettings } from "./settings.js";

// --- State ---
let config = {};
let scramjet = null;
let scramjetFrame = null;
let connection = null;
let proxyActive = false;

// --- Boot ---
async function init() {
  console.log("[Blossom] Initializing...");

  // Load server config
  try {
    const resp = await fetch("/blossom-config.json");
    config = await resp.json();
  } catch {
    config = { proxyPrefix: "/scram/", wispPath: "/wisp/", mirrors: [], version: "1.0.0" };
  }

  // Apply tab cloak immediately
  applyCloak();

  // Init panic key
  initPanic();

  // Init settings panel
  initSettings();

  // Init domain survival
  initMirrors(config.mirrors);

  // Version display
  const versionEl = document.getElementById("blossom-version");
  if (versionEl) versionEl.textContent = `v${config.version}`;

  // Register SW first — scramjet needs it running
  try {
    await registerSW();
    console.log("[Blossom] Service worker registered");
  } catch (err) {
    console.error("[Blossom] SW registration failed:", err);
  }

  // Init Scramjet
  await initScramjet();

  // Load games
  await loadGames();
  renderGamesTags();

  // Wire up UI
  wireSearch();
  wireQuickLinks();
  wirePanels();
  wireGames();
  wireBookmarks();
  wireHistoryPanel();

  // Check server health for status widget
  checkHealth();

  // Render recent visits on home
  renderRecentVisits();

  console.log("[Blossom] Ready");
}

// --- Scramjet Setup ---
async function initScramjet() {
  if (typeof $scramjetLoadController !== "function") {
    console.error("[Blossom] $scramjetLoadController not found. Check that /scram/scramjet.all.js is loaded.");
    return;
  }

  try {
    const { ScramjetController } = $scramjetLoadController();

    scramjet = new ScramjetController({
      prefix: config.proxyPrefix || "/scram/",
      files: {
        wasm: (config.proxyPrefix || "/scram/") + "scramjet.wasm.wasm",
        all: (config.proxyPrefix || "/scram/") + "scramjet.all.js",
        sync: (config.proxyPrefix || "/scram/") + "scramjet.sync.js",
      },
    });

    await scramjet.init();
    console.log("[Blossom] ScramjetController initialized");

    // Set up BareMux transport (epoxy -> wisp)
    if (typeof BareMux !== "undefined") {
      connection = new BareMux.BareMuxConnection("/baremux/worker.js");
      const wispUrl =
        (location.protocol === "https:" ? "wss" : "ws") +
        "://" + location.host + (config.wispPath || "/wisp/");

      await connection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl }]);
      console.log("[Blossom] Transport set: epoxy -> " + wispUrl);
    } else {
      console.error("[Blossom] BareMux not loaded. Check that /baremux/index.js is included.");
    }
  } catch (err) {
    console.error("[Blossom] Scramjet initialization failed:", err);
  }
}

// --- Navigation ---
async function navigateTo(url) {
  const searchError = document.getElementById("search-error");
  searchError.hidden = true;

  if (!scramjet) {
    searchError.textContent = "Proxy engine failed to load. Try refreshing the page.";
    searchError.hidden = false;
    console.error("[Blossom] navigateTo called but scramjet is null");
    return;
  }

  const resolved = resolveInput(url);
  if (!resolved) return;

  console.log("[Blossom] Navigating to:", resolved);

  // Record in history
  addToHistory(resolved, resolved);
  renderRecentVisits();

  // Show proxy frame
  const frameEl = document.getElementById("proxy-frame");
  const homeView = document.getElementById("home-view");

  homeView.style.display = "none";
  proxyActive = true;

  // Use ScramjetFrame for proper proxy navigation
  if (!scramjetFrame) {
    scramjetFrame = scramjet.createFrame(frameEl);
    scramjetFrame.addEventListener("urlchange", (e) => {
      console.log("[Blossom] URL changed:", e.url);
    });
  }

  frameEl.hidden = false;
  scramjetFrame.go(resolved);

  // Show CAPTCHA toast if navigating to a site that commonly triggers them
  const captchaSites = ["google.com", "youtube.com", "discord.com", "roblox.com"];
  if (captchaSites.some((s) => resolved.includes(s))) {
    setTimeout(() => showCaptchaToast(), 1500);
  }
}

function goHome() {
  const frame = document.getElementById("proxy-frame");
  const homeView = document.getElementById("home-view");

  frame.hidden = true;
  homeView.style.display = "";
  proxyActive = false;
  scramjetFrame = null;
}

// --- UI Wiring ---
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
  // Open panel buttons
  const panelMap = {
    "btn-games": "games-panel",
    "btn-bookmarks": "bookmarks-panel",
    "btn-history": "history-panel",
    "btn-settings": "settings-panel",
  };

  for (const [btnId, panelId] of Object.entries(panelMap)) {
    document.getElementById(btnId).addEventListener("click", () => {
      closeAllPanels();
      const panel = document.getElementById(panelId);
      panel.hidden = false;
      // Trigger animation
      requestAnimationFrame(() => panel.classList.add("open"));

      // Refresh panel content
      if (panelId === "bookmarks-panel") renderBookmarks();
      if (panelId === "history-panel") renderHistory();
    });
  }

  // Close buttons
  document.querySelectorAll(".panel-close").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panelId = btn.dataset.close;
      closePanel(panelId);
    });
  });

  // Close panel by clicking outside it
  document.addEventListener("click", (e) => {
    const openPanel = document.querySelector(".side-panel.open");
    if (!openPanel) return;
    // If click is inside the panel or on a topbar button, ignore
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

// --- Games Rendering ---
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

  // Initial render
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
      if (game.url) navigateTo(game.url);
    });

    container.appendChild(card);
  }
}

// --- Bookmarks Rendering ---
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

// --- History Rendering ---
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

    card.innerHTML = `<span class="quick-icon">🌐</span><span>${hostname}</span>`;
    card.addEventListener("click", () => navigateTo(h.url));
    container.appendChild(card);
  }
}

// --- Shared UI Helpers ---
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

// --- Health Check ---
async function checkHealth() {
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");

  try {
    const resp = await fetch("/health");
    if (resp.ok) {
      const data = await resp.json();
      dot.className = "dot dot-ok";
      text.textContent = `Online — ${data.uptime}s uptime`;
    } else {
      dot.className = "dot dot-fail";
      text.textContent = "Server error";
    }
  } catch {
    dot.className = "dot dot-fail";
    text.textContent = "Offline";
  }
}

// --- CAPTCHA Toast ---
function showCaptchaToast() {
  const toast = document.getElementById("captcha-toast");
  toast.hidden = false;

  // Auto-dismiss after 8 seconds
  const timeout = setTimeout(() => { toast.hidden = true; }, 8000);

  const closeBtn = toast.querySelector(".toast-close");
  closeBtn.addEventListener("click", () => {
    toast.hidden = true;
    clearTimeout(timeout);
  }, { once: true });
}

// --- General Toast ---
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

// --- Error Overlay ---
window.showProxyError = function (detail) {
  const overlay = document.getElementById("error-overlay");
  const detailEl = document.getElementById("error-detail");

  detailEl.textContent = detail || "The proxied site failed to load. It may be blocked, down, or require a different proxy engine.";
  overlay.hidden = false;

  document.getElementById("error-retry").onclick = () => {
    overlay.hidden = true;
    const frame = document.getElementById("proxy-frame");
    if (frame.src) frame.src = frame.src; // reload
  };

  document.getElementById("error-home").onclick = () => {
    overlay.hidden = true;
    goHome();
  };
};

// --- Init ---
init().catch(console.error);
