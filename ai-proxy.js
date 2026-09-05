
import config, { AI_MODELS } from "./config.js";

const MAX_MESSAGES = 24;
const MAX_TEXT = 8000;
const SYSTEM = "You are Blossom AI, the in-app assistant for Blossom. Be concise, clear, and useful. Use Markdown when it helps. You are not a human; if someone needs a person, say so. Do not claim you can browse their school network or bypass filters.";

const ALLOWED = new Map();
for (const m of AI_MODELS) {
  ALLOWED.set(m.id, m.id);
  ALLOWED.set(m.id.toLowerCase(), m.id);
  for (const alias of m.aliases || []) ALLOWED.set(String(alias).toLowerCase(), m.id);
}

let catalog = { at: 0, ids: [] };

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

function compact(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pickAvailableId(canonical, available) {
  if (!available.length) return canonical;
  const want = canonical.toLowerCase();
  if (available.some((id) => id.toLowerCase() === want)) return canonical;
  const cWant = compact(canonical);
  const fuzzy = available.find((id) => {
    const c = compact(id);
    return c === cWant || c.includes(cWant) || cWant.includes(c);
  });
  return fuzzy || canonical;
}

async function listUpstreamIds() {
  if (Date.now() - catalog.at < 10 * 60 * 1000 && catalog.ids.length) return catalog.ids;
  try {
    const r = await fetch(`${config.ai.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.ai.apiKey}` },
    });
    if (!r.ok) return catalog.ids;
    const j = await r.json();
    const ids = (Array.isArray(j.data) ? j.data : []).map((m) => m?.id).filter(Boolean);
    if (ids.length) catalog = { at: Date.now(), ids };
    return ids;
  } catch {
    return catalog.ids;
  }
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

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text") return part.text || "";
    if (part?.type === "image_url") return "[image]";
    return "";
  }).join("\n").trim();
}

function toUpstreamMessages(input, { noSystem = false, textOnly = false } = {}) {
  const rows = Array.isArray(input) ? input : [];
  const recent = rows.filter((m) => m && (m.role === "user" || m.role === "assistant")).slice(-MAX_MESSAGES);
  const mapped = [];
  for (const m of recent) {
    let content = m.role === "assistant" ? clipText(m.content) : toUpstreamContent(m);
    if (textOnly) content = flattenContent(content);
    mapped.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content,
    });
  }
  if (noSystem) {
    if (mapped[0]?.role === "user") {
      mapped[0] = { role: "user", content: `${SYSTEM}\n\n${flattenContent(mapped[0].content)}` };
    }
    return mapped;
  }
  return [{ role: "system", content: SYSTEM }, ...mapped];
}

function redact(s) {
  return String(s || "").replace(/sk-[a-z0-9]+/gi, "[redacted]").slice(0, 220);
}

function summarizeProviderError(status, text) {
  try {
    const j = JSON.parse(text);
    const msg = j.error?.message || j.message || "";
    const code = j.error?.code || j.error?.type || "";
    return {
      status,
      code: String(code),
      message: redact(msg) || (status === 400 ? "The model rejected that request" : "The AI provider rejected the request"),
    };
  } catch {
    return { status, code: "", message: status >= 500 ? "provider error" : "invalid request" };
  }
}

async function callUpstream(payload, { stream, signal }) {
  return fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.ai.apiKey}`,
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
}

export async function handleAiChat(req, res) {
  if (req.user?.features?.ai === false) {
    return res.status(403).json({ error: "AI is not enabled for your account" });
  }
  if (!config.ai.apiKey) {
    return res.status(503).json({ error: "AI is not configured on this server", offline: true });
  }

  const body = req.body || {};
  const requested = resolveModel(body.model);
  const available = await listUpstreamIds();
  const model = pickAvailableId(requested, available);
  if (toUpstreamMessages(body.messages).length < 2) {
    return res.status(400).json({ error: "A message is required" });
  }

  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());

  const attempts = [
    { stream: true, noSystem: false, textOnly: false, web: Boolean(body.web) },
  ];
  if (body.web) attempts.push({ stream: true, noSystem: false, textOnly: false, web: false });
  attempts.push(
    { stream: true, noSystem: true, textOnly: false, web: false },
    { stream: false, noSystem: false, textOnly: true, web: false },
  );

  let lastErr = { status: 502, code: "", message: "The AI provider rejected the request" };

  function writeJsonAsSse(json) {
    const text = json.choices?.[0]?.message?.content || json.choices?.[0]?.delta?.content || "";
    if (!text) return false;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }], usage: json.usage || null })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return true;
  }

  for (const attempt of attempts) {
    const payload = {
      model,
      messages: toUpstreamMessages(body.messages, attempt),
      stream: attempt.stream,
    };
    if (attempt.web) payload.web_search_options = {};
    let upstream;
    try {
      upstream = await callUpstream(payload, { stream: attempt.stream, signal: ctrl.signal });
    } catch (err) {
      if (err?.name === "AbortError") return res.end();
      lastErr = { status: 502, code: "", message: "Could not reach the AI provider" };
      continue;
    }
    if (!upstream.ok) {
      let detail = "";
      try { detail = await upstream.text(); } catch {}
      lastErr = summarizeProviderError(upstream.status, detail);
      console.error("[ai] provider status", lastErr.status, lastErr.code || lastErr.message);
      if (upstream.status === 401 || upstream.status === 403) break;
      continue;
    }

    const ctype = String(upstream.headers.get("content-type") || "");
    if (!attempt.stream || ctype.includes("application/json")) {
      let json;
      try { json = await upstream.json(); } catch {
        lastErr = { status: 502, code: "", message: "Could not read the AI reply" };
        continue;
      }
      if (writeJsonAsSse(json)) return;
      lastErr = { status: 502, code: "", message: "Empty reply from the model" };
      continue;
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
    return;
  }

  return res.status(502).json({
    error: lastErr.message || "The AI provider rejected the request",
  });
}

export { resolveModel };
