"""SQLite-backed store for per-channel document listings.

Avoids re-scanning a Telegram channel's full message history on every
collection open (slow + risks Telegram FloodWait rate limiting). Unlike a
short TTL cache, entries here don't expire on their own — they're kept
fresh by a periodic background refresh loop (see
telegram_client.start_refresh_loop) and survive process restarts.
Callers can still force a live bypass (e.g. a "Refresh" button in the
UI, or a cache miss for a brand new channel).

This replaced a single `document_cache.json` blob that was loaded whole
into memory and re-serialized whole on every write. At ~150k documents
that meant a 41MB rewrite to add one row, a full Pydantic rebuild of a
channel to serve 20 of its rows, and an unbounded global search that
materialized every match at once. Everything here is shaped so the
routers never hold more than one page of documents: filtering, sorting,
paging and counting all happen in SQL.

`documents.db` is a *derived* cache — it can always be rebuilt from
Telegram, or re-imported from `document_cache.json.bak`.
"""
import json
import logging
import os
import sqlite3
import threading
import time
from typing import Dict, Iterator, List, Optional, Sequence, Tuple

from .models import DocumentOut

CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config")
DB_PATH = os.path.join(CONFIG_DIR, "documents.db")
LEGACY_JSON_PATH = os.path.join(CONFIG_DIR, "document_cache.json")
LEGACY_BACKUP_PATH = LEGACY_JSON_PATH + ".bak"

SCHEMA_VERSION = "1"

log = logging.getLogger("panda_vault.cache")

# One shared connection guarded by a lock. The connection is genuinely
# cross-thread: a few routes are sync `def` (so FastAPI runs them on the
# anyio threadpool) while the rest are `async def` on the event loop, and
# scans hand slow work to asyncio.to_thread. sqlite3.threadsafety == 3
# makes sharing legal, but statements from concurrent threads would still
# interleave inside a transaction — hence the lock on every access, the
# same pattern store.py uses. Contention is a non-issue: the slowest
# query here is the ~15ms global search scan.
_conn: Optional[sqlite3.Connection] = None
_lock = threading.RLock()

# (channel_id, allowed_extensions) — the unit every read query works in.
# Extensions are applied at *query* time rather than baked into the rows,
# so editing a channel's allowlist in Settings takes effect immediately
# without a re-scan or re-index.
ChannelScope = Tuple[str, Sequence[str]]

_TABLES = """
CREATE TABLE IF NOT EXISTS documents (
    channel_id TEXT    NOT NULL,
    msg_id     INTEGER NOT NULL,
    name       TEXT    NOT NULL,
    name_lower TEXT    NOT NULL,
    ext        TEXT,
    size       INTEGER NOT NULL,
    date       TEXT    NOT NULL,
    mime_type  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_pk ON documents(channel_id, msg_id);

CREATE TABLE IF NOT EXISTS channels_meta (
    channel_id TEXT PRIMARY KEY,
    fetched_at REAL    NOT NULL,
    max_id     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);
"""

# Created after a bulk import rather than before — building them once over
# a finished table is cheaper than maintaining them across 150k inserts.
_INDEXES = """
CREATE INDEX IF NOT EXISTS idx_documents_ch_date ON documents(channel_id, date);
CREATE INDEX IF NOT EXISTS idx_documents_ch_name ON documents(channel_id, name_lower);
CREATE INDEX IF NOT EXISTS idx_documents_ch_ext  ON documents(channel_id, ext);
"""
# idx_documents_ch_ext covers channel_counts() — the single hottest query,
# hit by the collection tree on every navigation and by the polled channel
# list. Counting straight off the index rather than the table measured
# 41ms -> 26ms across ~150k documents, for no meaningful disk cost.
#
# No index on `size`: an unindexed sort of the largest channel measured
# ~25ms, not worth the extra megabytes for a rarely-used sort order. No
# index for search either — instr() cannot use one.

