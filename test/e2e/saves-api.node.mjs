// API contract for per-account game/app saves (no browser).
import { startServer } from "./harness.mjs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
}

const server = await startServer();
const base = server.base;

try {
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: "qa-dev@test.local", password: "qa-test-pass-1" }),
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const cookieHeader = cookie.split(";")[0];
  check("login for saves API", login.ok, `status=${login.status}`);

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Cookie: cookieHeader,
  };

  const colon = await fetch(`${base}/api/saves/g:2048`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ data: { local: { a: "1" }, idb: {} } }),
  });
  check("colon save id is rejected", colon.status === 400, `status=${colon.status}`);

  const wrapped = await fetch(`${base}/api/saves/c-snake-html`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ data: { local: { "snake-score": "9" }, idb: {}, capturedAt: 1 } }),
  });
  const wrappedJson = await wrapped.json().catch(() => ({}));
  check("wrapped {data} PUT accepted", wrapped.ok, JSON.stringify(wrappedJson));

  const got = await fetch(`${base}/api/saves/c-snake-html`, { headers: { Accept: "application/json", Cookie: cookieHeader } });
  const gotJson = await got.json();
  check("GET returns stored local keys", got.ok && gotJson.data?.local?.["snake-score"] === "9", JSON.stringify(gotJson.data?.local));

  const raw = await fetch(`${base}/api/saves/c-2048`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ local: { tiles: "ok" }, idb: {}, capturedAt: 2 }),
  });
  check("raw snapshot PUT accepted", raw.ok, `status=${raw.status}`);

  const gotRaw = await fetch(`${base}/api/saves/c-2048`, { headers: { Accept: "application/json", Cookie: cookieHeader } });
  const rawJson = await gotRaw.json();
  check("raw snapshot round-trips", rawJson.data?.local?.tiles === "ok", JSON.stringify(rawJson.data?.local));

  const list = await fetch(`${base}/api/saves`, { headers: { Accept: "application/json", Cookie: cookieHeader } });
  const listJson = await list.json();
  const ids = (listJson.saves || []).map((s) => s.id);
  check("list includes both slots", ids.includes("c-snake-html") && ids.includes("c-2048"), ids.join(","));

  const gone = await fetch(`${base}/api/saves/c-2048`, { method: "DELETE", headers });
  check("delete slot", gone.ok);

  const missing = await fetch(`${base}/api/saves/c-2048`, { headers: { Accept: "application/json", Cookie: cookieHeader } });
  check("deleted slot 404s", missing.status === 404);

  await fetch(`${base}/api/saves/c-keep-prefs`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ data: { local: { x: "1" } } }),
  });
  await fetch(`${base}/api/saves/c-catalog-prefs`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ data: { gameFavs: ["snake"] } }),
  });
  const wiped = await fetch(`${base}/api/saves`, { method: "DELETE", headers });
  check("bulk delete", wiped.ok);
  const afterWipe = await fetch(`${base}/api/saves`, { headers: { Accept: "application/json", Cookie: cookieHeader } });
  const afterWipeJson = await afterWipe.json();
  const afterIds = (afterWipeJson.saves || []).map((s) => s.id);
  check("bulk delete keeps catalog prefs", afterIds.includes("c-catalog-prefs") && !afterIds.includes("c-snake-html") && !afterIds.includes("c-keep-prefs"), afterIds.join(","));

  const guest = await fetch(`${base}/api/saves`, { headers: { Accept: "application/json" } });
  check("saves API is auth-gated", guest.status === 401, `status=${guest.status}`);
} catch (e) {
  console.log("ERROR:", e);
  failed++;
} finally {
  server.child.kill();
  process.exit(failed > 0 ? 1 : 0);
}
