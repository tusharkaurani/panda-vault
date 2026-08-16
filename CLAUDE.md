# Panda Vault

FastAPI backend + Vite/React SPA that organizes documents from many Telegram
channels into a collection tree. Single shared Telethon account/session.

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

`routers/ → telegram_client, cache, jobs, store → models`

- `store.py` — JSON persistence for `config/channels.json` + `collections.json`.
  Atomic write + `threading.Lock`. Always go through it, never open those files directly.
- `cache.py` — `config/documents.db` (SQLite, stdlib `sqlite3`), per-channel
  document listings. **No TTL**; freshness comes from
  `telegram_client.start_refresh_loop()`. Long scans upsert each ~100-document
  batch as it arrives, so UI counts climb during a scan. Refreshes are
  incremental (`min_id`) and so can only *add* — deletions are caught by
  comparing Telegram's own file count against the cached one and rescanning
  the full history when it drops. Channels that auto-delete old posts rely
  on this; without it they accumulate entries that 404 on download.

  **Filtering, sorting, paging and counting all belong in SQL** — that's the
  whole point of the module. A router that materializes a channel's documents
  to slice 20 of them reintroduces the problem this replaced (a 41MB JSON blob
  rewritten whole per write, rebuilt into Pydantic objects per read, and an
  unpaginated search that returned 68MB). Read through `query_documents` /
  `channel_counts` / `iter_names`; `sync_channel` returns a *count*, never a
  document list.
  - `sort` must go through `cache._SORTS` — never interpolate it into SQL.
  - Every `ORDER BY` carries a `channel_id, msg_id` tiebreaker. Documents share
    timestamps in bulk (200 to the minute is normal), and both document lists
    page with LIMIT/OFFSET, so without a total order infinite scroll silently
    duplicates and skips rows.
  - Search splits the query on whitespace and requires **every** term to appear
    in the filename, in any order (`_search_terms`), so "TH Ban" finds
    "TH -Bangalore". Filenames separate words with spaces, dashes, dots and
    underscores interchangeably, so one contiguous match would miss most of
    what users type. A single-term query is still a plain substring match.
  - Each term is matched with `instr()`, not `LIKE` — `LIKE` would make a typed
    `%`/`_` a wildcard.
  - A channel's `allowedExtensions` is applied at query time (`_scope_sql`), so
    editing it in Settings takes effect with no rescan or re-index.
  - Startup imports a legacy `document_cache.json` once, then renames it to
    `.bak` — kept, never deleted, as the fallback if the db is lost. A corrupt
    db is quarantined and rebuilt from that backup.
- `jobs.py` — scan/rebuild tracking, **in-memory only, never persisted**. Exists
  outside routers so `/api/channels` and the documents endpoint can't disagree
  about a channel's status.
- Routers importing `telegram_client` directly is normal here (5 of 6 do).

## Invariants

- Every `/api/*` route requires Telegram auth except `/api/health` and `/api/auth/*`
  (middleware in `app/main.py`). New public routes must be added to that exemption.
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
  `collectionName`/`channelId`/`channelName`), never nested objects.
- Colors: Tailwind `panda-*` tokens only (`bg`, `surface`, `surface2`, `border`,
  `text`, `muted`, `accent`, `accent2`) — they map to CSS vars that drive theming.
  Raw Tailwind colors break dark mode.
- Dark mode is `darkMode: "class"`; `.dark` on `<html>`, pref in `localStorage`
  key `panda-theme` (`src/lib/theme.ts`).
- Icons: `lucide-react`.
