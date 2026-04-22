

import { applyCloak, getCurrentCloak, launchAboutBlankCloak } from "./cloak.js";
import { setPanicKey, setPanicUrl, getPanicKey, getPanicUrl } from "./panic.js";
import { setSearchEngine, getSearchEngine } from "./search.js";

export function initSettings() {

  const cloakSelect = document.getElementById("setting-cloak");
  cloakSelect.value = getCurrentCloak();
  cloakSelect.addEventListener("change", () => applyCloak(cloakSelect.value));

  document.getElementById("setting-abcloak").addEventListener("click", launchAboutBlankCloak);

  const panicKeyInput = document.getElementById("setting-panic-key");
  panicKeyInput.value = getPanicKey();
  panicKeyInput.addEventListener("input", () => {
    if (panicKeyInput.value) setPanicKey(panicKeyInput.value);
  });

  const panicUrlSelect = document.getElementById("setting-panic-url");
  panicUrlSelect.value = getPanicUrl();
  panicUrlSelect.addEventListener("change", () => setPanicUrl(panicUrlSelect.value));

  const searchSelect = document.getElementById("setting-search-engine");
  searchSelect.value = getSearchEngine();
  searchSelect.addEventListener("change", () => setSearchEngine(searchSelect.value));
}
