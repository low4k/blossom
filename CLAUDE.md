# Blossom — Agent Working Notes

Blossom is a Node/Express web proxy "unblocker" built on Scramjet + Wisp with
session auth, per-user sync, feature flags, and a dev-only admin panel.
It runs as a PWA with a mobile-first UI.

## Stack (locked)

- Node >=18 (ESM), Express 4, better-sqlite3 (WAL), helmet, compression, ws
- `@mercuryworkshop/scramjet` **must stay pinned to npm `2.0.0-alpha`** — the
  app targets that old API (globals `$scramjetLoadController`/`$scramjetLoadWorker`,
  files `scramjet.all.js`/`scramjet.sync.js`/`scramjet.wasm.wasm`, `createFrame()`).
  Newer 2.0.x builds changed the entire integration (separate controller
  package, ProxyTransport, Frame API) and are NOT drop-in.
- TOTP is a dependency-free RFC 6238 implementation in `totp.js` (SHA-1, 6 digits, 30s).

## Critical invariants (do not break)

- **Never reintroduce hardcoded fallback credentials.** Dev account only seeds
  from `DEV_EMAIL`/`DEV_PASS` env (or `DB_PATH` for tests).
- Scramjet's SW builds its OWN epoxy client from `config.wisp` — `initScramjet()`
  must pass the full `wss?://host/ws/` URL or every proxied request fails with
  "Invalid URL scheme: None". Don't "simplify" that wiring.
- Session cookie `_bsid` is httpOnly, Secure (behind HTTPS), SameSite=Lax,
  and only its SHA-256 hash is stored. Keep it that way.
- All DB access is parameterized; roles: `user` / `dev`. `dev` is the admin role.
- Feature flags (proxy/games/bookmarks/settings) are per-user, enforced in UI
  AND server middleware (defense in depth), but the SW intercepts `/~/` traffic
  before Express, so the proxy flag is primarily a client gate.

## Layout

- `server.js` routing + auth gate + Wisp upgrade; `auth.js` sessions + register/login;
  `db.js` (SQLite); `admin.js` (dev API); `config.js` (env-driven); `totp.js`.
- `public/` frontend: `index.html`, `login.html`, `admin.html`, `diag.html`,
  `js/` (app + sync/bookmarks/history/cloak/panic/mirrors/search/games/settings),
  `games/` (snake/breakout/memory), `manifest.webmanifest`, `sw.js`.
- `test/` smoke + `test/e2e/` Playwright suites (harness.mjs, run-all.test.mjs).

## Env vars (see .env.example)

`PORT`, `PROXY_PREFIX`, `EPOXY_PREFIX`, `BAREMUX_PREFIX`, `WISP_PATH`,
`SCRAMJET_PREFIX`, `DNS_SERVERS`, `DEV_EMAIL`, `DEV_PASS`, `MIRRORS`,
`REGISTRATION`, `INVITE_CODE`, `DB_PATH` (test override).

## Dev loop

- `npm start`, `npm test` (smoke), `node test/e2e/run-all.test.mjs` (full E2E;
  uses an isolated DB in `test/e2e/qa-data/` via `DB_PATH`).
- Commit small, run the full suite before/after changes, push to `main`
  (GitHub Actions smoke-tests + deploys to Fly when the billing lock is cleared).
- Fly app: `blossom-nowvdq`, region `ams`, volume `blossom_data` mounted at `/app/data`.