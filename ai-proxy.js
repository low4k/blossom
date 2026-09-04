
import config, { AI_MODELS } from "./config.js";

const MAX_MESSAGES = 24;
const MAX_TEXT = 8000;
const SYSTEM = "You are Blossom AI, the in-app assistant for Blossom. Be concise, clear, and useful. Use Markdown when it helps. You are not a human; if someone needs a person, say so. Do not claim you can browse their school network or bypass filters.";

const ALLOWED = new Map();
for (const m of AI_MODELS) {
  ALLOWED.set(m.id, m.id);
  ALLOWED.set(m.id.toLowerCase(), m.id);
}

export function publicAiConfig() {
  return {
    configured: Boolean(config.ai.apiKey),
    models: AI_MODELS.map(({ id, label }) => ({ id, label })),
    defaultModel: config.ai.defaultModel,
  };
}

export function publicDonateConfig() {
  return {
    cashapp: config.donate.cashapp || "",
    paypal: config.donate.paypal || "",
  };
}

function resolveModel(name) {
  const raw = String(name || "").trim();
  return ALLOWED.get(raw) || ALLOWED.get(raw.toLowerCase()) || config.ai.defaultModel;
}

function clipText(s) {
  return String(s || "").slice(0, MAX_TEXT);
}

function toUpstreamContent(msg) {
  const text = clipText(msg.content);
  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  const images = atts.filter((a) => String(a.type || "").startsWith("image/") && a.dataUrl);
  const files = atts.filter((a) => !String(a.type || "").startsWith("image/"));
  let body = text;
  if (files.length) {
    body += (body ? "\n\n" : "") + files.map((f) => `[Attached file: ${String(f.name || "file").slice(0, 80)}]`).join("\n");
  }
  if (!images.length) return body || "(empty)";
  const parts = [{ type: "text", text: body || "Please look at the attached image." }];
  for (const img of images.slice(0, 2)) {
    parts.push({ type: "image_url", image_url: { url: String(img.dataUrl).slice(0, 1_200_000) } });
  }
  return parts;
}

function toUpstreamMessages(input) {
  const rows = Array.isArray(input) ? input : [];
  const out = [{ role: "system", content: SYSTEM }];
  const recent = rows.filter((m) => m && (m.role === "user" || m.role === "assistant")).slice(-MAX_MESSAGES);
  for (const m of recent) {
    out.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.role === "assistant" ? clipText(m.content) : toUpstreamContent(m),
    });
  }
  return out;
}

function extractCitations(payload) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const url = node.url || node.link || node.uri;
    const title = node.title || node.name || "";
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      found.push({ url, title: String(title).slice(0, 120) });
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(payload?.citations || payload?.annotations || payload?.choices?.[0]?.delta);
  const seen = new Set();
  return found.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  }).slice(0, 8);
}

export async function handleAiChat(req, res) {
  if (req.user?.features?.ai === false) {
    return res.status(403).json({ error: "AI is not enabled for your account" });
  }
  if (!config.ai.apiKey) {
    return res.status(503).json({ error: "AI is not configured on this server", offline: true });
  }

  const body = req.body || {};
  const model = resolveModel(body.model);
  const messages = toUpstreamMessages(body.messages);
  if (messages.length < 2) {
    return res.status(400).json({ error: "A message is required" });
  }

  const payload = {
    model,
    messages,
    stream: true,
    max_tokens: 2048,
  };
  if (body.web) payload.web_search_options = {};

  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());

  let upstream;
  try {
    upstream = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.ai.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") return res.end();
    console.error("[ai] upstream connect failed");
    return res.status(502).json({ error: "Could not reach the AI provider" });
  }

  if (!upstream.ok) {
    let detail = "";
    try { detail = await upstream.text(); } catch {}
    const looksLikeWeb = body.web && /web_search|unsupported/i.test(detail);
    if (looksLikeWeb) {
      delete payload.web_search_options;
      try {
        upstream = await fetch(`${config.ai.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.ai.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
      } catch {
        return res.status(502).json({ error: "Could not reach the AI provider" });
      }
    }
    if (!upstream.ok) {
      console.error("[ai] provider status", upstream.status);
      return res.status(502).json({ error: "The AI provider rejected the request" });
    }
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  if (!upstream.body) {
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err) {
    if (err?.name !== "AbortError") console.error("[ai] stream error");
  } finally {
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

export { extractCitations, resolveModel };