# `sort` arrives straight off the query string, so it selects from this
# table and is never interpolated into SQL.
#
# The (channel_id, msg_id) tiebreaker is load-bearing, not decoration:
# many documents share a `date` down to the minute, and the UI pages
# through results with LIMIT/OFFSET. Without a total order, two requests
# for adjacent pages can order tied rows differently, and the infinite
# scroll then duplicates and skips rows.
_SORTS = {
    "date_desc": "date DESC, channel_id ASC, msg_id DESC",
    "date_asc": "date ASC, channel_id ASC, msg_id ASC",
    "name_asc": "name_lower ASC, channel_id ASC, msg_id ASC",
    "name_desc": "name_lower DESC, channel_id ASC, msg_id DESC",
    "size_desc": "size DESC, channel_id ASC, msg_id DESC",
    "size_asc": "size ASC, channel_id ASC, msg_id ASC",
}
_DEFAULT_SORT = "date_desc"


def _ext_of(name: str) -> Optional[str]:
    """A channel's `allowedExtensions` (Settings → Channels, pill UI)
    restricts which documents surface in its listings, counts and search.
    This is the matching rule: the part after the last dot, lowercased.
    None when the name has no dot at all, which no allowlist ever matches.
    An empty allowlist means no restriction — see _scope_sql."""
    return name.rsplit(".", 1)[-1].lower() if "." in name else None


def normalize_extensions(allowed: Sequence[str]) -> List[str]:
    return sorted({ext.lower().lstrip(".") for ext in allowed})


def _scope_sql(scope: Sequence[ChannelScope]) -> Tuple[str, list]:
    """Build the WHERE fragment restricting a query to a set of channels,
    each with its own extension allowlist. Channels sharing an allowlist
    collapse into one branch, so the common case (a handful of distinct
    allowlists across every channel) stays a short predicate."""
    by_allowlist: Dict[Tuple[str, ...], List[str]] = {}
    for channel_id, allowed in scope:
        by_allowlist.setdefault(tuple(normalize_extensions(allowed)), []).append(channel_id)

    branches, params = [], []
    for exts, channel_ids in by_allowlist.items():
        ch_ph = ",".join("?" * len(channel_ids))
        if exts:
            ext_ph = ",".join("?" * len(exts))
            branches.append(f"(channel_id IN ({ch_ph}) AND ext IN ({ext_ph}))")
            params.extend(channel_ids)
            params.extend(exts)
        else:
            branches.append(f"channel_id IN ({ch_ph})")
            params.extend(channel_ids)

    if not branches:
        return "0", []  # empty scope matches nothing
    return "(" + " OR ".join(branches) + ")", params


# A query is split on whitespace and every term must appear somewhere in the
# filename, in any order — so "TH Ban" finds "TH -Bangalore" and
# "TH - School - Bangalore", the way searching in Telegram itself does.
# Filenames separate the same words with spaces, dashes, dots and
# underscores interchangeably, so requiring one contiguous match would miss
# nearly everything a user types from memory.
#
# A single-term query behaves exactly as a plain substring match, which is
# what it has always been.
_MAX_SEARCH_TERMS = 8


def _search_terms(search: str) -> List[str]:
    """Split a query into the terms a filename must contain, all lowercase.

    Longest first: SQLite short-circuits a chain of ANDs, so testing the
    most selective term first rejects most rows on their first comparison.
    """
    terms = sorted({t for t in search.lower().split() if t}, key=len, reverse=True)
    return terms[:_MAX_SEARCH_TERMS]


def _row_to_doc(row: sqlite3.Row) -> DocumentOut:
    return DocumentOut(
        id=row["msg_id"],
        name=row["name"],
        size=row["size"],
        date=row["date"],
        mime_type=row["mime_type"],
        channelId=row["channel_id"],
    )


# --------------------------------------------------------------------------
# lifecycle
# --------------------------------------------------------------------------


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    mode = conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]
    if str(mode).lower() != "wal":
        # WAL needs shared memory and misbehaves on some network filesystems.
        # The default rollback journal still works, just with less
        # reader/writer concurrency, so this is a warning and not a failure.
        log.warning("Could not enable WAL journaling (got %r) — continuing without it", mode)
    return conn


