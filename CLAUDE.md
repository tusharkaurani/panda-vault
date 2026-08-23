# Panda Vault

FastAPI backend + Vite/React SPA that organizes free online resources into
collection trees. Two source types so far: Telegram channels (one shared
Telethon account/session) and M3U playlists (no account at all).

README covers deployment and end-user setup — this file covers working on the code.

## Dev loop

Two processes. Vite proxies `/api` → `localhost:8811` (`frontend/vite.config.ts`).

```bash
.venv/bin/uvicorn app.main:app --reload --port 8811   # backend
cd frontend && npm run dev                            # frontend
```

- `npm run build` = `tsc -b && vite build` → `frontend/dist/`. The Docker build
  copies that to `./static`; `app/main.py` serves `./static` only if it exists.
  **A stale `./static` silently shadows your rebuild** — browsing `localhost:8811`
  directly serves whatever is in `./static`, not `frontend/dist/`, so an old
  bundle will keep running against a changed API and fail in confusing ways.
  After a frontend change either use the Vite dev server, or
  `rm -rf static && cp -r frontend/dist static`.
- Interactive API surface: `http://localhost:8811/docs`.
- **There is no test suite.** Don't claim tests pass; verify by running the app.

## Layering

`routers/ → telegram_client, cache, jobs, sources, store → models`

A **source** is whatever fills a leaf collection — a Telegram channel
(`channels.json`) or an M3U playlist (`playlists.json`). Both share one id
space, so `cache`, `jobs` and `sources` are type-agnostic; only the sync path
differs. A collection carries a `sourceType` set at creation and inherited by
every descendant, so each integration has its own tree under the virtual
Library root the UI renders.

- `integrations.py` — the catalog of integration *types* and which of them this
  vault has added (`config/integrations.json`). "Added" is a user decision, not
  a side effect of being configured: an added-but-empty integration still gets a
  panel on the Integrations page and a node in the Library. An install with no `integrations.json` infers
  its set once from existing channels/playlists/credentials, so upgrades don't
  land on an empty vault. **Adding a source type means adding a `CATALOG` entry
  here and an icon in the UI's `ICONS` maps — everything else keys off
  `sourceType`.**
- `store.py` — JSON persistence for `config/channels.json`, `playlists.json`,
  `integrations.json` and `collections.json`. Atomic write + `threading.Lock`. Always go through it, never
  open those files directly. `_migrate_source_fields` lazily upgrades the legacy
  `channelId`/`channelIds` binding fields to `sourceIds` + `sourceType` on read.
- `sources.py` — resolves a collection's `sourceIds` to the actual channels or
  playlists and builds the `(id, allowedExtensions)` scope every cache read wants.
  Routers must not rebuild that scope by hand.
- `cache.py` — `config/documents.db` (SQLite, stdlib `sqlite3`), holding
  per-source item listings — Telegram documents and M3U entries share one
  table, discriminated by `source_type`. **No TTL**; freshness comes from
  `refresh.py`'s background loop. Long scans upsert each ~100-document
  batch as it arrives, so UI counts climb during a scan. Refreshes are
  incremental for Telegram (`min_id`) and so can only *add* — deletions are caught by
  comparing Telegram's own file count against the cached one and rescanning
  the full history when it drops. Channels that auto-delete old posts rely
  on this; without it they accumulate entries that 404 on download.

  **Filtering, sorting, paging and counting all belong in SQL** — that's the
  whole point of the module. A router that materializes a channel's documents
  to slice 20 of them reintroduces the problem this replaced (a 41MB JSON blob
  rewritten whole per write, rebuilt into Pydantic objects per read, and an
  unpaginated search that returned 68MB). Read through `query_documents` /
  `source_counts` / `iter_names`; `sync_channel` and `sync_playlist` both
  return a *count*, never an item list.
  - `sort` must go through `cache._SORTS` — never interpolate it into SQL.
  - Schema changes go in `cache._MIGRATIONS`, keyed by the version they take the
    database *to*, and `_TABLES` stays frozen at the v1 shape so fresh and
    existing databases walk the same path. `ALTER TABLE ADD COLUMN` is not
    idempotent, hence the `PRAGMA table_info` guard on each step.
  - `upsert_documents` can only add. A snapshot source (M3U) uses
    `replace_source_documents`, which swaps the whole partition in one
    transaction so entries the provider dropped actually disappear.
  - Every `ORDER BY` carries a `channel_id, msg_id` tiebreaker. Documents share
    timestamps in bulk (200 to the minute is normal) and *every* entry in a
    playlist snapshot shares one, so for M3U the tiebreaker is the whole sort.
    Both lists page with LIMIT/OFFSET, so without a total order infinite scroll
    silently duplicates and skips rows. It also means `date_asc` is playlist
    order and `date_desc` is the playlist backwards — the UI offers only the
    former for M3U.
  - Search splits the query on whitespace and requires **every** term to appear
    in the filename, in any order (`_search_terms`), so "TH Ban" finds
    "TH -Bangalore". Filenames separate words with spaces, dashes, dots and
    underscores interchangeably, so one contiguous match would miss most of
    what users type. A single-term query is still a plain substring match.
  - Each term is matched with `instr()`, not `LIKE` — `LIKE` would make a typed
    `%`/`_` a wildcard.
  - A source's `allowedExtensions` is applied at query time (`_scope_sql`), so
    editing it in Settings takes effect with no rescan or re-index. For a
    playlist it matches the *stream URL's* extension, not the entry name's.
  - Startup imports a legacy `document_cache.json` once, then renames it to
    `.bak` — kept, never deleted, as the fallback if the db is lost. A corrupt
    db is quarantined and rebuilt from that backup.
