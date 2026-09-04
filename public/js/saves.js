// Per-account save sync for games & apps.
//
// Proxied frames are same-origin (Scramjet rewrites onto this origin), so
// localStorage / IndexedDB on the parent and the iframe are the same origin
// bucket. We still prefer iframe.contentWindow when it is reachable so a
// future blob/srcdoc frame would still be captured.
//
// Because every proxied site shares that bucket, a slot owns:
//   - keys restored into it at launch, plus
//   - keys that appeared after the session started (the game's new writes).
// Keys that already existed for other games are left alone.

const CAPTURE_INTERVAL_MS = 45_000;
const FIRST_SYNC_MS = 2_000;
const MAX_PAYLOAD = 4.5 * 1024 * 1024; // below the server 5MB cap

let active = null; // { saveId, win, ownedKeys, baselineKeys, ownedDbs, baselineDbs, timer, first }

const LOCAL_SKIP = /^(blossom[-_]|__scramjet|\$scramjet|bare-mux|cloak)/i;

function storageWindow(frame) {
  try {
    const w = frame?.contentWindow;
    if (w && w.localStorage) return w;
  } catch {}
  return window;
}

function encValue(v) {
  if (v instanceof Date) return { __b_type: "date", iso: v.toISOString() };
  if (v instanceof ArrayBuffer) return { __b_type: "ab", b64: bufToB64(v) };
  if (ArrayBuffer.isView(v)) return { __b_type: "ta", ctor: v.constructor.name, b64: bufToB64(v.buffer) };
  return v;
}
function decValue(v) {
  if (v && typeof v === "object") {
    if (v.__b_type === "date") return new Date(v.iso);
    if (v.__b_type === "ab") return b64ToBuf(v.b64);
    if (v.__b_type === "ta") {
      const buf = b64ToBuf(v.b64);
      switch (v.ctor) {
        case "Uint8Array": return new Uint8Array(buf);
        case "Uint16Array": return new Uint16Array(buf);
        case "Uint32Array": return new Uint32Array(buf);
        case "Int16Array": return new Int16Array(buf);
        case "Int32Array": return new Int32Array(buf);
        case "Float32Array": return new Float32Array(buf);
        case "Float64Array": return new Float64Array(buf);
        default: return new Uint8Array(buf);
      }
    }
  }
  return v;
}
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

function currentStorageKeys(win) {
  try { return Object.keys(win.localStorage); } catch { return []; }
}

function captureLocal(win, ownedKeys, baselineKeys) {
  const out = {};
  for (const k of currentStorageKeys(win)) {
    if (LOCAL_SKIP.test(k)) continue;
    if (ownedKeys.has(k) || !baselineKeys.has(k)) {
      try { out[k] = win.localStorage.getItem(k); } catch {}
    }
  }
  return out;
}

async function listUserDbs(idb) {
  if (!idb?.databases) return [];
  try {
    return (await idb.databases())
      .map((d) => d.name)
      .filter(Boolean)
      .filter((n) => n !== "$scramjet" && !/^blossom/i.test(n) && !/^livewire-/i.test(n));
  } catch {
    return [];
  }
}

async function dumpDb(idb, name) {
  const db = await new Promise((res, rej) => {
    const r = idb.open(name);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("blocked"));
  });
  try {
    const stores = {};
    for (const storeName of db.objectStoreNames) {
      const store = db.transaction(storeName, "readonly").objectStore(storeName);
      const [keys, values] = await Promise.all([
        new Promise((res) => { const g = store.getAllKeys(); g.onsuccess = () => res(g.result); g.onerror = () => res([]); }),
        new Promise((res) => { const g = store.getAll(); g.onsuccess = () => res(g.result); g.onerror = () => res([]); }),
      ]);
      stores[storeName] = {
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        records: values.map((v, i) => ({ key: encValue(keys[i]), value: encValue(v) })),
      };
    }
    return { version: db.version, stores };
  } finally {
    db.close();
  }
}

