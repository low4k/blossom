
const KEY = "blossom-ai-chats";
const MODEL = "Blossom AI (offline)";
const OFFLINE_REPLY = "Blossom AI is not connected to a model yet. This chat lives only on your device, so nothing was sent anywhere. The composer, history, copy, regenerate, and export already work — a real model can be wired in later.";

function loadAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveAll(list) {
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 40)));
}

function uid() {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function titleFrom(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.slice(0, 42) || "New chat";
}

export const STARTERS = [
  { label: "Plan a study session", prompt: "Help me plan a 45-minute study session for tomorrow." },
  { label: "Explain a concept", prompt: "Explain recursion like I am seeing it for the first time." },
  { label: "Draft a message", prompt: "Draft a polite message asking for an extension on a project." },
  { label: "Brainstorm names", prompt: "Brainstorm 8 names for a small sakura-themed club." },
];

export function listChats() {
  return loadAll().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getChat(id) {
  return loadAll().find((c) => c.id === id) || null;
}

export function createChat() {
  const chat = { id: uid(), title: "New chat", model: MODEL, updatedAt: Date.now(), messages: [] };
  const all = loadAll();
  all.unshift(chat);
  saveAll(all);
  return chat;
}

export function deleteChat(id) {
  saveAll(loadAll().filter((c) => c.id !== id));
}

export function appendMessage(id, role, content) {
  const all = loadAll();
  const chat = all.find((c) => c.id === id);
  if (!chat) return null;
  chat.messages.push({ role, content, ts: Date.now() });
  chat.updatedAt = Date.now();
  if (role === "user" && (!chat.title || chat.title === "New chat")) chat.title = titleFrom(content);
  saveAll(all);
  return chat;
}

export function replaceLastAssistant(id, content) {
  const all = loadAll();
  const chat = all.find((c) => c.id === id);
  if (!chat) return null;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    if (chat.messages[i].role === "assistant") {
      chat.messages[i].content = content;
      chat.updatedAt = Date.now();
      saveAll(all);
      return chat;
    }
  }
  return appendMessage(id, "assistant", content);
}

export function exportChat(id) {
  const chat = getChat(id);
  if (!chat) return "";
  return JSON.stringify(chat, null, 2);
}

export function offlineReply() {
  return OFFLINE_REPLY;
}

export function renderMarkdown(text) {
  const esc = String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

export { MODEL };
