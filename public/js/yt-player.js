
import { watchHref } from "./dest.js";
import { spring, stagger, reduceMotion } from "./motion.js";

const PIPED = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.private.coffee",
  "https://pipedapi.meow.lgbt",
  "https://pipedapi.reallyaweso.me",
];

const YT_ID = /^[\w-]{11}$/;
const RECENTS_KEY = "blossom-yt-recents";
const SEARCH_CHIPS = ["lofi", "gaming", "news", "music", "science", "anime"];

function $(id) { return document.getElementById(id); }

function fmtViews(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B views`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M views`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K views`;
  return v ? `${v} views` : "";
}

function fmtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.floor(s % 60);
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function loadRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => YT_ID.test(x?.id)) : [];
  } catch {
    return [];
  }
}

function saveRecents(list) {
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 12))); } catch {}
}

function muxedStreams(data) {
  const streams = Array.isArray(data?.videoStreams) ? data.videoStreams : [];
  const muxed = streams.filter((s) => s && s.url && s.videoOnly === false);
  muxed.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
  return muxed;
}

export function createWatchController({ encodeUrl, ensureTransport, playEmbed, onLocation, toast }) {
  let busy = false;
  let currentId = "";
  let currentData = null;
  let lastTime = 0;

  function setStatus(text, kind = "") {
    const el = $("yt-status");
    if (!el) return;
    el.textContent = text || "";
    el.dataset.kind = kind;
    el.hidden = !text;
  }

  function setFail(show, id) {
    const el = $("yt-fail");
    if (!el) return;
    el.hidden = !show;
    el.dataset.id = id || "";
  }

  async function proxied(url) {
    if (ensureTransport) await ensureTransport();
    const encoded = encodeUrl ? encodeUrl(url) : null;
    const target = encoded || url;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 14000);
    try {
      const r = await fetch(target, { signal: ctrl.signal });
      const ct = r.headers.get("content-type") || "";
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (ct.includes("application/json") || ct.includes("text/json") || ct.includes("javascript")) {
        return await r.json();
      }
      const text = await r.text();
      if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) return JSON.parse(text);
      throw new Error("not json");
    } finally {
      clearTimeout(t);
    }
  }

  async function firstOk(paths) {
    let last = null;
    for (const base of PIPED) {
      for (const path of paths) {
        try {
          return await proxied(base + path);
        } catch (err) {
          last = err;
        }
      }
    }
    throw last || new Error("No YouTube backends answered");
  }

  function pickMuxed(data, quality) {
    const muxed = muxedStreams(data);
    if (!muxed.length) return data?.hls || "";
    if (quality) {
      const hit = muxed.find((s) => String(s.quality || s.qualityLabel || "") === quality);
      if (hit) return hit.url;
    }
    const mid = muxed.find((s) => /720|480|360/.test(String(s.quality || s.qualityLabel || ""))) || muxed[0];
    return mid?.url || data?.hls || "";
  }

  function fillQuality(data) {
    const sel = $("yt-quality");
    if (!sel) return;
    const muxed = muxedStreams(data);
    sel.innerHTML = "";
    if (!muxed.length) {
      sel.hidden = true;
      return;
    }
    sel.hidden = false;
    for (const s of muxed) {
      const opt = document.createElement("option");
      const label = s.quality || s.qualityLabel || `${Math.round((s.bitrate || 0) / 1000)}k`;
      opt.value = String(s.quality || s.qualityLabel || "");
      opt.textContent = label;
      sel.appendChild(opt);
    }
    const mid = muxed.find((s) => /720|480|360/.test(String(s.quality || s.qualityLabel || ""))) || muxed[0];
    sel.value = String(mid.quality || mid.qualityLabel || "");
  }

  function paintRelated(items) {
    const box = $("yt-related");
    if (!box) return;
    box.innerHTML = "";
    const list = (items || []).filter((it) => {
      const id = YT_ID.test(it.id) ? it.id : String(it.url || "").split("v=")[1]?.slice(0, 11);
      it.id = id;
      return YT_ID.test(id || "");
    }).slice(0, 10);
    box.hidden = !list.length;
    for (const it of list) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "yt-related-card";
      const thumb = it.thumbnail || it.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg`;
      btn.innerHTML = `<img alt="" /><span><strong></strong><small></small></span>`;
      const img = btn.querySelector("img");
      img.src = (encodeUrl && thumb) ? encodeUrl(thumb) : thumb;
      btn.querySelector("strong").textContent = it.title || "Video";
      btn.querySelector("small").textContent = [it.uploaderName || it.uploader, it.duration ? fmtTime(it.duration) : ""].filter(Boolean).join(" · ");
      btn.addEventListener("click", () => open({ v: it.id }));
      box.appendChild(btn);
    }
  }

  function paintRecents() {
    const box = $("yt-recents");
    if (!box) return;
    const list = loadRecents();
    box.innerHTML = "";
    box.hidden = !list.length;
    for (const it of list) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "yt-recent";
      const thumb = it.thumb || `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg`;
      btn.innerHTML = `<img alt="" /><span></span>`;
      const img = btn.querySelector("img");
      img.src = encodeUrl ? encodeUrl(thumb) : thumb;
      btn.querySelector("span").textContent = it.title || "Video";
      btn.addEventListener("click", () => open({ v: it.id }));
      box.appendChild(btn);
    }
  }

  function remember(id, data) {
    const thumb = data.thumbnailUrl || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    const next = [{ id, title: data.title || "Video", thumb, uploader: data.uploader || data.uploaderName || "" }, ...loadRecents().filter((x) => x.id !== id)];
    saveRecents(next);
    paintRecents();
  }

  function paintResults(items, query) {
    const box = $("yt-results");
    if (!box) return;
    box.classList.remove("yt-skel");
    box.innerHTML = "";
    const list = (items || []).filter((it) => {
      const type = String(it.type || it.kind || "").toLowerCase();
      const fromUrl = String(it.url || "").split("v=")[1]?.slice(0, 11) || "";
      const id = YT_ID.test(it.id) ? it.id : fromUrl;
      it.id = id;
      return (type === "stream" || type === "video" || !type || YT_ID.test(id)) && YT_ID.test(id);
    }).slice(0, 24);

    const hero = $("yt-hero");
    if (hero) hero.hidden = list.length > 0 || Boolean(query);

    if (!list.length) {
      box.innerHTML = `<p class="yt-empty-copy">${query ? "No videos for that search." : "Search for a video to get started."}</p>`;
      return;
    }

    for (const it of list) {
      const id = YT_ID.test(it.id) ? it.id : (it.url || "").match(/[\w-]{11}/)?.[0];
      if (!YT_ID.test(id || "")) continue;
      const card = document.createElement("button");
      card.type = "button";
      card.className = "yt-card";
      const thumb = it.thumbnail || it.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
      const views = fmtViews(it.views);
      const when = it.uploadedDate || it.uploaded || "";
      card.innerHTML = `
        <span class="yt-card-thumb">
          <img alt="" />
          <span class="yt-card-dur">${it.duration ? fmtTime(it.duration) : ""}</span>
        </span>
        <span class="yt-card-meta">
          <span class="yt-card-title"></span>
          <span class="yt-card-sub"></span>
        </span>`;
      const img = card.querySelector("img");
      const encodedThumb = encodeUrl ? encodeUrl(thumb) : thumb;
      img.src = encodedThumb || thumb;
      img.alt = "";
      card.querySelector(".yt-card-title").textContent = it.title || "Video";
      card.querySelector(".yt-card-sub").textContent = [it.uploaderName || it.uploader, views, when].filter(Boolean).join(" · ");
      if (!it.duration) card.querySelector(".yt-card-dur").hidden = true;
      card.addEventListener("click", () => open({ v: id }));
      box.appendChild(card);
    }
    stagger(box.querySelectorAll(".yt-card"), [
      { opacity: 0, transform: "translateY(16px) scale(0.98)" },
      { opacity: 1, transform: "translateY(0) scale(1)" },
    ]);
  }

  function skeleton() {
    const box = $("yt-results");
    if (!box) return;
    box.classList.add("yt-skel");
    box.innerHTML = Array.from({ length: 8 }, () => `<div class="yt-card yt-skel-card"></div>`).join("");
  }

  async function search(q) {
    const query = String(q || "").trim().slice(0, 180);
    $("yt-stage")?.setAttribute("hidden", "");
    setFail(false);
    setStatus(query ? "Searching…" : "Loading trending…");
    skeleton();
    try {
      const data = query
        ? await firstOk([`/search?q=${encodeURIComponent(query)}&filter=all`])
        : await firstOk(["/trending", "/trending?region=US"]);
      const items = Array.isArray(data) ? data : (data.items || data.results || []);
      setStatus("");
      paintResults(items, query);
    } catch {
      setStatus("Could not reach a YouTube backend. Try again in a moment.", "error");
      paintResults([], query);
    }
  }

  function applyStream(src, poster) {
    const video = $("yt-video");
    if (!video || !src) return;
    lastTime = video.currentTime || lastTime;
    const encoded = encodeUrl ? encodeUrl(src) : src;
    video.pause();
    video.src = encoded || src;
    if (poster) video.poster = encodeUrl ? encodeUrl(poster) : poster;
    const resume = lastTime;
    video.addEventListener("loadedmetadata", () => {
      if (resume > 1 && Number.isFinite(resume)) {
        try { video.currentTime = resume; } catch {}
      }
    }, { once: true });
    const playP = video.play();
    if (playP) playP.catch(() => {});
  }

  async function play(id) {
    const video = $("yt-video");
    const stage = $("yt-stage");
    const title = $("yt-title");
    const sub = $("yt-sub");
    const desc = $("yt-desc");
    currentId = id;
    lastTime = 0;
    if (stage) stage.hidden = false;
    if (title) title.textContent = "Loading…";
    if (sub) sub.textContent = "";
    if (desc) { desc.textContent = ""; desc.hidden = true; }
    setFail(false);
    setStatus("Fetching streams…");
    $("yt-view")?.classList.add("yt-theater");
    try {
      const data = await firstOk([`/streams/${encodeURIComponent(id)}`]);
      currentData = data;
      if (title) title.textContent = data.title || "YouTube";
      if (sub) sub.textContent = [data.uploader || data.uploaderName, fmtViews(data.views)].filter(Boolean).join(" · ");
      if (desc) {
        const text = String(data.description || "").trim();
        desc.textContent = text;
        desc.hidden = !text;
        desc.classList.remove("open");
      }
      const hero = $("yt-hero");
      if (hero) hero.hidden = true;
      fillQuality(data);
      paintRelated(data.relatedStreams || data.related || []);
      remember(id, data);
      const src = pickMuxed(data, $("yt-quality")?.value);
      if (!src) throw new Error("no muxed stream");
      applyStream(src, data.thumbnailUrl);
      setStatus("");
      spring(stage, [
        { opacity: 0.6, transform: "translateY(10px)" },
        { opacity: 1, transform: "translateY(0)" },
      ], { duration: 380 });
    } catch {
      setStatus("Couldn't fetch a playable stream. Retry here, or open a lighter embed.", "error");
      setFail(true, id);
      if (video) video.removeAttribute("src");
    }
  }

  async function open({ v = "", q = "", push = true } = {}) {
    const href = watchHref({ v, q });
    if (push && typeof onLocation === "function") onLocation(href);
    const input = $("yt-search");
    if (input && q) input.value = q;
    if (v && YT_ID.test(v)) {
      if (busy) return;
      busy = true;
      try { await play(v); } finally { busy = false; }
      return;
    }
    $("yt-view")?.classList.remove("yt-theater");
    await search(q);
  }

  function wire() {
    const form = $("yt-search-form");
    const input = $("yt-search");
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = input?.value || "";
      open({ q, push: true });
    });
    $("yt-quality")?.addEventListener("change", () => {
      if (!currentData) return;
      applyStream(pickMuxed(currentData, $("yt-quality").value), currentData.thumbnailUrl);
    });
    $("yt-pip")?.addEventListener("click", async () => {
      const video = $("yt-video");
      if (!video || !document.pictureInPictureEnabled) {
        toast?.("Picture-in-picture isn't available here");
        return;
      }
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
      } catch {
        toast?.("Couldn't enter picture-in-picture");
      }
    });
    $("yt-copy")?.addEventListener("click", async () => {
      const href = location.origin + watchHref({ v: currentId });
      try { await navigator.clipboard.writeText(href); toast?.("Watch link copied"); } catch { toast?.("Could not copy"); }
    });
    $("yt-desc-toggle")?.addEventListener("click", () => {
      $("yt-desc")?.classList.toggle("open");
    });
    $("yt-retry")?.addEventListener("click", () => {
      if (currentId) open({ v: currentId, push: false });
    });
    $("yt-embed")?.addEventListener("click", () => {
      const id = $("yt-fail")?.dataset.id || currentId;
      if (id && typeof playEmbed === "function") playEmbed(id);
    });
    document.querySelectorAll("#yt-chips [data-q]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const q = btn.getAttribute("data-q") || "";
        if (input) input.value = q;
        open({ q, push: true });
      });
    });
    document.addEventListener("keydown", (e) => {
      if ($("yt-view")?.hidden) return;
      if (e.target.closest("input, textarea, select, button")) return;
      const video = $("yt-video");
      if (!video) return;
      if (e.key === " " || e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (video.paused) video.play().catch(() => {});
        else video.pause();
      }
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen?.();
        else video.requestFullscreen?.();
      }
    });
    paintRecents();
    const chips = $("yt-chips");
    if (chips && !chips.childElementCount) {
      for (const q of SEARCH_CHIPS) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.q = q;
        b.textContent = q;
        b.addEventListener("click", () => {
          if (input) input.value = q;
          open({ q, push: true });
        });
        chips.appendChild(b);
      }
    }
    if (!reduceMotion()) {
      const hero = $("yt-hero");
      if (hero) spring(hero, [
        { opacity: 0, transform: "translateY(12px)" },
        { opacity: 1, transform: "translateY(0)" },
      ]);
    }
  }

  return { wire, open, search };
}