def init() -> None:
    """Open the database, create the schema, and import a legacy JSON cache
    if this is the first run. Call once at startup; it blocks, so callers
    on the event loop should use asyncio.to_thread."""
    global _conn
    with _lock:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        try:
            # Both of these can raise on a damaged file: connecting fails on
            # the first PRAGMA if the header is wrong, while subtler damage
            # only surfaces once the schema is touched.
            _conn = _connect()
            _bootstrap()
        except sqlite3.DatabaseError as e:
            # A corrupt database is recoverable in a way the rest of config/
            # is not: quarantine it and rebuild from the JSON backup, or
            # failing that from Telegram on the next refresh.
            log.error("documents.db is unusable (%s) — quarantining it and starting fresh", e)
            _quarantine_db()
            _conn = _connect()
            _bootstrap()


def _quarantine_db() -> None:
    global _conn
    if _conn is not None:
        try:
            _conn.close()
        except sqlite3.Error:
            pass
        _conn = None
    stamp = int(time.time())
    # The -wal/-shm sidecars belong to the file being moved aside; leaving
    # them behind would let a stale journal be replayed into the new one.
    for suffix in ("", "-wal", "-shm"):
        path = DB_PATH + suffix
        if os.path.exists(path):
            os.replace(path, f"{DB_PATH}.corrupt-{stamp}{suffix}")


def _bootstrap() -> None:
    _conn.executescript(_TABLES)
    _conn.execute(
        "INSERT INTO schema_meta(key, value) VALUES('version', ?)"
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (SCHEMA_VERSION,),
    )

    # Any row at all means the import already happened. This — not the
    # presence of the JSON file — is the idempotency guard, so a rename
    # that failed midway can never cause a double import.
    if _conn.execute("SELECT 1 FROM documents LIMIT 1").fetchone():
        _conn.executescript(_INDEXES)
        return

    source = None
    if os.path.exists(LEGACY_JSON_PATH):
        source = LEGACY_JSON_PATH
    elif os.path.exists(LEGACY_BACKUP_PATH):
        # Reached when documents.db was deleted or quarantined: re-import
        # ~150k documents from the backup instead of forcing a multi-hour
        # full rescan of every channel against Telegram.
        source = LEGACY_BACKUP_PATH

    if source:
        _import_legacy_json(source)

    _conn.executescript(_INDEXES)
    _conn.execute("ANALYZE")


def _import_legacy_json(path: str) -> None:
    started = time.time()
    try:
        with open(path) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError(f"expected a JSON object, got {type(data).__name__}")
    except (json.JSONDecodeError, OSError, UnicodeDecodeError, ValueError) as e:
        # Previously a truncated cache crashed the whole app at startup.
        # The file is left exactly as it is, both to preserve user data and
        # so it can be inspected; the app comes up with an empty cache and
        # refills from Telegram.
        log.error("Could not read legacy cache %s (%s) — starting with an empty database", path, e)
        return

    skipped = 0

    def rows() -> Iterator[tuple]:
        nonlocal skipped
        for channel_id, entry in data.items():
            for d in (entry or {}).get("documents", []):
                try:
                    name = d["name"]
                    yield (
                        channel_id,
                        int(d["id"]),
                        name,
                        name.lower(),
                        _ext_of(name),
                        int(d["size"]),
                        d["date"],
                        d.get("mime_type"),
                    )
                except (KeyError, TypeError, ValueError, AttributeError):
                    skipped += 1

    meta = [
        (
            cid,
            float((entry or {}).get("fetched_at") or time.time()),
            int((entry or {}).get("max_id") or 0),
        )
        for cid, entry in data.items()
    ]

    _conn.execute("BEGIN")
    try:
        _conn.executemany(
            "INSERT OR REPLACE INTO documents"
            "(channel_id, msg_id, name, name_lower, ext, size, date, mime_type)"
            " VALUES(?,?,?,?,?,?,?,?)",
            rows(),
        )
        _conn.executemany(
            "INSERT OR REPLACE INTO channels_meta(channel_id, fetched_at, max_id) VALUES(?,?,?)",
            meta,
        )
        _conn.execute("COMMIT")
    except Exception:
        _conn.execute("ROLLBACK")
        raise

    total = _conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    log.info(
        "Imported %d document(s) across %d channel(s) from %s in %.1fs%s",
        total,
        len(meta),
        os.path.basename(path),
        time.time() - started,
        f" ({skipped} malformed record(s) skipped)" if skipped else "",
    )

    # Only now that the data is committed, and a rename rather than a
    # delete: config/ holds live user data, and this backup is the fallback
    # if the database is ever lost.
    if path == LEGACY_JSON_PATH:
        os.replace(LEGACY_JSON_PATH, LEGACY_BACKUP_PATH)
        log.info("Kept the previous cache as %s", os.path.basename(LEGACY_BACKUP_PATH))