- `m3u.py` — the m3u source type's counterpart to `telegram_client`: fetch, parse,
  sync. A playlist is a *snapshot*, not a history — there is no cursor and no
  incremental mode, so every sync is a full `replace_source_documents` swap and
  entries the provider dropped just stop existing. `#EXTGRP` is sticky (it applies
  to every following entry until changed); `group-title` still beats it. The
  #EXTINF attribute/title split is on the first comma *outside* quotes, because
  `group-title="News, Sport"` is common.
- `refresh.py` — the periodic background refresh for *all* source types. Used to
  live in `telegram_client`; it moved so a second source type didn't need either a
  competing loop or an import of `m3u` from the Telegram module. Not tracked in
  `jobs.py` — routine housekeeping shouldn't fire notifications every half hour.
- `jobs.py` — scan/rebuild tracking, **in-memory only, never persisted**. Exists
  outside routers so the source list endpoints and the documents endpoint can't
  disagree about a source's status. Keyed on `sourceId`, and structural over
  `.id`/`.name`/`.allowedExtensions` so a channel and a playlist are both a Source.
  **Any route that spawns a scan must be `async def`** — a sync `def` route runs in
  FastAPI's threadpool, where `asyncio.create_task` raises "no running event loop"
  and leaves the job it just recorded stuck on "running" forever.
- Routers importing `telegram_client` / `m3u` directly is normal here.

## Invariants

- **Only Telegram-specific routes require Telegram auth** — the middleware in
  `app/main.py` gates the `_TELEGRAM_GATED` prefixes (`/api/channels`,
  `/api/download`) and lets everything else through. This is inverted from the
  pre-multi-source rule: an install that only uses M3U playlists has no Telegram
  account, so gating by default made it unusable. New *Telegram* routes must be
  added to that tuple; routes for other sources must not.
- `TG_API_ID`/`TG_API_HASH` are optional. Unset means the integration is not
  configured: `telegram_client.client` is `None`, `configured()` is False, and
  every entry point degrades instead of raising. Never read them at import time.
- The SPA catch-all must keep returning JSON 404 for unmatched `api/` paths, not `index.html`.
- `config/`, `.env`, and `static/` are gitignored — `config/` holds the live
  Telethon session and user data. Never commit or overwrite it.
- Telethon logging is pinned to WARNING in `main.py`; INFO buries app logs.

## Frontend conventions

- All HTTP goes through the single `api` object in `src/api.ts` (`request<T>`
  already prefixes `/api` and throws `ApiError`). No bare `fetch` in components.
  An aborted request rejects with a `DOMException` named `AbortError`, not an
  `ApiError` — swallow that one rather than showing it as a failure.
- Global search is paginated and requires `MIN_SEARCH_LENGTH` (`src/lib/search.ts`),
  mirrored by `min_length` on the backend. Results are flat (`collectionId`/
  `collectionName`/`sourceId`/`sourceName`/`sourceType`), never nested objects,
  and span every source type in one query.
- A collection binds `sourceIds`, not `channelIds`, and carries the `sourceType`
  saying what those ids point at. Anything rendering an item picks its row via
  `ItemRow`, which branches on the *row's* `sourceType` — search returns both
  kinds interleaved, so the choice can't be made once per page.
- The Library root is virtual: not a stored collection, but one card per
  connected integration (`pages/Landing.tsx`), each opening `/s/:sourceType`.
  A collection grid must only ever hold one tree — sibling order is
  per-integration, and a root-level reorder has to name its `sourceType` or the
  server rejects it as a partial order (409).
- Settings has exactly **two** tabs, Integrations and Collections. An added
  integration becomes a collapsible panel on the Integrations page holding its
  own sources — deliberately not a tab, so the strip doesn't grow with every
  new source type.
- Lucide icons are `forwardRef` objects: calling one as a function
  (`Icon({...})`) throws at runtime and **TypeScript does not catch it**, since
  `ForwardRefExoticComponent` is typed callable. Always render as JSX; the
  integration icons go through `components/IntegrationIcon.tsx`.
- Every M3U logo URL goes through `lib/logos.ts`. It upgrades `http:`→`https:`
  on an https page (mixed content is dropped silently otherwise) and is the one
  seam a future logo cache/proxy would plug into.
- Colors: Tailwind `panda-*` tokens only (`bg`, `surface`, `surface2`, `border`,
  `text`, `muted`, `accent`, `accent2`) — they map to CSS vars that drive theming.
  Raw Tailwind colors break dark mode.
- Dark mode is `darkMode: "class"`; `.dark` on `<html>`, pref in `localStorage`
  key `panda-theme` (`src/lib/theme.ts`).
- Icons: `lucide-react`.
