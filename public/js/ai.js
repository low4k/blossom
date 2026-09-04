
const KEY = "blossom-ai-chats";
const SEEN_KEY = "blossom-ai-seen";
const MODEL = "Blossom AI";
const MAX_CHATS = 40;
const MAX_ATTACH = 3;
const MAX_ATTACH_BYTES = 1.2 * 1024 * 1024;

function loadAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveAll(list) {
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_CHATS)));
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

export const QUICK_REPLIES = [
  "Make that shorter",
  "Give me a checklist",
  "Explain it more simply",
  "Turn it into steps",
];

export function listChats() {
  return loadAll().sort((a, b) => {
    if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

export function searchChats(q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return listChats();
  return listChats().filter((c) => {
    const hay = [c.title, ...(c.messages || []).map((m) => m.content)].join(" ").toLowerCase();
    return hay.includes(needle);
  });
}

export function getChat(id) {
  return loadAll().find((c) => c.id === id) || null;
}

export function createChat() {
  const chat = { id: uid(), title: "New chat", model: MODEL, updatedAt: Date.now(), pinned: false, messages: [] };
  const all = loadAll();
  all.unshift(chat);
  saveAll(all);
  return chat;
}

export function deleteChat(id) {
  saveAll(loadAll().filter((c) => c.id !== id));
}

export function clearAllChats() {
  saveAll([]);
}

export function renameChat(id, title) {
  const all = loadAll();
  const chat = all.find((c) => c.id === id);
  if (!chat) return null;
  chat.title = titleFrom(title) || chat.title;
  chat.updatedAt = Date.now();
  saveAll(all);
  return chat;
}

export function pinChat(id, pinned) {
  const all = loadAll();
  const chat = all.find((c) => c.id === id);
  if (!chat) return null;
  chat.pinned = Boolean(pinned);
  chat.updatedAt = Date.now();
  saveAll(all);
  return chat;
}

export function appendMessage(id, role, content, extra = {}) {
  const all = loadAll();
  const chat = all.find((c) => c.id === id);
  if (!chat) return null;
  const msg = { role, content, ts: Date.now(), ...extra };
  chat.messages.push(msg);
  chat.updatedAt = Date.now();
  if (role === "user" && (!chat.title || chat.title === "New chat")) chat.title = titleFrom(content);
  saveAll(all);
  return chat;
}

export function replaceLastAssistant(id, content, extra = {}) {
  const all = loadAll();
  const chat = all.find((c) => c.id === id);
  if (!chat) return null;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    if (chat.messages[i].role === "assistant") {
      chat.messages[i].content = content;
      if (extra.usage) chat.messages[i].usage = extra.usage;
      if (extra.citations) chat.messages[i].citations = extra.citations;
      chat.updatedAt = Date.now();
      saveAll(all);
      return chat;
    }
  }
  return appendMessage(id, "assistant", content, extra);
}

export function removeLastAssistant(id) {
  const all = loadAll();
  const chat = all.find((c) => c.id === id);
  if (!chat) return null;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    if (chat.messages[i].role === "assistant") {
      chat.messages.splice(i, 1);
      chat.updatedAt = Date.now();
      saveAll(all);
      return chat;
    }
  }
  return chat;
}

export function updateMessage(id, index, content) {
  const all = loadAll();
  const chat = all.find((c) => c.id === id);
  if (!chat || !chat.messages[index]) return null;
  chat.messages[index].content = content;
  chat.messages[index].edited = true;
  chat.updatedAt = Date.now();
  saveAll(all);
  return chat;
}

export function setMessageFeedback(id, index, feedback) {
  const all = loadAll();
  const chat = all.find((c) => c.id === id);
  if (!chat || !chat.messages[index]) return null;
  chat.messages[index].feedback = feedback;
  saveAll(all);
  return chat;
}

export function trimAfter(id, index) {
  const all = loadAll();
  const chat = all.find((c) => c.id === id);
  if (!chat) return null;
  chat.messages = chat.messages.slice(0, index + 1);
  chat.updatedAt = Date.now();
  saveAll(all);
  return chat;
}

export function exportChat(id) {
  const chat = getChat(id);
  if (!chat) return "";
  return JSON.stringify(chat, null, 2);
}

export function exportTranscript(id) {
  const chat = getChat(id);
  if (!chat) return "";
  return (chat.messages || []).map((m) => `${m.role === "user" ? "You" : "Blossom"}: ${m.content}`).join("\n\n");
}

export function unreadCount() {
  try {
    const seen = Number(localStorage.getItem(SEEN_KEY) || 0);
    const latest = Math.max(0, ...loadAll().map((c) => c.updatedAt || 0));
    if (!latest || latest <= seen) return 0;
    const last = listChats()[0];
    const lastMsg = last?.messages?.[last.messages.length - 1];
    return lastMsg?.role === "assistant" ? 1 : 0;
  } catch {
    return 0;
  }
}

export function markAiSeen() {
  try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch {}
}

export function canStoreAttachment(file) {
  if (!file) return "No file";
  if (file.size > MAX_ATTACH_BYTES) return "File is too large (max ~1 MB)";
  if (!/^(image\/(png|jpeg|gif|webp)|text\/plain|application\/pdf)$/i.test(file.type)) {
    return "Use an image, text file, or PDF";
  }
  return "";
}

export function fileToAttachment(file) {
  return new Promise((resolve, reject) => {
    const err = canStoreAttachment(file);
    if (err) return reject(new Error(err));
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: String(file.name || "file").slice(0, 80),
      type: file.type,
      size: file.size,
      dataUrl: reader.result,
    });
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

export { MAX_ATTACH };

let replySalt = 0;

export function offlineReply(prompt) {
  replySalt += 1;
  const q = String(prompt || "").toLowerCase();
  let body = "";
  if (/short(er)?|tl;?dr/.test(q)) {
    body = "Here's the short version:\n\n- Stay local — this chat never leaves the browser.\n- Pick a starter or type a prompt.\n- Copy, edit, or regenerate any turn.\n\nA real model can replace this canned reply later.";
  } else if (/checklist|steps|turn it into/.test(q)) {
    body = "## Checklist\n\n1. Open a **New chat** for each topic.\n2. Pin the ones you want to keep.\n3. Use **Edit** on your last message if you mistyped.\n4. Export a transcript before you clear history.\n\nThat's the whole loop.";
  } else if (/simpl/.test(q)) {
    body = "Think of Blossom AI as a **notepad that talks back**.\n\nIt isn't connected to a model yet, so every answer is a stand-in written on your device. The buttons around it (copy, voice, attach, regenerate) are real.";
  } else if (/stud/.test(q)) {
    body = "## 45-minute study block\n\n1. **0–5 min** — gather notes and silence notifications.\n2. **5–30 min** — one focused pass, no tabs.\n3. **30–38 min** — write 3 recall questions from memory.\n4. **38–45 min** — check answers, star what you missed.\n\nTomorrow, start with those starred bits.";
  } else if (/recurs/.test(q)) {
    body = "## Recursion, first time\n\nA function that **calls itself** to solve a smaller copy of the same problem, plus a **base case** so it stops.\n\n```js\nfunction fact(n) {\n  if (n <= 1) return 1; // base\n  return n * fact(n - 1);\n}\n```\n\nThe stack of calls unwinds once it hits `1`.";
  } else if (/draft|message|extension/.test(q)) {
    body = "Hi — I wanted to ask if I could have a short extension on the project. I've been keeping up with the work, but I need a little more time to turn in something I'm proud of. Would **Friday** still work on your side?\n\nThank you,\n[Your name]";
  } else if (/name|sakura|club/.test(q)) {
    body = "Eight names:\n\n- Night Petal Society\n- Yozakura Club\n- Pink Hour\n- Gate of Blossoms\n- After-Bloom\n- Soft Thorn\n- Lantern Grove\n- Hana After Dark\n\nWant them more formal or more chaotic?";
  } else {
    body = "Blossom AI is **not connected to a model yet**. This chat lives only on your device, so nothing was sent anywhere.\n\nYou can still:\n\n- Copy, edit, regenerate, or export\n- Pin and search threads\n- Drop in an image (it stays local)\n\nA real model can be wired in later without changing this layout.";
  }
  const tails = [
    "",
    "\n\nWant a shorter version?",
    "\n\nI can turn this into a checklist if you want.",
  ];
  return body + (replySalt > 1 ? tails[replySalt % tails.length] : "");
}

export function renderMarkdown(text) {
  const raw = String(text || "");
  const blocks = [];
  const fenced = raw.split(/```(\w*)\n?([\s\S]*?)```/g);
  for (let i = 0; i < fenced.length; i += 3) {
    const prose = fenced[i] || "";
    if (prose) blocks.push({ type: "prose", text: prose });
    const lang = fenced[i + 1];
    const code = fenced[i + 2];
    if (code !== undefined) blocks.push({ type: "code", lang: lang || "text", text: code.replace(/\n$/, "") });
  }
  return blocks.map((b, idx) => {
    if (b.type === "code") {
      const esc = escapeHtml(b.text);
      return `<pre class="ai-code" data-code-idx="${idx}"><div class="ai-code-bar"><span>${escapeHtml(b.lang)}</span><button type="button" class="ai-code-copy">Copy</button></div><code>${esc}</code></pre>`;
    }
    return formatProse(b.text);
  }).join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function tableCells(line) {
  const raw = String(line).trim();
  if (!raw.includes("|")) return null;
  const parts = raw.split("|");
  if (raw.startsWith("|")) parts.shift();
  if (raw.endsWith("|")) parts.pop();
  const cells = parts.map((c) => c.trim());
  if (cells.length < 2) return null;
  return cells;
}

function formatProse(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let list = null;
  let table = null;
  const flushList = () => {
    if (list) { html += list === "ol" ? "</ol>" : "</ul>"; list = null; }
  };
  const flushTable = () => {
    if (!table) return;
    html += "<div class=\"ai-table-wrap\"><table class=\"ai-table\"><thead><tr>";
    html += table.head.map((c) => `<th>${inline(c)}</th>`).join("");
    html += "</tr></thead><tbody>";
    for (const row of table.body) {
      html += "<tr>" + row.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
    }
    html += "</tbody></table></div>";
    table = null;
  };
  for (const line of lines) {
    const cells = tableCells(line);
    const isSep = cells && cells.every((c) => /^:?-+:?$/.test(c));
    if (cells && (!table || isSep || table)) {
      flushList();
      if (!table && !isSep) table = { head: cells, body: [] };
      else if (table && isSep) { /* header separator */ }
      else if (table) table.body.push(cells);
      continue;
    }
    flushTable();
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const ol = line.match(/^\d+\.\s+(.+)$/);
    const ul = line.match(/^[-*]\s+(.+)$/);
    const quote = line.match(/^>\s?(.*)$/);
    if (heading) {
      flushList();
      const n = heading[1].length;
      html += `<h${n + 2}>${inline(heading[2])}</h${n + 2}>`;
    } else if (line.trim() === "---") {
      flushList();
      html += "<hr />";
    } else if (ol) {
      if (list !== "ol") { flushList(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(ol[1])}</li>`;
    } else if (ul) {
      if (list !== "ul") { flushList(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(ul[1])}</li>`;
    } else if (quote) {
      flushList();
      html += `<blockquote>${inline(quote[1])}</blockquote>`;
    } else if (!line.trim()) {
      flushList();
    } else {
      flushList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  flushList();
  flushTable();
  return html;
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export { MODEL };
