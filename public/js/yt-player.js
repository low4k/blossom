
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

export function createWatchController({ encodeUrl, ensureTransport, playEmbed, onLocation, toast }) {
  let busy = false;

  function setStatus(text, kind = "") {
    const el = $("yt-status");
    if (!el) return;
    el.textContent = text || "";
    el.dataset.kind = kind;
    el.hidden = !text;
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

  function muxedUrl(data) {
    const streams = Array.isArray(data?.videoStreams) ? data.videoStreams : [];
    const muxed = streams.filter((s) => s && s.url && s.videoOnly === false);
    muxed.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
    const mid = muxed.find((s) => /720|480|360/.test(String(s.quality || s.qualityLabel || ""))) || muxed[0];
    return mid?.url || data?.hls || "";
  }

  function paintResults(items, query) {
    const box = $("yt-results");
    if (!box) return;
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

  async function search(q) {
    const query = String(q || "").trim().slice(0, 180);
    $("yt-stage")?.setAttribute("hidden", "");
    setStatus(query ? "Searching…" : "Loading trending…");
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

  async function play(id) {
    const video = $("yt-video");
    const stage = $("yt-stage");
    const title = $("yt-title");
    const sub = $("yt-sub");
    if (stage) stage.hidden = false;
    if (title) title.textContent = "Loading…";
    if (sub) sub.textContent = "";
    setStatus("Fetching streams…");
    try {
      const data = await firstOk([`/streams/${encodeURIComponent(id)}`]);
      if (title) title.textContent = data.title || "YouTube";
      if (sub) sub.textContent = [data.uploader || data.uploaderName, fmtViews(data.views)].filter(Boolean).join(" · ");
      const hero = $("yt-hero");
      if (hero) hero.hidden = true;
      const src = muxedUrl(data);
      if (!src) throw new Error("no muxed stream");
      const encoded = encodeUrl ? encodeUrl(src) : src;
      if (video) {
        video.pause();
        video.src = encoded || src;
        video.poster = encodeUrl && data.thumbnailUrl ? encodeUrl(data.thumbnailUrl) : (data.thumbnailUrl || "");
        const playP = video.play();
        if (playP) playP.catch(() => {});
      }
      setStatus("");
      spring(stage, [
        { opacity: 0.6, transform: "translateY(10px)" },
        { opacity: 1, transform: "translateY(0)" },
      ], { duration: 380 });
    } catch {
      setStatus("Stream fetch failed — opening a lighter YouTube embed.", "error");
      if (typeof playEmbed === "function") playEmbed(id);
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