async function restoreDb(idb, name, dump) {
  const exists = (await idb.databases?.() || []).some((d) => d.name === name);
  if (exists) {
    try {
      const db = await new Promise((res, rej) => {
        const r = idb.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      for (const [storeName, sdef] of Object.entries(dump.stores || {})) {
        if (!db.objectStoreNames.contains(storeName)) continue;
        const tx = db.transaction(storeName, "readwrite");
        for (const rec of sdef.records || []) {
          try { tx.objectStore(storeName).put(decValue(rec.value), decValue(rec.key)); } catch {}
        }
        await new Promise((r) => { tx.oncomplete = r; tx.onerror = r; });
      }
      db.close();
    } catch {}
    return;
  }
  await new Promise((resolve) => {
    const r = idb.open(name, dump.version || 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const [storeName, sdef] of Object.entries(dump.stores || {})) {
        if (db.objectStoreNames.contains(storeName)) continue;
        try {
          db.createObjectStore(storeName, {
            keyPath: sdef.keyPath ?? undefined,
            autoIncrement: !!sdef.autoIncrement,
          });
        } catch {}
      }
    };
    r.onsuccess = async () => {
      const db = r.result;
      try {
        for (const [storeName, sdef] of Object.entries(dump.stores || {})) {
          if (!db.objectStoreNames.contains(storeName)) continue;
          const tx = db.transaction(storeName, "readwrite");
          for (const rec of sdef.records || []) {
            try { tx.objectStore(storeName).put(decValue(rec.value), decValue(rec.key)); } catch {}
          }
          await new Promise((res2) => { tx.oncomplete = res2; tx.onerror = res2; });
        }
      } finally {
        db.close();
        resolve();
      }
    };
    r.onerror = () => resolve();
  });
}

export function startSaveSession(saveId, frame = null, seed = null) {
  if (active) {
    clearInterval(active.timer);
    clearTimeout(active.first);
    const prev = active;
    active = null;
    syncSaveNow(prev.saveId, prev).catch(() => {});
  }
  const win = storageWindow(frame);
  const baselineKeys = new Set(currentStorageKeys(win).filter((k) => !LOCAL_SKIP.test(k)));
  active = {
    saveId,
    frame,
    ownedKeys: new Set(seed?.ownedKeys || []),
    baselineKeys,
    ownedDbs: new Set(seed?.ownedDbs || []),
    baselineDbs: new Set(),
    timer: setInterval(() => syncSave().catch(() => {}), CAPTURE_INTERVAL_MS),
    first: setTimeout(() => syncSave().catch(() => {}), FIRST_SYNC_MS),
  };
  listUserDbs(win.indexedDB).then((names) => {
    if (active && active.saveId === saveId) {
      for (const n of names) active.baselineDbs.add(n);
    }
  }).catch(() => {});
}

export function bindSaveFrame(frame) {
  if (active) active.frame = frame;
}

export function endSaveSession() {
  const s = active;
  if (!s) return Promise.resolve();
  clearInterval(s.timer);
  clearTimeout(s.first);
  active = null;
  return syncSaveNow(s.saveId, s);
}

export async function syncSave() {
  if (!active) return { skipped: true };
  return syncSaveNow(active.saveId, active);
}

async function syncSaveNow(saveId, session = active) {
  if (!session) return { skipped: true };
  const win = storageWindow(session.frame);
  const local = captureLocal(win, session.ownedKeys, session.baselineKeys);
  for (const k of Object.keys(local)) session.ownedKeys.add(k);

  const idb = {};
  const names = await listUserDbs(win.indexedDB);
  for (const name of names) {
    const isNew = !session.baselineDbs.has(name);
    const isOwned = session.ownedDbs.has(name);
    if (!isNew && !isOwned) continue;
    try {
      idb[name] = await dumpDb(win.indexedDB, name);
      session.ownedDbs.add(name);
    } catch {}
  }

  const data = { local, idb, capturedAt: Date.now() };
  const json = JSON.stringify(data);
  if (json.length > MAX_PAYLOAD) {
    console.warn("[saves] snapshot too large, skipping sync:", json.length);
    return { skipped: true, oversize: true };
  }
  const r = await fetch(`/api/saves/${encodeURIComponent(saveId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
    keepalive: true,
  });
  return { ok: r.ok, status: r.status };
}

export async function restoreSave(saveId) {
  const empty = { ownedKeys: new Set(), ownedDbs: new Set() };
  try {
    const r = await fetch(`/api/saves/${encodeURIComponent(saveId)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return empty;
    const { data } = await r.json();
    const ownedKeys = new Set();
    const ownedDbs = new Set();
    if (data?.local) {
      for (const [k, v] of Object.entries(data.local)) {
        if (LOCAL_SKIP.test(k)) continue;
        try { localStorage.setItem(k, v); ownedKeys.add(k); } catch {}
      }
    }
    if (data?.idb) {
      for (const [name, dump] of Object.entries(data.idb)) {
        try {
          await restoreDb(indexedDB, name, dump);
          ownedDbs.add(name);
        } catch {}
      }
    }
    return { ownedKeys, ownedDbs };
  } catch {
    return empty;
  }
}

export async function getSavesMap() {
  try {
    const r = await fetch("/api/saves", { headers: { Accept: "application/json" } });
    if (!r.ok) return {};
    const j = await r.json();
    return Object.fromEntries((j.saves || []).map((s) => [s.id, s]));
  } catch {
    return {};
  }
}

export function flushSaveKeepalive() {
  endSaveSession().catch(() => {});
}

export { syncSave as syncNow };

// Stable save id: catalog entries use c-<id>, free navigation uses h-<host>.
// Must match server SAVE_ID_RE: [a-z0-9][a-z0-9-_.]{0,63}
export function saveIdForUrl(url, catalogId = null) {
  const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9-_.]/g, "").slice(0, 60);
  if (catalogId) return `c-${clean(catalogId)}` || "c-unknown";
  try { return `h-${clean(new URL(url).hostname)}` || "h-unknown"; } catch { return "h-unknown"; }
}

const PREFS_ID = "c-catalog-prefs";
let prefsTimer = null;

export async function loadCatalogPrefs() {
  try {
    const r = await fetch(`/api/saves/${PREFS_ID}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    return j.data && typeof j.data === "object" ? j.data : null;
  } catch {
    return null;
  }
}

export function scheduleCatalogPrefs(data) {
  clearTimeout(prefsTimer);
  const body = JSON.stringify({ data });
  const send = () => {
    fetch(`/api/saves/${PREFS_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  };
  prefsTimer = setTimeout(send, 50);
}