def close() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            try:
                _conn.execute("PRAGMA optimize")
            except sqlite3.Error:
                pass
            _conn.close()
            _conn = None


# --------------------------------------------------------------------------
# reads
# --------------------------------------------------------------------------


def query_documents(
    scope: Sequence[ChannelScope],
    search: Optional[str] = None,
    sort: str = _DEFAULT_SORT,
    offset: int = 0,
    limit: int = 20,
) -> Tuple[List[DocumentOut], int]:
    """One page of documents across `scope`, plus the total match count.

    `search` is matched case-insensitively against the filename: every
    whitespace-separated term must appear in it, in any order (see
    _search_terms). Terms are matched with instr() rather than LIKE so that
    a user typing `%` or `_` searches for that literal character instead of
    it acting as a wildcard.
    """
    where, params = _scope_sql(scope)
    params = list(params)
    for term in _search_terms(search or ""):
        where += " AND instr(name_lower, ?) > 0"
        params.append(term)

    order = _SORTS.get(sort, _SORTS[_DEFAULT_SORT])
    with _lock:
        total = _conn.execute(f"SELECT COUNT(*) FROM documents WHERE {where}", params).fetchone()[0]
        rows = _conn.execute(
            "SELECT channel_id, msg_id, name, size, date, mime_type FROM documents"
            f" WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?",
            params + [limit, offset],
        ).fetchall()
    return [_row_to_doc(r) for r in rows], total


def channel_counts(scope: Sequence[ChannelScope]) -> Dict[str, Optional[int]]:
    """Document count per channel, honouring each one's extension allowlist.

    None means "never scanned", which the UI shows differently from a
    channel that was scanned and legitimately holds nothing.
    """
    if not scope:
        return {}
    channel_ids = [cid for cid, _ in scope]
    where, params = _scope_sql(scope)
    ph = ",".join("?" * len(channel_ids))
    with _lock:
        counted = dict(
            _conn.execute(
                f"SELECT channel_id, COUNT(*) FROM documents WHERE {where} GROUP BY channel_id",
                params,
            ).fetchall()
        )
        known = {
            r[0]
            for r in _conn.execute(
                f"SELECT channel_id FROM channels_meta WHERE channel_id IN ({ph})", channel_ids
            ).fetchall()
        }
    return {cid: (counted.get(cid, 0) if cid in known else None) for cid in channel_ids}


def count_documents(channel_id: str) -> int:
    """Unfiltered document count for one channel — compared against
    Telegram's own file count to detect deletions, so it must ignore
    extension allowlists the same way that count does."""
    with _lock:
        return _conn.execute(
            "SELECT COUNT(*) FROM documents WHERE channel_id = ?", (channel_id,)
        ).fetchone()[0]


def iter_names(scope: Sequence[ChannelScope]) -> Iterator[str]:
    """Stream filenames across `scope` for keyword extraction — streamed
    rather than returned as a list so a 66k-document collection never
    materializes all of its names at once."""
    where, params = _scope_sql(scope)
    with _lock:
        for row in _conn.execute(f"SELECT name FROM documents WHERE {where}", params):
            yield row[0]


def has_channel(channel_id: str) -> bool:
    """Whether this channel has ever been scanned. A channel with a meta row
    but zero documents is 'scanned and empty', not 'unscanned'."""
    with _lock:
        return (
            _conn.execute(
                "SELECT 1 FROM channels_meta WHERE channel_id = ?", (channel_id,)
            ).fetchone()
            is not None
        )


