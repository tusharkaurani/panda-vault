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
  page in Settings and a node in the Library. An install with no `integrations.json` infers
  its set once from existing channels/playlists/credentials, so upgrades don't
  land on an empty vault. **Adding a source type means adding a `CATALOG` entry
  here, an icon in the UI's `ICONS` map, and a panel in the UI's `PANELS` map —
  everything else keys off `sourceType`.**
  A stored entry is `{"id", "name"}`, where `name` is the label the user gave
  that integration's root node in the Library and `None` means "use the
  catalog's". Read it through `name_for`, never off the entry — the catalog
  name stays reachable as `default_name` (`defaultName` over the API), which is
  what the Add menu offers and what identifies the *type* after a rename. The
  id is the only thing anything else keys on, so renaming touches a label and
  nothing else.
- `store.py` — JSON persistence for `config/channels.json`, `playlists.json`,
  `integrations.json` and `collections.json`. Atomic write + `threading.Lock`. Always go through it, never
  open those files directly. `_migrate_source_fields` lazily upgrades the legacy
  `channelId`/`channelIds` binding fields to `sourceIds` + `sourceType` on read;
  `load_integrations` does the same for the legacy bare list of ids, which
  predates renameable root nodes. Both upgrade in memory and persist on the
  next write. `load_integrations` returning `None` (never decided) is not the
  same as `[]` (all removed) — only the first infers a set.
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
  - `stream_health` (v4) records how each *stream URL* last responded, keyed
    by the URL itself. It cannot be a column on `documents`: an M3U refresh
    swaps the whole partition and `msg_id` is only an ordinal within the
    current snapshot, so anything per-row would be destroyed nightly. Reads
    left-join it (`_JOIN_HEALTH`), which is why `_DOC_COLUMNS` is qualified
    with `d.` — `url` exists in both tables and an unqualified reference is an
    ambiguous-column error. `prune_stream_health` drops rows no playlist lists
    any more, since a URL-keyed table can't otherwise know an entry was
    dropped.
  - `source_health` (v3) records how each source's last *fetch* went —
    status, error, attempt/success times and a consecutive-failure streak,
    via `record_fetch`. Deliberately not columns on `channels_meta`: the mere
    existence of a `channels_meta` row is what `has_source` reads as "this
    source has been scanned", so recording a failed *first* fetch there would
    make a source that has never produced a row look scanned-and-empty.
    Whole new tables go in `_MIGRATION_TABLES`, the sibling of `_MIGRATIONS`
    for statements that have no column to guard on.
- `m3u.py` — the m3u source type's counterpart to `telegram_client`: fetch, parse,
  sync. A playlist is a *snapshot*, not a history — there is no cursor and no
  incremental mode, so every sync is a full `replace_source_documents` swap and
  entries the provider dropped just stop existing. Because that swap is
  destructive and irreversible, two guards sit in front of it and both are
  load-bearing:
  - `_validate_body` rejects a 200 that isn't a playlist. `parse` is
    deliberately forgiving — *any* non-`#` line is a stream URL — so an
    expired-subscription or login page doesn't fail, it silently becomes a
    few dozen channels whose URLs are fragments of HTML, which then replace
    the real snapshot.
  - `_shrank` refuses a snapshot below `M3U_SHRINK_GUARD_RATIO` of the
    previous one, keeping the old copy. Only the rescan endpoint's
    `?force=true` (`allow_shrink`) gets past it — a scheduled refresh must
    never be the thing that throws away data the user can't get back.

  Failures are typed (`PlaylistUnavailable` / `PlaylistInvalid` /
  `PlaylistShrank`, all `RuntimeError` subclasses so existing handlers still
  catch them) and each carries the `cache.FETCH_*` status it records.
  `sync_playlist` records *every* attempt that reaches the network, so the
  scheduler, a manual rescan and a collection open all leave the same trail. `#EXTGRP` is sticky (it applies
  to every following entry until changed); `group-title` still beats it. The
  #EXTINF attribute/title split is on the first comma *outside* quotes, because
  `group-title="News, Sport"` is common.
