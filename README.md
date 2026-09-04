# Blossom

A modern web proxy unblocker with smart transport fallback, domain survival, and a mobile-first UI.

Built on Scramjet + Wisp, with a session-based auth layer, per-user sync (bookmarks & history), feature flags, and a dev admin panel.

## Features

- **Scramjet proxy** with Epoxy and BareMux transport support
- **Wisp WebSocket** endpoint for low-latency tunneling
- **Path randomization** - configurable prefixes to avoid pattern-based blocking
- **Account system** - register/login, httpOnly session cookies, bcrypt hashes
- **Server-side sync** - bookmarks and history stored per user in SQLite
- **Admin dashboard** - user management, feature toggles, live stats (dev role only)
- **Feature flags** - enable/disable proxy, games, apps, bookmarks, settings per user
- **Tab cloaking** - customize title/favicon to blend in
- **Panic key** - instant redirect to a safe URL
- **Domain survival** - mirror list with automatic failover
- **Built-in games and apps** - searchable catalogs with real art, favorites, recents, and per-account save sync. Catalog URLs are launch-tested through the proxy; dead hosts and Google JS apps that blank under Scramjet-alpha are omitted.
- **PWA** - installable, service worker cached
- **Rate limiting**, Helmet security headers, COOP/COEP for SharedArrayBuffer

## Quick start

```bash
npm install
npm start
```

Server listens on `http://localhost:8080` by default.

The first run seeds a dev account from `DEV_EMAIL` / `DEV_PASS` env vars (see below).

## Configuration

All configuration is via environment variables. Copy [.env.example](.env.example) and customize.

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `PROXY_PREFIX` | `/assets/wasm/` | Scramjet engine static path |
| `EPOXY_PREFIX` | `/assets/net/` | Epoxy transport static path |
| `BAREMUX_PREFIX` | `/assets/worker/` | BareMux static path |
| `WISP_PATH` | `/ws/` | Wisp WebSocket upgrade path |
| `SCRAMJET_PREFIX` | `/~/` | Scramjet URL rewrite prefix |
| `DNS_SERVERS` | `1.1.1.3,1.0.0.3` | Upstream DNS for Wisp |
| `DEV_EMAIL` | - | Seeded dev account email (required for an admin account) |
| `DEV_PASS` | - | Seeded dev account password (required for an admin account) |
| `MIRRORS` | - | Comma-separated mirror URLs for domain survival failover |
| `REGISTRATION` | `open` | Set to `closed` to disable self-registration |
| `INVITE_CODE` | - | If set, registration requires this code |
| `BAI_API_KEY` | - | Server-only Blossom AI key (never shipped to the browser) |
| `BAI_BASE_URL` | `https://api.b.ai/v1` | OpenAI-compatible AI endpoint |
| `DONATE_CASHAPP_URL` | - | Cash App pay link shown on `/donate` |
| `DONATE_PAYPAL_URL` | - | PayPal.Me or hosted-button URL shown on `/donate` |
| `CAPTCHA_WATCH_HOSTS` | `google.com,reddit.com,recaptcha.net,hcaptcha.com,challenges.cloudflare.com` | Hosts whose cookies are vaulted. Subdomains match; `host:port` allowed for testing |
| `CAPTCHA_REFRESH_SECONDS` | `300` | Keep-alive probe interval per vault entry (0 = off) |
| `STEALTH_PROXY_URL` | - | Optional CONNECT proxy for keep-alive egress (uTLS sidecar) |
| `SOLVER_URL` | - | Optional open-source solver sidecar base URL (see below) |
| `SOLVER_TIMEOUT_MS` | `45000` | Max wait for the solver sidecar |

Change the path prefixes on every deployment so filters can't pattern-match.

## Anti-CAPTCHA middleware

Blossom includes a CAPTCHA anti-loop layer aimed at Google "unusual traffic"
interstitials, reCAPTCHA, Cloudflare Turnstile and Reddit-style challenges.

