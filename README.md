# Panda Vault

A self-hosted web app for browsing free online resources — documents posted
across private **Telegram channels**, and live streams listed in **M3U
playlists** — organized into card-based collection trees you define yourself.

Each integration gets its own tree under a shared Library:

```
Library
├── Telegram          shown once you sign in
│   └── Magazines → Indian / Global → …
└── M3U               shown once you add a playlist
    └── Live TV → Sports / News → …
```

**Integrations are independent.** Telegram needs an API key and a one-time
login; M3U needs neither — paste a playlist URL and it's indexed immediately.
Use one, the other, or both.

**Stack:** FastAPI + [Telethon](https://docs.telethon.dev/) backend, Vite +
React + TypeScript + Tailwind CSS frontend, shipped as a single Docker image.

## Features

- Browse many Telegram channels and M3U playlists through one clean web UI
- Organize each integration's sources into an arbitrary-depth collection tree
  (e.g. `Magazines → Indian / Global`)
- Reorder collections by dragging their cards, or with the arrow keys
- Per-source extension allowlists — `.pdf`/`.jpg` for a channel, `.m3u8` for a
  playlist (matched on the stream URL)
- One search across every integration at once
- Streamed Telegram downloads — never fully buffered on disk or in memory
- M3U entries show their channel logo and group; copy the stream URL or open
  it in an external player
- Playlists are re-fetched on the same background cycle as Telegram, and a
  refresh *replaces* the snapshot, so channels the provider dropped disappear
- One-time Telegram login through the browser — no terminal access required,
  and the session persists across restarts

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
      # Optional — omit both to run M3U-only.
      - TG_API_ID=your_api_id
      - TG_API_HASH=your_api_hash
    volumes:
      - ./config:/app/config
```

```bash
docker compose up -d
```

Open `http://localhost:8811`, then **Settings → Integrations → Add**. Pick
what you want to connect; each one you add appears as a panel on that page,
holding its own sources, and gets its own tree in the Library.

- **M3U Playlists** works straight away — add a playlist URL in its panel.
- **Telegram** asks you to sign in with your phone number, a code sent via
  Telegram/SMS, and (if enabled) your two-factor password — or by scanning a
  QR code. This happens once; the session is persisted to the `config/` volume
  and reused on every restart. If you left `TG_API_ID`/`TG_API_HASH` unset, the
  card says so and everything else still works.

Upgrading rather than installing fresh? Whatever you already had configured is
detected and marked as added on first start — nothing to re-add.

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
| `TG_API_ID` | no | — | Telegram API app ID. Unset disables the Telegram integration; everything else still works |
| `TG_API_HASH` | no | — | Telegram API app hash |
| `TG_CACHE_REFRESH_SECONDS` | no | `1800` | Interval between background refresh cycles, for **all** source types |
| `M3U_USER_AGENT` | no | `VLC/3.0.20 LibVLC/3.0.20` | Sent when fetching a playlist. Many providers reject unfamiliar clients |
| `M3U_TIMEOUT_SECONDS` | no | `30` | Playlist fetch timeout |
| `M3U_MAX_BYTES` | no | `67108864` | Largest playlist body accepted (64MB). Anything bigger is refused rather than truncated |

`TG_API_ID`/`TG_API_HASH` were required before 3.0. They are optional now —
see below.

## Upgrading to 3.0

Panda Vault grew a second source type (M3U playlists). **Nothing to do — just
pull the new image.** Your channels, collections and cached documents are
migrated in place on first start, in well under a second even for ~150k
documents.

What happens automatically:

- `config/documents.db` gains four columns (`url`, `logo`, `group_title`,
  `source_type`). Existing rows are tagged `telegram`. The migration is
  additive, so nothing is rewritten or lost.
- `config/integrations.json` is created, recording which integrations this
  vault has added. It's inferred from what you already have — Telegram if it's
  configured or you have channels, M3U if you have playlists — so nothing needs
  re-adding.
- `config/collections.json` gains a `sourceType` on every collection and its
  `channelIds` field is renamed `sourceIds`. Every pre-existing collection is
  a Telegram one, so the conversion is unambiguous. It is applied on read and
  written back the next time you change anything.

Three things worth knowing:

- **Telegram is now optional.** `TG_API_ID`/`TG_API_HASH` used to be required
  at startup — without them the app refused to boot. They're optional now, and
  an install with neither runs fine as an M3U-only library.
- **Auth covers fewer routes.** Only `/api/channels/*` and `/api/download/*`
  require a Telegram session; collections, playlists and search no longer do.
  This app still has **no authentication of its own** — see *Reverse proxy /
  auth* below, which matters slightly more now that fewer routes are gated.
- **API shape changed** if you script against it. Sources are no longer
  necessarily channels, and the field names say so:

  | Endpoint | Before | After |
  |---|---|---|
  | `/api/search` results | `channelId`, `channelName` | `sourceId`, `sourceName`, plus `sourceType` |
  | `/api/collections/{id}/documents` | `channels` | `sources` |
  | any document object | `channelId` | `sourceId`, plus `sourceType` and the M3U-only `url`/`logo`/`group` |
  | collection objects | `channelIds` | `sourceIds`, plus `sourceType` |

  Also: `POST /api/collections` requires `sourceType` when creating at the
  root, and a root-level `POST /api/collections/reorder` requires it too — the
  root now holds one tree per integration, so an order has to say which one it
  covers. `GET /api/channels/rebuild-jobs` still works but is superseded by
  `GET /api/jobs`, which covers every source type and isn't Telegram-gated.

**Rolling back to 2.x needs one manual step, and it is easy to get wrong.**
The database is fine either way — 2.x ignores the added columns, its writes
still work, and re-upgrading afterwards is safe. `config/collections.json` is
the problem. Once it has been written in the 3.0 shape, 2.x reads it **without
any error** and silently drops every binding: `sourceIds` is a field it
doesn't know, so every leaf comes back as an empty container. The tree looks
intact and all of its documents are gone.

So: **back up `config/collections.json` before upgrading**, and restore that
copy if you roll back. The file keeps its old shape until the first time you
change a collection, so a 3.0 install you haven't reorganized yet rolls back
cleanly — but don't rely on remembering whether you did.

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

1. **Settings → Integrations** — connect Telegram if you want it. M3U needs
   nothing.
2. Add sources:
   - **Settings → Channels → Add channel** — name, the channel ref
     (`@username`, numeric ID, or `t.me/+...` invite link), and optionally an
     extension allowlist. If the account isn't a member yet, use the join icon
     to join it first.
   - **Settings → Playlists → Add playlist** — name and an `http(s)` playlist
     URL. It's fetched and indexed straight away; you'll get a notification
     when it's done.
3. **Settings → Collections** — pick the integration whose tree you're editing,
   then build it: a collection either holds sub-collections or is bound to one
   or more sources of that tree's type, never both. Trees can't be mixed — a
   Telegram collection can't hold a playlist, and vice versa.
4. The Library reflects changes immediately — no restart needed.

### What you can do with an M3U entry

Entries are live streams, so there is nothing to download. Each row offers
**copy stream URL** and **open** (which hands the URL to whatever your system
uses for it, e.g. VLC). Logos come straight from the playlist's `tvg-logo`
URLs and are not cached yet; entries whose logo is missing or fails to load
fall back to their initials.

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
| `app/` | FastAPI backend — routers, source integrations, SQLite cache, JSON-file persistence |
| `app/telegram_client.py` | The Telegram integration: Telethon session, scanning, downloads |
| `app/m3u.py` | The M3U integration: playlist fetching, parsing, snapshot sync |
| `app/refresh.py` | Background refresh loop shared by every source type |
| `frontend/` | Vite + React + TypeScript + Tailwind SPA |
| `Dockerfile` | Multi-stage build: SPA → `./static`, served by FastAPI |
| `.github/workflows/` | CI: builds and publishes the Docker Hub image on tag push |
| `config/` | Runtime data — channels, playlists, collections, Telegram session (git-ignored) |

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
- The Telegram login screen is itself unauthenticated, so don't expose port
  `8811` to an untrusted network before completing it (or at all, without a
  proxy — see above).
- `config/channels.json` may reference private/invite-only channels, and
  `config/playlists.json` may hold playlist URLs with embedded credentials —
  many IPTV providers put a username and password straight in the query
  string. Keep `config/` out of version control.
- Playlist URLs are fetched by the server, so anyone who can add a playlist
  can make the server issue an `http(s)` request to an address of their
  choosing. Only `http`/`https` are accepted, but hosts on your local network
  are still reachable — another reason not to expose this app unauthenticated.