- `health.py` — probing the stream URLs *inside* a playlist, as opposed to the
  playlist URL itself. Separate from `m3u.py` because it runs on its own
  schedule, keys on URLs rather than playlists, and its results outlive any
  snapshot. Everything about its shape is about not doing work on a Pi:
  results are keyed by URL so a stream listed in five playlists is probed
  once; a single TCP connect per `(host, port)` condemns a dead provider's
  whole catalogue without probing any of it (the common failure is wholesale,
  not scattered); and a wall-clock budget stops a sweep early, with leftovers
  carrying to the next run least-recently-checked first. The probe itself is a
  ladder — HEAD, then a ranged GET when the server won't do HEAD, then an
  `#EXTM3U` check for `.m3u8` so a 200-with-an-HTML-error-page isn't read as
  healthy. **The binding constraint is provider rate-limiting, not the
  hardware**, hence `PER_HOST` mattering more than `CONCURRENCY`. One failure
  marks a URL `unknown`, two consecutive ones `unavailable` (`_verdict`), so a
  bad night doesn't turn a library red. Probes run on their **own**
  ThreadPoolExecutor — asyncio's shared default pool also serves cache reads
  and playlist syncs, and an hour-long sweep would starve them.
- `refresh.py` — the periodic background refresh for *all* source types. Used to
  live in `telegram_client`; it moved so a second source type didn't need either a
  competing loop or an import of `m3u` from the Telegram module. Not tracked in
  `jobs.py` — routine housekeeping shouldn't fire notifications every half hour.
  It also owns *when* the stream check runs (`_sweep_streams`), immediately
  after the playlist refresh and for a specific reason: many free playlist
  URLs carry an expiring session token, so probing yesterday's snapshot would
  report the stale token as a dead channel. Like the refresh, the nightly
  sweep is untracked in `jobs.py`; only a user-triggered one gets a job.
  A **scheduler, not a sweep**: it wakes on a short tick (`REFRESH_TICK_SECONDS`)
  and asks each source whether it is due. Telegram keeps one cadence for all
  channels (`TG_CACHE_REFRESH_SECONDS`, incremental and usually free); playlists
  are due individually, per `Playlist.refreshMinutes` or `M3U_REFRESH_MINUTES`,
  because each one is a full re-download. Anything on a daily-or-slower interval
  waits for the nightly window (`PANDA_NIGHTLY_HOUR`) unless it's overdue by
  `_OVERDUE_FACTOR`, which is what stops a machine that's asleep at 3am from
  never refreshing at all. Due-ness reads `source_health.last_attempt_at`, **not**
  `fetched_at`: the latter only moves when documents are written, so a dead URL
  would look permanently overdue and be retried every tick. Consecutive failures
  back the interval off, capped so it still recovers on its own.
- `jobs.py` — scan/rebuild tracking, **in-memory only, never persisted**.
  A `HEALTH` job is always recorded against a synthetic id (`health_source`),
  never a real playlist's — that keeps it out of the playlist's status pill
  and out of the UI's `jobsBySource` map (which is keyed by `sourceId` and
  drives "a scan is running here"), while still reaching the notification
  bell. `source_status` additionally ignores `HEALTH` jobs outright.
  `source_status` is the single source of truth for the status pill and now
  weighs persisted fetch health above the cached count: without it a playlist
  whose URL died weeks ago still reported "ready" off the snapshot it took
  before it broke, because a count alone can't tell fresh from abandoned. It
  adds `stale` (URL not answering, cached entries still served), `invalid`
  (answering with something that isn't a playlist) and `needs_review` (a
  snapshot refused for shrinking). A single failure is a blip — `failed` only
  turns the pill after `_STALE_AFTER`, while the deterministic ones show at
  once. Telegram never has a health row, so that lookup is skipped for it. Exists
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
  Those root nodes are user-named, so nothing may hardcode "Telegram"/"M3U" as
  a display label — read `useIntegrations().byId(type)?.name`. `defaultName` is
  for naming the *type* (the Add menu, the "what kind is this" hint beside a
  renamed title), never for labelling a node.
  A collection grid must only ever hold one tree — sibling order is
  per-integration, and a root-level reorder has to name its `sourceType` or the
  server rejects it as a partial order (409).
