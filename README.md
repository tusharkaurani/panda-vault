# Panda Vault

A self-hosted web app for browsing and downloading documents posted across
any number of private Telegram channels, organized into a card-based
collection tree you define yourself — no Telegram client needed on the
consuming end.

**Stack:** FastAPI + [Telethon](https://docs.telethon.dev/) backend, Vite +
React + TypeScript + Tailwind CSS frontend, shipped as a single Docker image.

## Features

- Browse documents from many Telegram channels through one clean web UI
- Organize channels into an arbitrary-depth collection tree (e.g.
  `Magazines → Indian / Global`)
- Per-channel file-extension allowlists (e.g. only show `.pdf`/`.jpg`)
- Cross-channel document search
- Streamed downloads — never fully buffered on disk or in memory
- One-time login through the browser on first launch — no terminal access
  required
- No re-login needed afterward: the Telegram session persists across
  restarts

## Quickstart

```yaml
# compose.yml
services:
  panda-vault:
    image: dockerpanda1206/panda-vault:latest
    container_name: panda-vault
    restart: always
    ports:
      - "8811:8811"
    environment:
      - TG_API_ID=your_api_id
      - TG_API_HASH=your_api_hash
    volumes:
      - ./config:/app/config
```

```bash
docker compose up -d
```

Open `http://localhost:8811` — on first launch you'll be prompted to log
in with your Telegram phone number, a code sent via Telegram/SMS, and (if
enabled) your two-factor password. This happens once; the session is
persisted to the `config/` volume and reused on every restart.

## Getting a `TG_API_ID` / `TG_API_HASH`

1. Go to [my.telegram.org/apps](https://my.telegram.org/apps) and log in
   with the Telegram account you want this app to browse as.
2. Create an app (any name/platform works).
3. Copy the **App api_id** and **App api_hash** into your compose file.

These identify your app to Telegram's API — they're separate from, and
required in addition to, the phone login above.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TG_API_ID` | yes | — | Telegram API app ID |
| `TG_API_HASH` | yes | — | Telegram API app hash |
| `TG_CACHE_REFRESH_SECONDS` | no | `1800` | Interval between background document-cache refresh cycles |

## Upgrading to 2.0

The document cache moved from `config/document_cache.json` to a SQLite
database, `config/documents.db`. **Nothing to do — just pull the new image.**
On first start the old file is imported automatically (a few seconds for
~150k documents) and kept as `config/document_cache.json.bak`.

Two things worth knowing:

- **Rolling back to 1.x needs one manual step.** 1.x reads
  `document_cache.json`, which 2.0 has renamed. Rename
  `config/document_cache.json.bak` back to `config/document_cache.json`
  first, or 1.x will start with an empty cache and rescan every channel
  from Telegram.
- **`/api/search` changed shape** if you script against it: results are now
  paginated (`offset`/`limit`, with a `total`), each result carries flat
  `collectionId`/`collectionName`/`channelId`/`channelName` instead of
  nested objects, and queries shorter than 2 characters are rejected.

Keep the `.bak` until you're satisfied with the upgrade; it's the fallback
if `documents.db` is ever lost, and avoids a full re-scan.

## Usage

1. **Settings → Channels → Add channel** — name, the channel ref
   (`@username`, numeric ID, or `t.me/+...` invite link), and optionally an
   extension allowlist. If the account isn't a member yet, use the join
   icon to join it first.
2. **Settings → Collections** — build a tree: a collection either holds
   sub-collections or is bound to one channel, never both.
3. The landing page reflects changes immediately — no restart needed.

## Building from source

```bash
# Backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# Frontend
cd frontend && npm install && npm run build && cd ..
ln -s frontend/dist static   # local (non-Docker) runs serve from ./static

# Run
cp .env.example .env   # fill in TG_API_ID / TG_API_HASH
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8811
```

Or build the Docker image yourself instead of pulling the published one —
`compose.yml` in this repo builds from source (`.env` supplies the two
Telegram env vars instead of inline `environment:`):

```bash
cp .env.example .env   # fill in TG_API_ID / TG_API_HASH
docker compose build && docker compose up -d
```

## Project layout

| Path | Purpose |
|---|---|
| `app/` | FastAPI backend — routers, Telethon client, JSON-file persistence |
| `frontend/` | Vite + React + TypeScript + Tailwind SPA |
| `Dockerfile` | Multi-stage build: SPA → `./static`, served by FastAPI |
| `.github/workflows/` | CI: builds and publishes the Docker Hub image on tag push |
| `config/` | Runtime data — channels, collections, Telegram session (git-ignored) |

## Reverse proxy / auth (optional)

This app has **no built-in authentication** — anyone who can reach port
`8811` can browse, download, and complete the first-run Telegram login. If
exposing it beyond your own LAN/VPN, put it behind a reverse proxy (Caddy,
Nginx, Traefik) with an SSO/forward-auth layer (Authelia, Authentik) in
front — a single `forward_auth`/`auth_request` directive covers the whole
app since it has no per-route auth of its own.

## Security notes

- `TG_API_ID`/`TG_API_HASH` and the Telegram session persisted to
  `config/session.session` are credentials for the Telegram account you log
  in with — never commit or share them.
- The first-run login screen is itself unauthenticated, so don't expose
  port `8811` to an untrusted network before completing it.
- `config/channels.json` may reference private/invite-only channels once
  configured — keep `config/` out of version control.