**Phase 1 (on by default) — session vault.** When a watched site sets cookies
during a challenge, Scramjet's in-page jar keeps them but loses them when the
service-worker database is purged (deploys, new devices, private browsing).
The middleware now:

- captures the jar entries for watched hosts after every proxied response and
  persists them per-account in `cookie_vault` (SQLite),
- re-seeds the Scramjet jar right after login/server version changes, before
  any proxied navigation, so a solved challenge stays solved,
- runs a server-side keep-alive: every `CAPTCHA_REFRESH_SECONDS` it pings a
  benign endpoint (e.g. Google's `generate_204`) with the stored cookies, so
  short-lived challenge tokens (`NID` et al.) are refreshed before they lapse,
- uses per-host circuit breakers (3 failures → 15 min cooldown) so a broken
  target can't stall anything, and sweep expired cookies from probes.

The Settings panel shows saved site sessions and a "Forget saved sessions"
button. Detection of challenge pages posts toast guidance instead of letting
the page spin into a loop.

**Phase 2 (plumbing only)** — `STEALTH_PROXY_URL` points the keep-alive probes at
an HTTP CONNECT proxy you run yourself (e.g. a Go **uTLS** or
**curl-impersonate** CONNECT sidecar) so those probes carry a real Chrome TLS
fingerprint.

**Decision:** Phase 2/3 stay optional plumbing and are not built into this
repo. Proxied **browsing** TLS terminates in the user's browser
(Epoxy/libcurl.wasm), so a server-side uTLS sidecar cannot change what Google
sees for page traffic. Changing that would mean swapping the WASM transport
for curl-impersonate — a Scramjet/Epoxy replacement, not a Blossom patch.
See `docker-compose.solvers.yml`.

**Phase 3 (plumbing only)** — `SOLVER_URL` accepts an external open-source solver
(Camoufox, Turnstile-solver-style HTTP service). When set, challenge events
are also POSTed to `${SOLVER_URL}/solve` with `{host, url, cookies}`, the
reply `{cookies: [...]}` replaces the vault entry, and the next page load
uses the fresh cookies. Solvers stay strictly optional and must be
self-hosted (AGPL-compatible). A starting composition is in
`docker-compose.solvers.yml`.

### Known limitations

- Free residential/community proxies are unreliable; expect dead exits.
- Scramjet 2.0.0-alpha occasionally drops the first fresh-context request's
  cookies while its jar hydrates; the next navigation carries them.
- Google can still decide to challenge anything from a datacenter IP; the
  vault reduces repeats, it cannot promise zero.
- The audio/image auto-solvers (faster-whisper, CLIP) belong in the
  user-configured sidecar only, never in this repo.

## Deployment

### Docker

```bash
docker build -t blossom .
docker run -p 8080:8080 -e DEV_EMAIL=you@example.com -e DEV_PASS=yourpass blossom
```

### Fly.io

A [fly.toml](fly.toml) is included. Edit the app name and region, then:

```bash
fly launch --copy-config
fly secrets set DEV_EMAIL=you@example.com DEV_PASS=yourpass
fly deploy
```

See [DEPLOY.md](DEPLOY.md) for full notes.

## Project layout

```
server.js          HTTP + Wisp entrypoint
config.js          env-driven config
auth.js            session auth routes + middleware
admin.js           dev-only admin API
db.js              SQLite layer (users, sessions, bookmarks, history)
health.js          /health JSON endpoint
public/            frontend (index, login, admin, games, SW, static JS)
data/              SQLite database (created at runtime)
test/smoke.js      config smoke test
```

## Scripts

```bash
npm start        # run server
npm run dev      # run with --watch
npm test         # smoke test
```

## Security notes

- Sessions are random 32-byte tokens, SHA-256 hashed in storage
- Passwords hashed with bcrypt (cost 10)
- Auth endpoints are rate-limited (30 req / 15 min)
- Wisp blacklists loopback and RFC1918 ranges
- Credentialless COEP used so cross-origin images still load while keeping SharedArrayBuffer

## License

AGPL-3.0