- Settings has exactly **two** tabs, Integrations and Collections — the strip
  must not grow with every new source type. They are **routes**, not `?tab=`
  state: `/settings/integrations` and `/settings/collections?type=<id>`, with
  `/settings` redirecting to the first. That's what makes each tab its own
  history entry and its own breadcrumb crumb, and it's how an integration page
  links back at its own tree. Everything under `pages/settings/`:
  `SettingsLayout` (breadcrumb + title + tab strip + `<Outlet/>`) and one file
  per tab. `IntegrationSettings` is a **sibling** route, not a child — it has
  its own header and must not inherit the strip.
- The Integrations tab is a *registry only*: a list of what's added, each row
  linking to `/settings/integrations/:sourceType`, plus an `AddIntegrationMenu`
  dropdown offering what's left. A source type's own sources are managed on that
  page, never inline in the list — two integrations expanded side by side is
  what this replaced. It deliberately fetches nothing (the catalog is already in
  context); only `CollectionsSettings` loads channels/playlists/tree.
- Breadcrumbs go through `components/Breadcrumbs.tsx` and are rooted at their
  **section**, not at a universal home. `Library` leads a trail only where it is
  a genuine ancestor (`/`, `/s/:type`, `/c/:id`); a Settings trail starts at
  `Settings`, because Settings is a peer of the Library, never a child of it.
  Getting home is the header logo's job — it's on screen either way. A crumb
  with no `to` is a level with no page of its own (`Settings` is one, since it
  only redirects); the last crumb is never a link.
- A source type's settings body is a panel under `components/integrations/`,
  registered in `IntegrationSettings`'s `PANELS` map and taking
  `IntegrationPanelProps`. The panel owns its source list and fetches it itself;
  the page above only supplies the catalog entry, the `sourceId → collections`
  index, and an `onChanged` to re-pull both. A type with no panel still gets a
  page — it just has nothing to configure.
- Lucide icons are `forwardRef` objects: calling one as a function
  (`Icon({...})`) throws at runtime and **TypeScript does not catch it**, since
  `ForwardRefExoticComponent` is typed callable. Always render as JSX; the
  integration icons go through `components/IntegrationIcon.tsx`.
- Stream reachability shows as a `StreamHealthDot` beside each entry's name
  and as a filter above the list. An `unavailable` row is dimmed, never
  disabled — a probe can be wrong (geo-blocks, providers that only answer real
  players), so the link stays clickable. `StreamCheckPanel` sits above the
  playlist list rather than on each row, because the check is vault-wide and
  URL-keyed; per-playlist buttons would imply an independence that isn't real.
- A playlist's row in `M3uPanel` carries a `PlaylistHealthNote`, which reads
  the server-computed `status` rather than re-deriving from `fetchStatus` /
  `failStreak` — so the note and the `StatusBadge` can never disagree about
  whether a failure is worth mentioning. "Replace anyway" is the only path to
  `rescan(id, force)`, and it confirms with the numbers first.
- Relative timestamps go through `lib/time.ts`: `timeAgo` for browser
  milliseconds, `timeAgoUnix` for the seconds every API field carries. Mixing
  them silently reports "56y ago".
- Every M3U logo URL goes through `lib/logos.ts`. It upgrades `http:`→`https:`
  on an https page (mixed content is dropped silently otherwise) and is the one
  seam a future logo cache/proxy would plug into.
- Colors: Tailwind `panda-*` tokens only (`bg`, `surface`, `surface2`, `border`,
  `text`, `muted`, `accent`, `accent2`) — they map to CSS vars that drive theming.
  Raw Tailwind colors break dark mode.
- Dark mode is `darkMode: "class"`; `.dark` on `<html>`, pref in `localStorage`
  key `panda-theme` (`src/lib/theme.ts`).
- Icons: `lucide-react`.
