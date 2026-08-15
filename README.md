# Panda Vault

A self-hosted web app for browsing and downloading documents posted across
**any number of private Telegram channels**, organized into a **card-based
collection tree** you define yourself (e.g. `Magazines → Indian / Global`,
`Newspapers → English / Regional`) — no Telegram app/client needed on the
consuming end.

- **Local port:** `8811` (no built-in auth — see "Deployment" below for
  putting it behind a reverse proxy + SSO if exposing it beyond your LAN)
- **Stack:** FastAPI + [Telethon](https://docs.telethon.dev/) backend, Vite +
  React + TypeScript + Tailwind CSS frontend, single Docker image serving
  both.

## How it works

One shared Telegram **user account** session (Telethon, not a bot — so it
can read full channel history like a normal member) is reused across every
channel you configure. The session is created once and persisted to disk
(`config/session.session`) — no re-login on restart or when adding new
channels.

- **Channels** (`config/channels.json`) — each has a name, optional
  description, a channel ref (`@username`, numeric ID, or `t.me/...`
  invite link), and an optional **allowed file extensions** list (e.g.
  `["pdf", "jpg"]`) that restricts which documents ever surface for that
  channel — leave it empty to show every file type. Managed from the
  in-app **Settings → Channels** tab: add, edit, delete, a "join/verify"
  action that calls `JoinChannelRequest`/`ImportChatInviteRequest` under
  the hood for channels the account hasn't joined yet, and a pill-style
  input for the extension allowlist.
- **Collections** (`config/collections.json`) — an arbitrary-depth tree.
  Each node either **contains sub-collections** (a pure organizational
  node, rendered as a card) or is **bound to exactly one channel** (a
  leaf — opening it lists that channel's documents), never both. Managed
  from **Settings → Collections** with an inline tree editor
  (create/rename/delete/move/bind or unbind a channel). Cards show a live
  file count (recursive total of every nested channel-bound document, respecting
  each channel's extension allowlist) and, for container collections, an
  immediate sub-collection count.
- **Landing page** (`/`) — renders every root-level collection as a card
  grid. Clicking a collection with children drills into its
  sub-collections; clicking a channel-bound collection opens the document
  list for that channel.
- **Document list** — fetches the last `TG_LIST_LIMIT` (default 500)
  messages with documents from the bound channel (filename, size, date),
  filtered through the channel's extension allowlist (if any), cached
  in-memory per channel for 5 minutes (`app/cache.py`) to avoid
  re-scanning full history on every collection open / re-render, with a
  "Refresh" button in the UI to force-bypass the cache. The in-collection
  filter box searches as you type (debounced ~350ms), with Enter
  submitting immediately.
- **Search** (`/search`) — searches document names across every
  channel-bound collection at once, reusing the same per-channel cache and
  extension filter; the header search box live-navigates to results as
  you type (debounced ~350ms).
- **Download** (`GET /api/download/{channelId}/{msgId}`) — re-fetches that
  single message from Telegram and **streams** the document straight
  through to the browser (`StreamingResponse`, chunked, proper
  `Content-Disposition`/`Content-Length`/mime type) — never fully buffered
  on disk or in memory.

## Files

| Path | Purpose |
|---|---|
| `app/main.py` | FastAPI app: lifespan (Telethon start/stop), router wiring, `/api/health`, and the SPA static-file + catch-all mount |
| `app/models.py` | Pydantic models — `Channel`, `ChannelUpdate`, `Collection`, `CollectionUpdate`, `CollectionTreeNode`, `DocumentOut` |
| `app/store.py` | JSON-backed persistence for `config/channels.json` / `config/collections.json` (atomic writes, thread lock; transparently migrates a legacy `config/folders.json` if found) |
| `app/cache.py` | Tiny in-memory TTL cache (5 min) for per-channel document listings |
| `app/ext_filter.py` | Shared `filter_by_extensions()` helper — applies a channel's allowlist to a document list, reused by documents/search/counts |
| `app/telegram_client.py` | Telethon client lifecycle, entity resolution, join, list-documents, download-stream helpers |
| `app/routers/channels.py` | `GET/POST /api/channels`, `PUT/DELETE /api/channels/{id}`, `POST /api/channels/{id}/join` |
| `app/routers/collections.py` | `GET /api/collections/tree` (with computed `fileCount`/`folderCount`), `POST /api/collections`, `PUT/DELETE /api/collections/{id}`, `POST /api/collections/{id}/move` |
| `app/routers/documents.py` | `GET /api/collections/{id}/documents` — lists documents for a channel-bound collection (`?refresh=true` bypasses cache) |
| `app/routers/downloads.py` | `GET /api/download/{channelId}/{msgId}` — streamed file download |
| `app/routers/search.py` | `GET /api/search?q=...` — cross-channel document name search |
| `frontend/` | Vite + React + TS + Tailwind SPA — `pages/Landing.tsx`, `CollectionView.tsx`, `Search.tsx`, `Settings.tsx`, `components/*` |
| `requirements.txt` | `fastapi`, `uvicorn[standard]`, `telethon`, `python-dotenv` |
| `Dockerfile` | Multi-stage: `node:20-slim` builds the SPA (`frontend/dist`) → copied into `python:3.12-slim` runtime as `./static`; runs `uvicorn app.main:app --host 0.0.0.0 --port 8811` |
| `compose.yml` | Compose service definition (see below) |
| `.env` | `TG_API_ID`, `TG_API_HASH` (Telegram API credentials — **secret**) |
| `config/channels.json`, `config/collections.json` | The channel list and collection tree — human-readable JSON, git-backed |
| `config/session.session` + `session.session-journal` | Telethon's persisted login session (SQLite) — treat as a bearer credential for the Telegram account, same sensitivity as a password |
| `.no-pull` | Marker convention (from the homelab this was extracted from) meaning "locally built, no upstream image to pull" — only relevant if you use a similar pull/build automation script; harmless to ignore or delete otherwise |

## Deployment

Locally-built image, always-on, resource-capped:

```yaml
services:
  panda-vault:
    image: panda-vault
    build:
      context: .
    container_name: panda-vault
    mem_limit: 256m
    cpus: "0.5"
    ports:
      - "8811:8811"
    restart: always
    env_file:
      - .env
    environment:
      - TZ=UTC   # set to your local timezone
    volumes:
      - ./config:/app/config   # channels.json, collections.json, Telethon session — all persist across restarts
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS -o /dev/null http://localhost:8811/ || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s
```

There's no upstream image published for this project — always build
locally (`docker compose build && docker compose up -d`) so your own
Dockerfile/source changes are what actually run. Rebuild after every pull
if you're tracking updates.

## Reverse proxy / auth (optional)

This app has **no built-in authentication** — anyone who can reach port
`8811` can browse and download everything. If you're exposing it beyond
your own LAN, put it behind:

1. A reverse proxy (Caddy, Nginx, Traefik, etc.) terminating TLS.
2. An SSO/forward-auth layer in front of it (e.g. Authelia, Authentik) —
   a `forward_auth`/`auth_request` directive pointed at
   `localhost:8811` covers the whole app, since it has no per-route
   auth of its own.

If you only need it on your home network, plain `http://<host>:8811` over
Tailscale/WireGuard/your LAN is enough — no reverse proxy required.

## Adding a channel + collection (typical flow)

1. **Settings → Channels → Add channel** — enter a name, optional
   description, the channel ref (`@username`, numeric chat ID, or a
   `t.me/+...`/`t.me/joinchat/...` invite link), and optionally an
   allowlist of file extensions (leave empty to show every file type). If
   the account isn't a member yet, use the join icon next to the channel
   to join it (or accept the invite) before browsing its documents.
2. **Settings → Collections** — create a root collection (e.g.
   "Magazines"), then either add sub-collections under it (e.g. "Indian",
   "Global") or bind a leaf collection directly to one of your configured
   channels. A collection can hold sub-collections **or** be bound to a
   channel, never both — the tree editor enforces this.
3. The landing page (`/`) immediately reflects the new structure — no
   restart needed, `config/collections.json`/`config/channels.json` are
   re-read on every API call.

## What was done (build log)

1. Started from an original single-channel prototype (`main.py`, one
   hard-coded channel via a `TG_CHANNEL` env var, server-rendered HTML
   table).
2. Rebuilt the backend as a proper FastAPI package (`app/`) with JSON-file
   persistence for an arbitrary number of channels (`config/channels.json`)
   and an arbitrary-depth collection tree (`config/collections.json`),
   keeping the same Telethon session/account so no re-login was required.
3. Added REST routers for channels (CRUD + join), collections (CRUD +
   move, with the container-XOR-channel-binding invariant enforced
   server-side, plus computed recursive file/sub-collection counts on the
   tree endpoint), per-collection document listing (with a 5-minute
   in-memory TTL cache and per-channel file-extension allowlist),
   streamed downloads keyed by `channelId + msgId`, and cross-channel
   search.
4. Built a Vite + React + TypeScript + Tailwind CSS single-page frontend
   from scratch: a card-grid Landing page (root collections) with live
   file/sub-collection counts, a CollectionView page (breadcrumbs,
   sub-collection cards or document table + download links,
   debounced-as-you-type filtering, refresh-bypass-cache button), a
   Search page with a debounced live-navigating header search box, and a
   Settings page (Channels tab — including a pill UI for the extension
   allowlist — + Collections tab with an inline tree editor).
5. Rewrote the `Dockerfile` as a multi-stage build (`node:20-slim` →
   `frontend/dist` → copied into the `python:3.12-slim` runtime as
   `./static`) so the whole app ships as a single image/container, with
   FastAPI serving the built SPA and mounting `/api/*` alongside it.
6. Seeded `config/channels.json` / `config/collections.json` (originally
   `folders.json`, transparently migrated) with the original single channel
   and collection so the existing setup kept working unchanged after the
   migration.
7. Verified the frontend build (`npm run build` — TypeScript project
   references + Vite) and the full Docker image build/run end-to-end
   (health check, landing page, channel/collection CRUD, document
   listing, download streaming) before deploying.
8. Renamed the "Folder" concept to "Collection" throughout the codebase
   and UI (API routes, config filename, frontend routes/components), added
   debounced live search (header + in-collection filter), computed
   file/sub-collection counts on collection cards, and added a per-channel
   file-extension allowlist with a pill-style editor.

## Security notes (read before deploying your own instance)

- `.env` holds your `TG_API_ID`/`TG_API_HASH` (Telegram API credentials)
  — **never commit this file**. It's already git-ignored in this repo;
  keep it that way in any fork.
- `config/session.session` (created on first login) is an authenticated
  Telethon **user session** — functionally equivalent to a password for
  the Telegram account you log in with. Treat it with the same care as a
  credential: don't commit it, don't share it, and don't copy it anywhere
  less trusted than the box running the container.
- `config/channels.json` may end up referencing private/invite-only
  channels by ID or invite link once you configure it — same sensitivity
  as the session file, keep it out of version control if it's non-empty.
- The app itself has **no authentication** (see "Reverse proxy / auth"
  above) — anything reachable on port `8811` can browse and download
  every configured channel's documents.
