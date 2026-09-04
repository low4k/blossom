
import { resolveInput, engineLabel, looksLikeDestination } from "./search.js";

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function hay(...parts) {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

export function buildSuggestions(query, sources = {}) {
  const raw = String(query || "").trim();
  const q = raw.toLowerCase();
  const out = [];
  const seen = new Set();

  const push = (item) => {
    const key = `${item.kind}:${item.url || item.query}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  if (!q) {
    for (const h of (sources.history || []).slice(0, 6)) {
      push({ kind: "recent", label: h.title || hostOf(h.url), detail: hostOf(h.url), url: h.url });
    }
    return out;
  }

  if (q.startsWith("!")) {
    const resolved = resolveInput(raw);
    if (resolved && /\s/.test(raw)) {
      push({ kind: "bang", label: `Open ${hostOf(resolved)}`, detail: "shortcut", url: resolved });
    }
    const token = q.slice(1).split(/\s/)[0];
    const bangHelp = [
      ["!yt", "YouTube"],
      ["!w", "Wikipedia"],
      ["!r", "Reddit"],
      ["!gh", "GitHub"],
      ["!sp", "Spotify"],
      ["!maps", "Maps"],
    ].filter(([code]) => code.slice(1).startsWith(token) || token === "");
    for (const [code, name] of bangHelp.slice(0, 6)) {
      push({ kind: "bang", label: `${code} ${name}`, detail: "shortcut", query: raw.startsWith(code) ? raw : `${code} ` });
    }
  } else if (looksLikeDestination(raw)) {
    const dest = resolveInput(raw);
    push({ kind: "url", label: `Go to ${hostOf(dest)}`, detail: dest, url: dest });
  } else {
    push({
      kind: "search",
      label: `Search ${engineLabel()} for “${raw}”`,
      detail: engineLabel(),
      query: raw,
    });
  }

  for (const g of sources.games || []) {
    if (hay(g.name, g.id, ...(g.tags || [])).includes(q)) {
      push({ kind: "game", label: g.name, detail: "Game", url: g.url, catalogId: g.id });
    }
  }
  for (const a of sources.apps || []) {
    if (hay(a.name, a.id, ...(a.tags || [])).includes(q)) {
      push({ kind: "app", label: a.name, detail: "App", url: a.url, catalogId: a.id });
    }
  }
  for (const b of sources.bookmarks || []) {
    if (hay(b.title, b.url).includes(q)) {
      push({ kind: "bookmark", label: b.title || hostOf(b.url), detail: hostOf(b.url), url: b.url });
    }
  }
  for (const h of sources.history || []) {
    if (hay(h.title, h.url).includes(q)) {
      push({ kind: "recent", label: h.title || hostOf(h.url), detail: hostOf(h.url), url: h.url });
    }
  }

  return out.slice(0, 8);
}

const KIND_LABEL = {
  search: "Search",
  url: "Site",
  game: "Game",
  app: "App",
  bookmark: "Saved",
  recent: "Recent",
  bang: "Shortcut",
};

export function bindOmnibox({ input, list, clearBtn, onNavigate, getSources }) {
  if (!input || !list) return { refresh() {}, hide() {} };

  let items = [];
  let active = -1;

  const hide = () => {
    list.hidden = true;
    list.innerHTML = "";
    items = [];
    active = -1;
    input.setAttribute("aria-expanded", "false");
  };

  const paint = () => {
    for (const el of list.querySelectorAll("[role='option']")) {
      const on = Number(el.dataset.index) === active;
      el.classList.toggle("active", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
    }
    const cur = list.querySelector(`[data-index="${active}"]`);
    input.setAttribute("aria-activedescendant", cur?.id || "");
  };

  const render = () => {
    const q = input.value;
    items = buildSuggestions(q, getSources ? getSources() : {});
    active = items.length ? 0 : -1;
    list.innerHTML = "";
    if (!items.length) { hide(); return; }

    items.forEach((item, i) => {
      const li = document.createElement("li");
      li.id = `${list.id}-opt-${i}`;
      li.role = "option";
      li.dataset.index = String(i);
      li.setAttribute("aria-selected", i === 0 ? "true" : "false");
      if (i === 0) li.classList.add("active");

      const kind = document.createElement("span");
      kind.className = "suggest-kind";
      kind.textContent = KIND_LABEL[item.kind] || item.kind;

      const text = document.createElement("span");
      text.className = "suggest-label";
      text.textContent = item.label;

      li.appendChild(kind);
      li.appendChild(text);
      li.addEventListener("mousedown", (e) => e.preventDefault());
      li.addEventListener("click", () => choose(item));
      list.appendChild(li);
    });

    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    paint();
  };

  const choose = (item) => {
    hide();
    if (item.query != null && !item.url) {
      input.value = item.query.endsWith(" ") ? item.query : item.query;
      if (item.kind === "bang" && item.query.endsWith(" ")) {
        input.focus();
        render();
        return;
      }
      onNavigate(item.query);
      return;
    }
    onNavigate(item.url, item.catalogId || null);
  };

  const syncClear = () => {
    if (!clearBtn) return;
    clearBtn.hidden = !input.value;
  };

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");

  input.addEventListener("input", () => { syncClear(); render(); });
  input.addEventListener("focus", () => { syncClear(); render(); });
  input.addEventListener("blur", () => setTimeout(hide, 120));

  input.addEventListener("keydown", (e) => {
    if (list.hidden || !items.length) {
      if (e.key === "Escape") input.blur();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % items.length;
      paint();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + items.length) % items.length;
      paint();
    } else if (e.key === "Enter" && active >= 0 && items[active]) {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener("mousedown", (e) => e.preventDefault());
    clearBtn.addEventListener("click", () => {
      input.value = "";
      syncClear();
      input.focus();
      render();
    });
  }

  syncClear();
  return { refresh: render, hide };
}
