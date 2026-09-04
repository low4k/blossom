
// Destinations that stall under scramjet-alpha get a lighter stand-in.
// YouTube's JS shell often renders a black frame; Invidious still plays the videos.

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; }
}

export function rewriteDestination(url) {
  let u;
  try { u = new URL(url); } catch { return url; }
  const host = hostOf(url);

  if (host === "youtu.be") {
    const id = u.pathname.replace(/^\//, "").split("/")[0];
    return id ? `https://yewtu.be/watch?v=${encodeURIComponent(id)}` : "https://yewtu.be/";
  }

  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com" || host === "youtube-nocookie.com") {
    const v = u.searchParams.get("v");
    if (v) return `https://yewtu.be/watch?v=${encodeURIComponent(v)}`;
    if (u.pathname.startsWith("/embed/")) {
      const id = u.pathname.split("/")[2] || "";
      return id ? `https://yewtu.be/watch?v=${encodeURIComponent(id)}` : "https://yewtu.be/";
    }
    if (u.pathname.startsWith("/results") || u.pathname.startsWith("/search")) {
      const q = u.searchParams.get("search_query") || u.searchParams.get("q") || "";
      return q ? `https://yewtu.be/search?q=${encodeURIComponent(q)}` : "https://yewtu.be/";
    }
    if (u.pathname.startsWith("/@") || u.pathname.startsWith("/channel/") || u.pathname.startsWith("/c/")) {
      return `https://yewtu.be${u.pathname}${u.search}`;
    }
    if (u.pathname.startsWith("/watch")) return "https://yewtu.be/";
    if (u.pathname === "/" || u.pathname === "/feed/trending" || u.pathname.startsWith("/feed")) return "https://yewtu.be/";
    return `https://yewtu.be${u.pathname}${u.search}`;
  }

  return url;
}

const HEAVY = /youtube|youtu\.be|yewtu\.be|invidious|piped|discord|spotify|twitch/i;

export function skipSaveFor(url) {
  try { return HEAVY.test(new URL(url).hostname); } catch { return false; }
}