def get_fetched_at(channel_id: str) -> Optional[float]:
    with _lock:
        row = _conn.execute(
            "SELECT fetched_at FROM channels_meta WHERE channel_id = ?", (channel_id,)
        ).fetchone()
    return row[0] if row else None


def get_max_id(channel_id: str) -> int:
    """Highest Telegram message ID captured so far, used as the `min_id`
    cursor for incremental refreshes. 0 for a channel never fully scanned."""
    with _lock:
        row = _conn.execute(
            "SELECT max_id FROM channels_meta WHERE channel_id = ?", (channel_id,)
        ).fetchone()
    return row[0] if row else 0


# --------------------------------------------------------------------------
# writes
# --------------------------------------------------------------------------


def upsert_documents(channel_id: str, docs: Sequence[DocumentOut]) -> None:
    """Add/update a batch of documents for one channel.

    Deliberately cannot touch `max_id`: a scan calls this repeatedly as it
    streams, and the cursor must not advance until the scan finishes (see
    set_cursor). Only `fetched_at` moves, which is what lets the UI's
    counts climb while a long scan is still running.
    """
    if not docs:
        return
    rows = [
        (channel_id, d.id, d.name, d.name.lower(), _ext_of(d.name), d.size, d.date, d.mime_type)
        for d in docs
    ]
    with _lock:
        _conn.execute("BEGIN")
        try:
            _conn.executemany(
                "INSERT INTO documents"
                "(channel_id, msg_id, name, name_lower, ext, size, date, mime_type)"
                " VALUES(?,?,?,?,?,?,?,?)"
                " ON CONFLICT(channel_id, msg_id) DO UPDATE SET"
                "  name=excluded.name, name_lower=excluded.name_lower, ext=excluded.ext,"
                "  size=excluded.size, date=excluded.date, mime_type=excluded.mime_type",
                rows,
            )
            _conn.execute(
                "INSERT INTO channels_meta(channel_id, fetched_at, max_id) VALUES(?,?,0)"
                " ON CONFLICT(channel_id) DO UPDATE SET fetched_at=excluded.fetched_at",
                (channel_id, time.time()),
            )
            _conn.execute("COMMIT")
        except Exception:
            _conn.execute("ROLLBACK")
            raise


def set_cursor(channel_id: str, max_id: int) -> None:
    """Advance the incremental-scan cursor — called once, only after a scan
    has run to completion.

    Messages arrive newest-first, so a partial scan is missing its *older*
    tail. Advancing the cursor mid-scan would make an interrupted scan look
    complete and leave those files permanently unreachable to later
    incremental refreshes.
    """
    with _lock:
        _conn.execute(
            "INSERT INTO channels_meta(channel_id, fetched_at, max_id) VALUES(?,?,?)"
            " ON CONFLICT(channel_id) DO UPDATE SET"
            "  fetched_at=excluded.fetched_at, max_id=excluded.max_id",
            (channel_id, time.time(), max_id),
        )


def remove_document(channel_id: str, msg_id: int) -> bool:
    """Drop one document from a channel's listing — for when a download
    discovers the message is gone from Telegram, so the dead entry stops
    being offered instead of waiting for the next refresh to notice.
    max_id is deliberately left alone: it's the incremental scan cursor,
    not a count, and lowering it would re-scan history for no reason."""
    with _lock:
        cur = _conn.execute(
            "DELETE FROM documents WHERE channel_id = ? AND msg_id = ?", (channel_id, msg_id)
        )
        return cur.rowcount > 0


def invalidate(channel_id: str) -> None:
    """Forget a channel entirely — it goes back to reading as 'unscanned'."""
    with _lock:
        _conn.execute("BEGIN")
        try:
            _conn.execute("DELETE FROM documents WHERE channel_id = ?", (channel_id,))
            _conn.execute("DELETE FROM channels_meta WHERE channel_id = ?", (channel_id,))
            _conn.execute("COMMIT")
        except Exception:
            _conn.execute("ROLLBACK")
            raise
