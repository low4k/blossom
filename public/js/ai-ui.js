
import {
  listChats, searchChats, getChat, createChat, deleteChat, renameChat, pinChat,
  appendMessage, replaceLastAssistant, updateMessage, setMessageFeedback, trimAfter,
  exportChat, exportTranscript, offlineReply, renderMarkdown, STARTERS, QUICK_REPLIES,
  unreadCount, markAiSeen, fileToAttachment, MAX_ATTACH, removeLastAssistant,
} from "./ai.js";
import { spring, reduceMotion } from "./motion.js";

function $(id) { return document.getElementById(id); }

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function escape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function paintAiFab() {
  const fab = $("ai-fab");
  if (!fab) return;
  const n = unreadCount();
  fab.dataset.unread = n ? "1" : "0";
  const badge = fab.querySelector(".ai-fab-badge");
  if (badge) {
    badge.hidden = !n;
    badge.textContent = n > 9 ? "9+" : String(n);
  }
}

export function onAiRoute(active) {
  document.body.classList.toggle("route-ai", Boolean(active));
  if (active) markAiSeen();
  paintAiFab();
}

export function wireAi({ showToast, ai } = {}) {
  const toast = typeof showToast === "function" ? showToast : () => {};
  const form = $("ai-composer");
  const input = $("ai-input");
  const sendBtn = $("ai-send");
  const attach = $("ai-attach");
  const attachInput = $("ai-attach-input");
  const exportBtn = $("ai-export");
  const shareBtn = $("ai-share");
  const newBtn = $("ai-new");
  const starters = $("ai-starters");
  const empty = $("ai-empty");
  const sidebar = $("ai-sidebar");
  const toggle = $("ai-sidebar-toggle");
  const collapse = $("ai-sidebar-collapse");
  const expand = $("ai-sidebar-expand");
  const search = $("ai-search");
  const jump = $("ai-jump");
  const chips = $("ai-chips");
  const voiceBtn = $("ai-voice");
  const statusEl = $("ai-status");
  const drop = $("ai-drop");
  const pendingBox = $("ai-pending");
  const countEl = $("ai-count");
  const view = $("ai-view");
  const artifact = $("ai-artifact");

  let activeId = null;
  let typing = null;
  let pending = [];
  let listening = false;
  let rec = null;
  let abortCtl = null;
  const MODEL_KEY = "blossom-ai-model";

  function setNavCollapsed(on) {
    view?.classList.toggle("ai-nav-collapsed", on);
    collapse?.setAttribute("aria-expanded", on ? "false" : "true");
    expand?.setAttribute("aria-expanded", on ? "false" : "true");
  }
  toggle?.addEventListener("click", () => sidebar?.classList.toggle("open"));
  collapse?.addEventListener("click", () => setNavCollapsed(true));
  expand?.addEventListener("click", () => setNavCollapsed(false));
  $("ai-minimize")?.addEventListener("click", () => $("ai-back")?.click());
  $("ai-artifact-close")?.addEventListener("click", () => closeArtifact());

  function setStatus(text) {
    if (statusEl) {
      statusEl.textContent = text || "";
      statusEl.hidden = !text;
    }
  }

  function paintList() {
    const ul = $("ai-chat-list");
    if (!ul) return;
    const q = search?.value || "";
    ul.innerHTML = "";
    const rows = searchChats(q);
    if (!rows.length) {
      ul.innerHTML = `<li class="ai-chat-empty">${q ? "No matching chats" : "No chats yet"}</li>`;
      return;
    }
    for (const c of rows) {
      const li = document.createElement("li");
      li.className = c.id === activeId ? "active" : "";
      if (c.pinned) li.classList.add("pinned");
      const open = document.createElement("button");
      open.type = "button";
      open.className = "ai-chat-open";
      open.innerHTML = `<span>${escape(c.title)}</span><small>${c.pinned ? "Pinned · " : ""}${fmtTime(c.updatedAt)}</small>`;
      open.addEventListener("click", () => {
        sidebar?.classList.remove("open");
        openChat(c.id);
      });
      const more = document.createElement("div");
      more.className = "ai-chat-actions";
      more.appendChild(iconBtn(c.pinned ? "Unpin" : "Pin", () => {
        pinChat(c.id, !c.pinned);
        paintList();
      }, c.pinned ? "unpin" : "pin"));
      more.appendChild(iconBtn("Rename", () => {
        const next = prompt("Rename chat", c.title);
        if (next) { renameChat(c.id, next); paintList(); }
      }, "rename"));
      more.appendChild(iconBtn("Delete", () => {
        if (!confirm("Delete this chat?")) return;
        deleteChat(c.id);
        if (activeId === c.id) activeId = listChats()[0]?.id || createChat().id;
        openChat(activeId);
      }, "del"));
      li.appendChild(open);
      li.appendChild(more);
      ul.appendChild(li);
    }
  }

  function iconBtn(label, fn, kind) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ai-chat-mini";
    b.dataset.kind = kind;
    b.setAttribute("aria-label", label);
    b.title = label;
    b.textContent = kind === "pin" || kind === "unpin" ? "📌" : kind === "rename" ? "✎" : "✕";
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  function syncEmpty(chat) {
    const isEmpty = !chat?.messages?.length;
    if (empty) empty.hidden = !isEmpty;
    const thread = $("ai-thread");
    const box = $("ai-messages");
    if (thread) thread.hidden = isEmpty;
    if (box) box.hidden = isEmpty;
    if (starters) starters.hidden = !isEmpty;
    if (chips) chips.hidden = isEmpty;
  }

  function openArtifact(title, html) {
    if (!artifact) return;
    artifact.hidden = false;
    view?.classList.add("ai-split");
    const h = $("ai-artifact-title");
    const body = $("ai-artifact-body");
    if (h) h.textContent = title || "Canvas";
    if (body) body.innerHTML = html || "";
  }

  function closeArtifact() {
    if (artifact) artifact.hidden = true;
    view?.classList.remove("ai-split");
  }

  function msgRow(msg, index, { live = false } = {}) {
    const row = document.createElement("article");
    row.className = `ai-msg ai-msg-${msg.role}`;
    if (msg.feedback) row.dataset.feedback = msg.feedback;
    row.innerHTML = `
      <div class="ai-avatar" aria-hidden="true">${msg.role === "user" ? "you" : "咲"}</div>
      <div class="ai-msg-stack">
        <div class="ai-msg-meta">
          <span class="ai-msg-role">${msg.role === "user" ? "You" : "Blossom"}</span>
          <time>${fmtTime(msg.ts)}${msg.edited ? " · edited" : ""}</time>
        </div>
        <div class="ai-msg-body"></div>
        <div class="ai-msg-attach"></div>
        <div class="ai-msg-cites"></div>
        <div class="ai-msg-tools"></div>
      </div>`;
    const body = row.querySelector(".ai-msg-body");
    if (live) {
      body.innerHTML = `<div class="ai-think" role="status"><span></span><span></span><span></span> Thinking…</div>`;
    } else {
      body.innerHTML = renderMarkdown(msg.content);
      bindCodeCopy(body);
    }
    const attachWrap = row.querySelector(".ai-msg-attach");
    for (const a of msg.attachments || []) {
      if (String(a.type || "").startsWith("image/")) {
        const img = document.createElement("img");
        img.src = a.dataUrl;
        img.alt = a.name || "attachment";
        img.className = "ai-thumb";
        img.addEventListener("click", () => openLightbox(a.dataUrl, a.name));
        attachWrap.appendChild(img);
      } else {
        const chip = document.createElement("a");
        chip.className = "ai-file-chip";
        chip.textContent = a.name || "file";
        chip.href = a.dataUrl || "#";
        chip.download = a.name || "file";
        attachWrap.appendChild(chip);
      }
    }
    const citeWrap = row.querySelector(".ai-msg-cites");
    for (const c of msg.citations || []) {
      const a = document.createElement("a");
      a.className = "ai-cite";
      a.href = c.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = c.title || c.url.replace(/^https?:\/\//, "").slice(0, 40);
      citeWrap.appendChild(a);
    }
    const tools = row.querySelector(".ai-msg-tools");
    const addTool = (label, fn, title) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener("click", fn);
      tools.appendChild(b);
    };
    addTool("Copy", async () => {
      try { await navigator.clipboard.writeText(msg.content || ""); toast("Copied"); } catch {}
    });
    if (msg.role === "assistant" && !live) {
      addTool("Regenerate", () => regenerate());
      addTool(msg.feedback === "up" ? "▲ Liked" : "▲", () => {
        setMessageFeedback(activeId, index, msg.feedback === "up" ? "" : "up");
        paintMessages();
      }, "Helpful");
      addTool(msg.feedback === "down" ? "▼ Noted" : "▼", () => {
        setMessageFeedback(activeId, index, msg.feedback === "down" ? "" : "down");
        paintMessages();
      }, "Not helpful");
      if ((msg.content || "").length > 480) {
        addTool("Open beside", () => openArtifact(getChat(activeId)?.title || "Canvas", renderMarkdown(msg.content)));
      }
    }
    if (msg.role === "user" && !live) {
      addTool("Edit", () => editUser(index, msg.content));
    }
    return row;
  }

  function bindCodeCopy(root) {
    root.querySelectorAll(".ai-code-copy").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pre = btn.closest("pre");
        const code = pre?.querySelector("code")?.textContent || "";
        try {
          await navigator.clipboard.writeText(code);
          btn.textContent = "Copied";
          toast("Copied code");
        } catch {}
      });
    });
  }

  function openLightbox(src, name) {
    const ov = $("ai-lightbox");
    if (!ov) return;
    ov.hidden = false;
    const img = ov.querySelector("img");
    if (img) {
      img.src = src;
      img.alt = name || "";
    }
  }

  function paintMessages() {
    const box = $("ai-messages");
    const chat = getChat(activeId);
    if (!box || !chat) return;
    box.innerHTML = "";
    chat.messages.forEach((msg, i) => box.appendChild(msgRow(msg, i)));
    box.scrollTop = box.scrollHeight;
    syncEmpty(chat);
    updateJump();
  }

  function openChat(id) {
    activeId = id;
    closeArtifact();
    paintList();
    paintMessages();
    markAiSeen();
    paintAiFab();
  }

  function ensureChat() {
    if (activeId && getChat(activeId)) return;
    const existing = listChats()[0];
    activeId = existing ? existing.id : createChat().id;
  }

  function setBusy(on) {
    if (sendBtn) {
      sendBtn.hidden = on;
      sendBtn.disabled = on;
    }
    const stop = $("ai-stop");
    if (stop) stop.hidden = !on;
    view?.classList.toggle("ai-busy", on);
    setStatus(on ? ( $("ai-web")?.classList.contains("on") ? "Searching…" : "Generating…" ) : "");
  }

  function selectedModel() {
    return $("ai-model")?.value || ai?.defaultModel || "glm-5.3-flash";
  }

  function collectCitations(obj, into) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { obj.forEach((n) => collectCitations(n, into)); return; }
    const url = obj.url || obj.link || obj.uri;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      into.push({ url, title: String(obj.title || obj.name || "").slice(0, 120) });
    }
    for (const v of Object.values(obj)) collectCitations(v, into);
  }

  function paintTokens(usage) {
    const el = $("ai-tokens");
    if (!el) return;
    if (!usage) { el.hidden = true; return; }
    const inT = usage.prompt_tokens ?? usage.input_tokens;
    const outT = usage.completion_tokens ?? usage.output_tokens;
    const total = usage.total_tokens ?? ((inT || 0) + (outT || 0));
    if (!total) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = inT != null && outT != null
      ? `${inT} → ${outT} tokens`
      : `${total} tokens`;
  }

  function historyForApi() {
    const chat = getChat(activeId);
    const rows = chat?.messages || [];
    return rows.filter((m, i) => !(m.role === "assistant" && !m.content && i === rows.length - 1));
  }

  async function streamReply(fallbackPrompt) {
    const box = $("ai-messages");
    appendMessage(activeId, "assistant", "");
    const row = msgRow({ role: "assistant", content: "", ts: Date.now() }, (getChat(activeId)?.messages.length || 1) - 1, { live: true });
    box?.appendChild(row);
    spring(row, [
      { opacity: 0, filter: "blur(8px)", transform: "translateY(16px)" },
      { opacity: 1, filter: "blur(0)", transform: "none" },
    ], { duration: 480 });
    const body = row.querySelector(".ai-msg-body");
    setBusy(true);

    abortCtl = new AbortController();
    let acc = "";
    const cites = [];
    let usage = null;

    const failOffline = async () => {
      abortCtl = null;
      setBusy(false);
      removeLastAssistant(activeId);
      await typeReply(offlineReply(fallbackPrompt));
    };

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedModel(),
          messages: historyForApi(),
          web: Boolean($("ai-web")?.classList.contains("on")),
        }),
        signal: abortCtl.signal,
      });
      if (res.status === 503) {
        const err = await res.json().catch(() => ({}));
        if (err.offline) return failOffline();
      }
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "The assistant could not reply");
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() || "";
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            let json;
            try { json = JSON.parse(raw); } catch { continue; }
            collectCitations(json, cites);
            const piece = json.choices?.[0]?.delta?.content
              || json.choices?.[0]?.message?.content
              || "";
            if (piece) acc += piece;
            if (json.usage) usage = json.usage;
          }
        }
        replaceLastAssistant(activeId, acc, { usage, citations: uniqCites(cites) });
        if (body) {
          body.innerHTML = renderMarkdown(acc) + '<span class="ai-caret"></span>';
          bindCodeCopy(body);
        }
        if (box) box.scrollTop = box.scrollHeight;
        updateJump();
      }
      typing = null;
      abortCtl = null;
      setBusy(false);
      paintTokens(usage);
      paintMessages();
    } catch (err) {
      abortCtl = null;
      if (err?.name === "AbortError") {
        setBusy(false);
        paintMessages();
        return;
      }
      const reason = String(err.message || "The assistant could not reply");
      toast(reason);
      setBusy(false);
      if (!acc) {
        replaceLastAssistant(activeId, `Something went wrong generating a reply (${reason}). You can retry from the message actions.`);
        paintMessages();
      } else {
        paintMessages();
      }
    }
  }

  function uniqCites(list) {
    const seen = new Set();
    const out = [];
    for (const c of list) {
      if (!c?.url || seen.has(c.url)) continue;
      seen.add(c.url);
      out.push(c);
    }
    return out.slice(0, 8);
  }

  function typeReply(full) {
    return new Promise((resolve) => {
      const box = $("ai-messages");
      appendMessage(activeId, "assistant", "");
      const row = msgRow({ role: "assistant", content: "", ts: Date.now() }, (getChat(activeId)?.messages.length || 1) - 1, { live: true });
      box?.appendChild(row);
      spring(row, [
        { opacity: 0, filter: "blur(8px)", transform: "translateY(16px)" },
        { opacity: 1, filter: "blur(0)", transform: "none" },
      ], { duration: 480 });
      const body = row.querySelector(".ai-msg-body");
      let i = 0;
      let acc = "";
      setBusy(true);
      const start = () => {
        const tick = () => {
          const take = full.length > 80 ? 3 : 1;
          acc += full.slice(i, i + take);
          i += take;
          replaceLastAssistant(activeId, acc);
          if (body) {
            body.innerHTML = renderMarkdown(acc) + (i < full.length ? '<span class="ai-caret"></span>' : "");
            bindCodeCopy(body);
          }
          if (box) box.scrollTop = box.scrollHeight;
          updateJump();
          if (i >= full.length) {
            typing = null;
            setBusy(false);
            paintMessages();
            resolve();
            return;
          }
          typing = setTimeout(tick, 14);
        };
        tick();
      };
      typing = setTimeout(start, reduceMotion() ? 0 : 420);
    });
  }

  function stopTyping() {
    if (abortCtl) abortCtl.abort();
    abortCtl = null;
    if (typing) clearTimeout(typing);
    typing = null;
    setBusy(false);
    paintMessages();
  }

  async function sendText(text, { attachments = pending } = {}) {
    const q = String(text || "").trim();
    if ((!q && !attachments.length) || typing || abortCtl) return;
    ensureChat();
    appendMessage(activeId, "user", q || "(attachment)", attachments.length ? { attachments: attachments.slice() } : {});
    pending = [];
    paintPending();
    paintList();
    const chat = getChat(activeId);
    syncEmpty(chat);
    const box = $("ai-messages");
    if (box && chat) {
      if (box.hidden) box.hidden = false;
      const row = msgRow(chat.messages[chat.messages.length - 1], chat.messages.length - 1);
      box.appendChild(row);
      spring(row, [
        { opacity: 0, transform: "translateY(18px) scale(0.96)" },
        { opacity: 1, transform: "none" },
      ], { duration: 400 });
      box.scrollTop = box.scrollHeight;
    }
    if (input) { input.value = ""; input.style.height = "auto"; }
    updateCount();
    spring(sendBtn, [{ transform: "scale(0.86)" }, { transform: "scale(1)" }], { duration: 260 });
    await streamReply(q);
    markAiSeen();
    paintAiFab();
  }

  async function regenerate() {
    const chat = getChat(activeId);
    if (!chat) return;
    const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    stopTyping();
    removeLastAssistant(activeId);
    paintMessages();
    await streamReply(lastUser.content);
  }

  async function editUser(index, current) {
    const next = prompt("Edit message", current);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    updateMessage(activeId, index, trimmed);
    trimAfter(activeId, index);
    paintList();
    paintMessages();
    await streamReply(trimmed);
  }

  function paintPending() {
    if (!pendingBox) return;
    pendingBox.innerHTML = "";
    pendingBox.hidden = !pending.length;
    pending.forEach((a, i) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ai-pending-chip";
      chip.textContent = `${a.name} ✕`;
      chip.addEventListener("click", () => {
        pending.splice(i, 1);
        paintPending();
      });
      pendingBox.appendChild(chip);
    });
  }

  async function addFiles(files) {
    for (const file of [...files].slice(0, MAX_ATTACH - pending.length)) {
      try {
        pending.push(await fileToAttachment(file));
      } catch (err) {
        toast(err.message || "Could not attach");
      }
    }
    paintPending();
  }

  function updateCount() {
    if (!countEl || !input) return;
    const n = input.value.length;
    countEl.textContent = n ? String(n) : "";
    countEl.hidden = n < 80;
  }

  function updateJump() {
    const box = $("ai-messages");
    if (!jump || !box) return;
    const dist = box.scrollHeight - box.scrollTop - box.clientHeight;
    jump.hidden = box.hidden || dist < 80;
  }

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    sendText(input?.value);
  });
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendText(input.value);
    }
  });
  input?.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
    updateCount();
  });
  $("ai-stop")?.addEventListener("click", stopTyping);
  attach?.addEventListener("click", () => attachInput?.click());
  attachInput?.addEventListener("change", () => {
    addFiles(attachInput.files || []);
    attachInput.value = "";
  });
  exportBtn?.addEventListener("click", () => {
    const data = exportChat(activeId);
    if (!data) return;
    const blob = new Blob([data], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "blossom-ai-chat.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Exported JSON");
  });
  shareBtn?.addEventListener("click", async () => {
    const text = exportTranscript(activeId);
    try { await navigator.clipboard.writeText(text); toast("Transcript copied"); } catch { toast("Could not copy"); }
  });
  newBtn?.addEventListener("click", () => {
    stopTyping();
    openChat(createChat().id);
  });
  search?.addEventListener("input", paintList);
  jump?.addEventListener("click", () => {
    const box = $("ai-messages");
    box?.scrollTo({ top: box.scrollHeight, behavior: reduceMotion() ? "auto" : "smooth" });
  });
  $("ai-messages")?.addEventListener("scroll", updateJump);
  $("ai-lightbox")?.addEventListener("click", (e) => {
    if (e.target.id === "ai-lightbox" || e.target.closest("[data-close-lightbox]")) {
      $("ai-lightbox").hidden = true;
    }
  });

  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech && voiceBtn) voiceBtn.hidden = true;
  voiceBtn?.addEventListener("click", () => {
    if (!Speech) { toast("Voice needs Chrome or Edge"); return; }
    if (listening) { rec?.stop(); return; }
    rec = new Speech();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (ev) => {
      const said = ev.results[0]?.[0]?.transcript || "";
      if (input) {
        input.value = (input.value + " " + said).trim();
        updateCount();
      }
    };
    rec.onend = () => { listening = false; voiceBtn.classList.remove("live"); };
    rec.onerror = () => { listening = false; voiceBtn.classList.remove("live"); toast("Mic unavailable"); };
    rec.start();
    listening = true;
    voiceBtn.classList.add("live");
  });

  view?.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.items].some((i) => i.kind === "file")) return;
    e.preventDefault();
    if (drop) { drop.hidden = false; drop.classList.add("show"); }
  });
  view?.addEventListener("dragleave", (e) => {
    if (e.target === view && drop) { drop.classList.remove("show"); drop.hidden = true; }
  });
  view?.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    drop?.classList.remove("show");
    if (drop) drop.hidden = true;
    addFiles(e.dataTransfer.files);
  });
  input?.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  if (starters) {
    starters.innerHTML = "";
    STARTERS.forEach((s, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ai-starter";
      b.style.setProperty("--i", String(i));
      b.innerHTML = `<span>${s.label}</span><small>Tap to try</small>`;
      b.addEventListener("click", () => sendText(s.prompt));
      starters.appendChild(b);
    });
  }
  if (chips) {
    chips.innerHTML = "";
    for (const label of QUICK_REPLIES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ai-chip";
      b.textContent = label;
      b.addEventListener("click", () => sendText(label));
      chips.appendChild(b);
    }
  }

  $("ai-fab")?.addEventListener("click", () => {
    $("btn-ai")?.click();
  });

  window.addEventListener("blossom:ai-cleared", () => {
    stopTyping();
    activeId = createChat().id;
    openChat(activeId);
  });

  const modelSel = $("ai-model");
  if (modelSel) {
    const models = ai?.models?.length ? ai.models : [
      { id: "glm-5.3-flash", label: "GLM-5.3 Flash" },
      { id: "mimo-v2.5", label: "MiMo V2.5" },
      { id: "hy3", label: "Hy3" },
      { id: "qwen3.8-flash", label: "Qwen3.8 Flash" },
    ];
    modelSel.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      modelSel.appendChild(opt);
    }
    let saved = "";
    try { saved = localStorage.getItem(MODEL_KEY) || ""; } catch {}
    const sameId = (a, b) => String(a || "").toLowerCase().replace(/[^a-z0-9]/g, "") === String(b || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const matched = models.find((m) => sameId(m.id, saved));
    modelSel.value = matched?.id || ai?.defaultModel || models[0].id;
    modelSel.addEventListener("change", () => {
      try { localStorage.setItem(MODEL_KEY, modelSel.value); } catch {}
    });
  }
  $("ai-web")?.addEventListener("click", () => {
    $("ai-web").classList.toggle("on");
  });
  $("ai-handoff")?.addEventListener("click", async () => {
    const text = exportTranscript(activeId);
    try { await navigator.clipboard.writeText(text); } catch {}
    toast("This assistant is automated. Transcript copied — send it to a person if you need one.");
  });

  ensureChat();
  paintList();
  paintMessages();
  paintAiFab();
}
