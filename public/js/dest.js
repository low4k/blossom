
// Destinations that stall or trip bot-walls under scramjet-alpha get a
// first-party stand-in. YouTube's official shell is a black frame; public
// Invidious hosts (yewtu.be and friends) sit behind Anubis, whose proof-of-work
// dies in the proxied iframe (`no_id_generated`). Watch/search therefore land
// on Blossom's own /watch player, which talks to Piped JSON through the proxy.

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; }
}

const YT_ID = /^[\w-]{11}$/;

function isYouTubeHost(host) {
  if (!host) return false;
  if (
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com" ||
    host === "youtube-nocookie.com" ||
    host === "youtu.be" ||
    host === "yewtu.be"
  ) return true;
  if (host.endsWith(".youtube.com")) return true;
  if (host.includes("invidious") || host.includes("yewtu")) return true;
  if (host === "piped.video" || host.startsWith("piped.")) return true;
  return false;
}

function videoIdFrom(u) {
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  if (host === "youtu.be") {
    const id = u.pathname.replace(/^\//, "").split("/")[0];
    return YT_ID.test(id) ? id : "";
  }
  const v = u.searchParams.get("v");
  if (YT_ID.test(v || "")) return v;
  if (u.pathname.startsWith("/embed/") || u.pathname.startsWith("/shorts/") || u.pathname.startsWith("/live/")) {
    const id = u.pathname.split("/")[2] || "";
    return YT_ID.test(id) ? id : "";
  }
  if (u.pathname.startsWith("/watch")) {
    const id = u.searchParams.get("v") || "";
    return YT_ID.test(id) ? id : "";
  }
  return "";
}

export function isWatchPath(url) {
  if (typeof url !== "string") return false;
  if (url.startsWith("/watch")) return true;
  try { return new URL(url, "https://blossom.invalid").pathname === "/watch"; } catch { return false; }
}

export function watchHref({ v = "", q = "" } = {}) {
  const p = new URLSearchParams();
  if (YT_ID.test(v)) p.set("v", v);
  if (q) p.set("q", String(q).slice(0, 180));
  const qs = p.toString();
  return qs ? `/watch?${qs}` : "/watch";
}

export function rewriteDestination(url) {
  if (isWatchPath(url)) {
    try {
      const u = new URL(url, "https://blossom.invalid");
      return watchHref({ v: u.searchParams.get("v") || "", q: u.searchParams.get("q") || "" });
    } catch {
      return "/watch";
    }
  }

  let u;
  try { u = new URL(url); } catch { return url; }
  const host = hostOf(url);

  // Lightweight embed is a last-resort playback path — leave it alone so the
  // proxy can load it without bouncing back into /watch.
  if (host === "youtube-nocookie.com" && u.pathname.startsWith("/embed/")) return url;

  if (host === "youtu.be" || isYouTubeHost(host)) {
    const id = videoIdFrom(u);
    if (id) return watchHref({ v: id });
    const q = u.searchParams.get("search_query") || u.searchParams.get("q") || "";
    if (u.pathname.startsWith("/results") || u.pathname.startsWith("/search")) {
      return watchHref({ q });
    }
    return "/watch";
  }

  return url;
}

const HEAVY = /youtube|youtu\.be|yewtu\.be|invidious|piped|discord|spotify|twitch/i;

export function skipSaveFor(url) {
  if (isWatchPath(url)) return true;
  try { return HEAVY.test(new URL(url).hostname); } catch { return false; }
}
