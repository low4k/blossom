# Deploying Blossom on Railway + Cloudflare + low.monster

## Why not Cloudflare Pages?

Cloudflare Pages is **static-only hosting** (HTML/CSS/JS files). Blossom needs:
- A **WebSocket server** (Wisp — the actual proxy transport)
- **Native C++ modules** (better-sqlite3 for auth database)
- **Express server** with HTTP upgrade handling

None of these work on CF Pages. Instead, we use:
- **Railway** → runs the actual Node.js server (free $5/month credit)
- **Cloudflare** → DNS/CDN proxy in front of Railway (free forever)
- **low.monster** → your custom domain, pointed through Cloudflare

The school filter will see `low.monster` on Cloudflare's IP range with educational meta tags. Not a known proxy domain.

---

## Step 1: Deploy to Railway

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **"New Project"** → **"Deploy from GitHub Repo"**
3. Select your `low4k/blossom` repository
4. Railway auto-detects the Dockerfile and starts building

### Set Environment Variables in Railway

Go to your project → **Variables** tab → add these:

| Variable | Value |
|----------|-------|
| `PORT` | `8080` |
| `PROXY_PREFIX` | `/cdn/m/` |
| `EPOXY_PREFIX` | `/cdn/n/` |
| `BAREMUX_PREFIX` | `/cdn/w/` |
| `WISP_PATH` | `/sock/` |
| `SCRAMJET_PREFIX` | `/~/` |

> **These paths are unique to your deployment.** If you ever get blocked again, just change them to something new (e.g., `/lib/core/`, `/lib/net/`, etc.) and redeploy.

5. Railway will give you a URL like `blossom-production-xxxx.up.railway.app`
6. Test it works by visiting that URL

---

## Step 2: Set Up Cloudflare DNS

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Click **"Add a site"** → enter `low.monster`
3. Select the **Free plan**
4. Cloudflare will scan existing DNS records — **delete any old ones**
5. Add a new DNS record:

   | Type | Name | Content | Proxy |
   |------|------|---------|-------|
   | CNAME | `@` | `blossom-production-xxxx.up.railway.app` | ☁️ Proxied (orange cloud ON) |

   > Replace `blossom-production-xxxx.up.railway.app` with your actual Railway URL.
   > The orange cloud **must be ON** — this hides the Railway origin.

6. (Optional) Add a `www` subdomain too:

   | Type | Name | Content | Proxy |
   |------|------|---------|-------|
   | CNAME | `www` | `low.monster` | ☁️ Proxied |

7. Cloudflare will give you two **nameservers** like:
   - `aria.ns.cloudflare.com`
   - `lloyd.ns.cloudflare.com`

---

## Step 3: Update GoDaddy Nameservers

1. Go to [godaddy.com](https://www.godaddy.com) → **My Products** → **DNS** for `low.monster`
2. Scroll down to **Nameservers** → click **Change**
3. Select **"I'll use my own nameservers"**
4. Enter the two Cloudflare nameservers from Step 2
5. Save — **DNS propagation takes 10 minutes to 48 hours** (usually ~30 min)

---

## Step 4: Add Custom Domain in Railway

1. In your Railway project → **Settings** → **Domains**
2. Click **"Add Custom Domain"**
3. Enter `low.monster`
4. Railway will show you a CNAME target — **this should match what you put in Cloudflare**
5. Railway handles SSL termination automatically

---

## Step 5: Cloudflare SSL Settings

1. In Cloudflare dashboard → **SSL/TLS** → set mode to **Full (Strict)**
   - This ensures Cloudflare ↔ Railway is encrypted end-to-end
2. Go to **SSL/TLS → Edge Certificates** → enable **Always Use HTTPS**

---

## Step 6: Cloudflare Optimization (Optional but Recommended)

In Cloudflare dashboard:

- **Caching → Cache Rules**: Create a rule to cache static files:
  - Match: `low.monster/assets/*`, `low.monster/js/*`, `low.monster/styles.css`
  - Action: Cache, Edge TTL 1 day

- **Speed → Optimization**: Enable Auto Minify (JS, CSS, HTML)

- **Security → WAF**: Leave at default (Medium sensitivity)

---

## Updating the Site

After pushing changes to GitHub:
- Railway auto-deploys from the `main` branch
- Cloudflare CDN serves the updated content after cache purge (or wait for TTL)
- To force update: Cloudflare → **Caching → Purge Everything**

---

## If Blocked Again

1. Change the env vars in Railway to new random paths
2. Railway auto-redeploys
3. If the entire domain gets blocked, buy a new cheap domain ($1-2) and repeat Steps 2-4
