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
- **Feature flags** - enable/disable proxy, games, bookmarks, settings per user
- **Tab cloaking** - customize title/favicon to blend in
- **Panic key** - instant redirect to a safe URL
- **Domain survival** - mirror list with automatic failover
- **Built-in games** - Breakout, Memory, Snake
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
| `DEV_EMAIL` | - | Seeded dev account email |
| `DEV_PASS` | - | Seeded dev account password |

Change the path prefixes on every deployment so filters can't pattern-match.

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
