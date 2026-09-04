
import { applyCloak, getCurrentCloak, launchAboutBlankCloak, cloakPreview } from "./cloak.js";
import { setPanicKey, setPanicUrl, getPanicKey, getPanicUrl } from "./panic.js";
import { setSearchEngine, getSearchEngine } from "./search.js";
import { clearAllChats } from "./ai.js";

const PANIC_PRESETS = [
  "https://classroom.google.com",
  "https://www.google.com",
  "https://www.khanacademy.org",
  "https://canvas.instructure.com",
];

function $(id) { return document.getElementById(id); }

function applyTheme(next) {
  const theme = next === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("blossom-theme", theme); } catch {}
  window.dispatchEvent(new Event("blossom:theme"));
}

function paintCloakPreview(name) {
  const img = $("cloak-preview-icon");
  const title = $("cloak-preview-title");
  const preview = cloakPreview(name);
  if (title) title.textContent = preview.title;
  if (img) {
    img.hidden = !preview.favicon;
    img.src = preview.favicon || "";
  }
}

export function initSettings() {
  const cloakSelect = $("setting-cloak");
  cloakSelect.value = getCurrentCloak();
  paintCloakPreview(cloakSelect.value);
  cloakSelect.addEventListener("change", () => {
    applyCloak(cloakSelect.value);
    paintCloakPreview(cloakSelect.value);
  });

  $("setting-abcloak").addEventListener("click", launchAboutBlankCloak);

  const panicKeyInput = $("setting-panic-key");
  panicKeyInput.value = getPanicKey();
  panicKeyInput.addEventListener("input", () => {
    if (panicKeyInput.value) setPanicKey(panicKeyInput.value);
  });

  const panicUrlSelect = $("setting-panic-url");
  const panicCustom = $("setting-panic-custom");
  const currentPanic = getPanicUrl();
  const isPreset = PANIC_PRESETS.includes(currentPanic);
  panicUrlSelect.value = isPreset ? currentPanic : "__custom__";
  if (panicCustom) {
    panicCustom.hidden = isPreset;
    if (!isPreset) panicCustom.value = currentPanic;
  }
  panicUrlSelect.addEventListener("change", () => {
    if (panicUrlSelect.value === "__custom__") {
      if (panicCustom) panicCustom.hidden = false;
      const typed = panicCustom?.value?.trim();
      if (typed) setPanicUrl(typed);
      return;
    }
    if (panicCustom) panicCustom.hidden = true;
    setPanicUrl(panicUrlSelect.value);
  });
  panicCustom?.addEventListener("change", () => {
    const typed = panicCustom.value.trim();
    if (!typed) return;
    try {
      const u = new URL(typed);
      if (u.protocol === "http:" || u.protocol === "https:") setPanicUrl(u.href);
    } catch {}
  });

  const searchSelect = $("setting-search-engine");
  searchSelect.value = getSearchEngine();
  searchSelect.addEventListener("change", () => {
    setSearchEngine(searchSelect.value);
    window.dispatchEvent(new Event("blossom-search-engine"));
  });

  const themeSelect = $("setting-theme");
  if (themeSelect) {
    themeSelect.value = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));
    window.addEventListener("blossom:theme", () => {
      themeSelect.value = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    });
  }

  const radiusSelect = $("setting-radius");
  if (radiusSelect) {
    radiusSelect.value = document.documentElement.classList.contains("sharp") ? "sharp" : "rounded";
    radiusSelect.addEventListener("change", () => {
      document.documentElement.classList.toggle("sharp", radiusSelect.value === "sharp");
      try { localStorage.setItem("blossom-radius", radiusSelect.value); } catch {}
    });
  }

  const calm = $("setting-calm");
  if (calm) {
    calm.checked = document.documentElement.classList.contains("calm");
    calm.addEventListener("change", () => {
      document.documentElement.classList.toggle("calm", calm.checked);
      try { localStorage.setItem("blossom-calm", calm.checked ? "1" : "0"); } catch {}
    });
  }

  $("setting-clear-ai")?.addEventListener("click", () => {
    if (!confirm("Clear all Blossom AI chats on this device?")) return;
    clearAllChats();
    window.dispatchEvent(new Event("blossom:ai-cleared"));
  });

  const filter = $("settings-filter");
  filter?.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    document.querySelectorAll("#settings-panel [data-section]").forEach((sec) => {
      const hay = `${sec.dataset.section} ${sec.textContent}`.toLowerCase();
      sec.hidden = Boolean(q) && !hay.includes(q);
    });
  });
}
