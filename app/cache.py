"""SQLite-backed store for per-source item listings.

Avoids re-scanning a Telegram channel's full message history on every
collection open (slow + risks Telegram FloodWait rate limiting). Unlike a
short TTL cache, entries here don't expire on their own — they're kept
fresh by a periodic background refresh loop (see refresh.py) and survive
process restarts.
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

SCHEMA_VERSION = 4

log = logging.getLogger("panda_vault.cache")

# One shared *write* connection guarded by a lock. The connection is
# genuinely cross-thread: a few routes are sync `def` (so FastAPI runs them
# on the anyio threadpool) while the rest are `async def` on the event loop,
# and scans hand slow work to asyncio.to_thread. sqlite3.threadsafety == 3
# makes sharing legal, but statements from concurrent threads would still
# interleave inside a transaction — hence the lock on every write, the same
# pattern store.py uses.
#
# Reads do NOT go through this connection or lock — see _read_conn below.
# They used to, and it was a real problem: replace_source_documents (an M3U
# snapshot swap) deletes and re-inserts every entry in one transaction, and
# on a Raspberry Pi's SD card that can take seconds. Every other request
# touching the cache — completely unrelated playlists, the notification
# bell, ordinary browsing — was queued behind that same lock, so one big
# playlist rescan looked like the whole app freezing.
_conn: Optional[sqlite3.Connection] = None
_lock = threading.RLock()

# A read connection per thread rather than one shared reader: two threads
# sharing a single sqlite3.Connection would need the same interleaving
# protection _lock gives writes, which just reintroduces cross-request
# stalls on the read side. A separate connection per thread needs no lock at
# all — each has its own handle, and WAL gives each one an independent,
# consistent snapshot that never blocks on (or blocks) the writer.
_read_local = threading.local()
_read_conns_lock = threading.Lock()
_all_read_conns: List[sqlite3.Connection] = []
# Bumped when the underlying file is replaced (see _quarantine_db) so a
# thread's cached read connection — which would otherwise still point at
# the old, now-quarantined file — gets reopened against the current one.
_generation = 0


def _read_conn() -> sqlite3.Connection:
    conn = getattr(_read_local, "conn", None)
    if conn is None or getattr(_read_local, "generation", -1) != _generation:
        conn = _connect()
        _read_local.conn = conn
        _read_local.generation = _generation
        with _read_conns_lock:
            _all_read_conns.append(conn)
    return conn


# (source_id, allowed_extensions) — the unit every read query works in.
# A source is a Telegram channel or an M3U playlist; they share one id
# space, so nothing below this line needs to know which it is dealing with.
# Extensions are applied at *query* time rather than baked into the rows,
# so editing a channel's allowlist in Settings takes effect immediately
# without a re-scan or re-index.
SourceScope = Tuple[str, Sequence[str]]

# How the last attempt to fetch a source went, as stored in source_health.
# A source that has never been attempted has no row at all, which is
# different from FETCH_OK — see get_source_health.
FETCH_OK = "ok"          # fetched and accepted
FETCH_FAILED = "failed"  # the URL did not answer, or answered with an error
FETCH_INVALID = "invalid"  # it answered, but not with a playlist
FETCH_SHRUNK = "shrunk"  # it answered with far less than last time — swap refused

# How a single stream URL responded when it was last probed. `unknown` is
# the deliberate middle ground: something went wrong, but not yet in a way
# worth telling the user a channel is dead (see health.py).
STREAM_AVAILABLE = "available"
STREAM_UNAVAILABLE = "unavailable"
STREAM_UNKNOWN = "unknown"
# Not a stored value — what a URL with no row at all reads as.
STREAM_UNCHECKED = "unchecked"

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

# Schema changes after the initial `_TABLES` shape, applied in order by
# _migrate(). Version 1 *is* `_TABLES`, so it has no entry here: a fresh
# database gets the v1 shape from the executescript above and then walks
# the same migration path an existing one does, which keeps a single code
# path rather than two shapes that have to be kept in agreement.
#
# Each step is (table, column, statement) so it can be skipped when the
# column is already there — ALTER TABLE ... ADD COLUMN is not idempotent
# and raises "duplicate column name" on a second run.
_MIGRATIONS = {
    2: [
        # M3U entries carry a stream URL, a logo and a group instead of a
        # downloadable file. Nullable, so every existing Telegram row stays
        # valid without a rewrite.
        ("documents", "url", "ALTER TABLE documents ADD COLUMN url TEXT"),
        ("documents", "logo", "ALTER TABLE documents ADD COLUMN logo TEXT"),
        ("documents", "group_title", "ALTER TABLE documents ADD COLUMN group_title TEXT"),
        # Stored rather than derived from `url IS NOT NULL`: search returns
        # rows from both source types in one query, and each row has to know
        # how to render itself without a lookup back to the source list.
        (
            "documents",
            "source_type",
            "ALTER TABLE documents ADD COLUMN source_type TEXT NOT NULL DEFAULT 'telegram'",
        ),
    ],
}

# Whole tables added after v1, as opposed to the columns above. Sibling of
# _MIGRATIONS rather than part of it because a CREATE TABLE has no column to
# guard on — `IF NOT EXISTS` already makes it idempotent.
_MIGRATION_TABLES = {
    4: [
        # Per-stream reachability, keyed by the URL itself rather than by
        # (source, entry). Both halves of that matter:
        #
        #  - An M3U refresh is a whole-partition swap and an entry's msg_id
        #    is only its ordinal in the current snapshot, so anything keyed
        #    per-row would be destroyed every single night.
        #  - Free playlists overlap heavily. Keying on the URL means the
        #    same stream listed in five playlists is probed once, and the
        #    answer is shared — which is most of why this is affordable.
        """CREATE TABLE IF NOT EXISTS stream_health (
            url         TEXT PRIMARY KEY,
            status      TEXT    NOT NULL,
            http_code   INTEGER,
            latency_ms  INTEGER,
            checked_at  REAL    NOT NULL,
            fail_streak INTEGER NOT NULL DEFAULT 0,
            error       TEXT
        )""",
    ],
    3: [
        # How the last fetch of a source went — kept out of channels_meta on
        # purpose. The mere existence of a channels_meta row is what
        # has_source() reads as "this source has been scanned", so recording
        # a *failed* first fetch there would make a source that has never
        # produced a single row look scanned-and-empty.
        #
        # Derived like the rest of this database: losing it costs one cycle
        # of not knowing a playlist URL is broken, nothing more.
        """CREATE TABLE IF NOT EXISTS source_health (
            source_id       TEXT PRIMARY KEY,
            status          TEXT    NOT NULL,
            error           TEXT,
            last_attempt_at REAL    NOT NULL,
            last_ok_at      REAL,
            fail_streak     INTEGER NOT NULL DEFAULT 0
        )""",
    ],
}

_MIGRATION_INDEXES = {
    2: [
        "CREATE INDEX IF NOT EXISTS idx_documents_ch_group ON documents(channel_id, group_title)",
    ],
    4: [
        # Drives "check the least recently checked first", which is how a
        # budgeted sweep round-robins over more URLs than one night fits.
        "CREATE INDEX IF NOT EXISTS idx_stream_health_checked ON stream_health(checked_at)",
    ],
}


# Created after a bulk import rather than before — building them once over
# a finished table is cheaper than maintaining them across 150k inserts.
_INDEXES = """
CREATE INDEX IF NOT EXISTS idx_documents_ch_date ON documents(channel_id, date);
CREATE INDEX IF NOT EXISTS idx_documents_ch_name ON documents(channel_id, name_lower);
CREATE INDEX IF NOT EXISTS idx_documents_ch_ext  ON documents(channel_id, ext);
"""
# idx_documents_ch_ext covers source_counts() — the single hottest query,
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
    # m3u only in practice: Telegram documents have no group. NULLs sort
    # last in both directions so ungrouped entries never head the list.
    "group_asc": "group_title IS NULL, group_title ASC, name_lower ASC, channel_id ASC, msg_id ASC",
    "group_desc": "group_title IS NULL, group_title DESC, name_lower ASC, channel_id ASC, msg_id DESC",
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


def _scope_sql(scope: Sequence[SourceScope]) -> Tuple[str, list]:
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


# Every read goes through this list, so the column order can never drift
# out of step with _row_to_doc below.
# Qualified with the `d` alias because every read now left-joins
# stream_health, and `url` exists in both tables — an unqualified reference
# is an "ambiguous column name" error at runtime.
_DOC_COLUMNS = (
    "d.channel_id, d.msg_id, d.name, d.size, d.date, d.mime_type,"
    " d.source_type, d.url, d.logo, d.group_title"
)

# What a caller may filter a listing down to. `unchecked` is the absence of
# a row rather than a stored status, so it gets its own branch.
_HEALTH_FILTERS = (STREAM_AVAILABLE, STREAM_UNAVAILABLE, STREAM_UNKNOWN, STREAM_UNCHECKED)


def _row_to_doc(row: sqlite3.Row) -> DocumentOut:
    return DocumentOut(
        id=row["msg_id"],
        health=row["health"] or (STREAM_UNCHECKED if row["url"] else None),
        healthCheckedAt=row["health_checked_at"],
        name=row["name"],
        size=row["size"],
        date=row["date"],
        mime_type=row["mime_type"],
        sourceId=row["channel_id"],
        sourceType=row["source_type"],
        url=row["url"],
        logo=row["logo"],
        group=row["group_title"],
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
    global _conn, _generation
    if _conn is not None:
        try:
            _conn.close()
        except sqlite3.Error:
            pass
        _conn = None
    # Existing threads' read connections still hold the old (about-to-be
    # renamed) file open — this makes each reopen against the current file
    # the next time it's used, rather than keep reading the quarantined one.
    _generation += 1
    stamp = int(time.time())
    # The -wal/-shm sidecars belong to the file being moved aside; leaving
    # them behind would let a stale journal be replayed into the new one.
    for suffix in ("", "-wal", "-shm"):
        path = DB_PATH + suffix
        if os.path.exists(path):
            os.replace(path, f"{DB_PATH}.corrupt-{stamp}{suffix}")


def _bootstrap() -> None:
    _conn.executescript(_TABLES)
    _migrate()

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


def _migrate() -> None:
    """Bring the schema up to SCHEMA_VERSION, then record that it is there.

    Versions before this runner existed wrote `version` into schema_meta but
    never read it back, so an in-the-wild 2.x database reports "1" and a
    brand new one reports nothing at all. Both are handled by the same walk:
    a missing row means 0, and the range below simply starts one step later
    for the database that already claims 1.
    """
    row = _conn.execute("SELECT value FROM schema_meta WHERE key='version'").fetchone()
    try:
        current = int(row[0]) if row else 0
    except (TypeError, ValueError):
        current = 0

    for version in range(current + 1, SCHEMA_VERSION + 1):
        for statement in _MIGRATION_TABLES.get(version, []):
            _conn.execute(statement)
        for table, column, statement in _MIGRATIONS.get(version, []):
            existing = {r[1] for r in _conn.execute(f"PRAGMA table_info({table})")}
            if column not in existing:
                _conn.execute(statement)
        for statement in _MIGRATION_INDEXES.get(version, []):
            _conn.execute(statement)
        log.info("Applied schema migration %d", version)

    _conn.execute(
        "INSERT INTO schema_meta(key, value) VALUES('version', ?)"
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(SCHEMA_VERSION),),
    )


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
    with _read_conns_lock:
        for conn in _all_read_conns:
            try:
                conn.close()
            except sqlite3.Error:
                pass
        _all_read_conns.clear()


# --------------------------------------------------------------------------
# reads
# --------------------------------------------------------------------------


_JOIN_HEALTH = "documents d LEFT JOIN stream_health h ON h.url = d.url"


def _health_filter_sql(health: Optional[str]) -> Tuple[str, list]:
    """WHERE fragment restricting a listing to one reachability state."""
    if not health or health not in _HEALTH_FILTERS:
        return "", []
    if health == STREAM_UNCHECKED:
        # No row at all. Telegram documents have no URL and so are never
        # checkable; they must not be swept up by a "show me what hasn't
        # been checked" filter aimed at streams.
        return " AND h.url IS NULL AND d.url IS NOT NULL", []
    return " AND h.status = ?", [health]


def _group_filter_sql(group: Optional[str]) -> Tuple[str, list]:
    """WHERE fragment matching one category out of a `group_title` that may
    itself list several, `;`-joined — the multi-tag convention real
    playlists use (see m3u.py's parsing notes). Wrapping both the column and
    the needle in `;` turns a substring test into a whole-tag match, so a
    "General" filter doesn't also catch "GeneralNews". Matched with instr()
    rather than LIKE for the same reason search is: a category containing a
    literal `%` or `_` must not act as a wildcard.

    `group=""` is a caller's explicit ask for the untagged bucket ("Other
    channels" in the UI) — distinct from `group=None`, which applies no
    filter at all.
    """
    if group is None:
        return "", []
    if group == "":
        return " AND (group_title IS NULL OR TRIM(group_title) = '')", []
    return " AND instr(';' || group_title || ';', ?) > 0", [f";{group};"]


def query_documents(
    scope: Sequence[SourceScope],
    search: Optional[str] = None,
    sort: str = _DEFAULT_SORT,
    offset: int = 0,
    limit: int = 20,
    health: Optional[str] = None,
    group: Optional[str] = None,
) -> Tuple[List[DocumentOut], int]:
    """One page of documents across `scope`, plus the total match count.

    `search` is matched case-insensitively against the filename: every
    whitespace-separated term must appear in it, in any order (see
    _search_terms). Terms are matched with instr() rather than LIKE so that
    a user typing `%` or `_` searches for that literal character instead of
    it acting as a wildcard.

    `health` narrows to one reachability state (see _HEALTH_FILTERS). It
    arrives off the query string, so it selects from that tuple and is
    never interpolated.

    `group` narrows to one category (see _group_filter_sql) — a group
    detail page's scope, m3u only in practice.
    """
    where, params = _scope_sql(scope)
    params = list(params)
    for term in _search_terms(search or ""):
        where += " AND instr(name_lower, ?) > 0"
        params.append(term)

    group_sql, group_params = _group_filter_sql(group)
    where += group_sql
    params += group_params

    health_sql, health_params = _health_filter_sql(health)
    where += health_sql
    params += health_params

    order = _SORTS.get(sort, _SORTS[_DEFAULT_SORT])
    conn = _read_conn()
    # The count only needs the join when it is being filtered on — the
    # common unfiltered listing stays a single-table count.
    count_from = _JOIN_HEALTH if health_sql else "documents d"
    total = conn.execute(f"SELECT COUNT(*) FROM {count_from} WHERE {where}", params).fetchone()[0]
    rows = conn.execute(
        f"SELECT {_DOC_COLUMNS}, h.status AS health, h.checked_at AS health_checked_at"
        f" FROM {_JOIN_HEALTH}"
        f" WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()
    return [_row_to_doc(r) for r in rows], total


def list_groups(
    scope: Sequence[SourceScope],
    search: Optional[str] = None,
    health: Optional[str] = None,
) -> List[Tuple[str, int]]:
    """Every category a scope's `group_title`s resolve to, with how many
    entries carry each — honoring the same search/health filters
    `query_documents` would, so a category card's count matches what
    clicking into it actually shows. Untagged entries come back under `""`.

    `group_title` is one string, but real playlists pack several categories
    into it joined with `;` (see `_group_filter_sql`). SQL does the
    expensive part — scanning `scope` and aggregating per *raw* group_title,
    of which a playlist has only a handful of distinct values regardless of
    how many entries carry each — and the `;`-split fan-out happens here in
    Python over that small result, rather than as a recursive CTE.
    """
    if not scope:
        return []
    where, params = _scope_sql(scope)
    params = list(params)
    for term in _search_terms(search or ""):
        where += " AND instr(name_lower, ?) > 0"
        params.append(term)
    health_sql, health_params = _health_filter_sql(health)
    where += health_sql
    params += health_params
    from_clause = _JOIN_HEALTH if health_sql else "documents d"
    rows = _read_conn().execute(
        f"SELECT group_title, COUNT(*) FROM {from_clause} WHERE {where} GROUP BY group_title",
        params,
    ).fetchall()
    tally: Dict[str, int] = {}
    for group_title, entry_count in rows:
        raw = (group_title or "").strip()
        keys = list(dict.fromkeys(k.strip() for k in raw.split(";") if k.strip())) or [""]
        for key in keys:
            tally[key] = tally.get(key, 0) + entry_count
    return sorted(tally.items(), key=lambda kv: (kv[0] == "", kv[0].lower()))


def stream_health_summary(scope: Sequence[SourceScope]) -> Dict[str, int]:
    """How many entries in `scope` sit in each reachability state.

    Counts *entries*, not distinct URLs: a stream listed in three of your
    playlists is three things you can click, even though it was only probed
    once. That's the number the UI is captioning.
    """
    if not scope:
        return {}
    where, params = _scope_sql(scope)
    rows = _read_conn().execute(
        f"SELECT COALESCE(h.status, ?) AS state, COUNT(*) FROM {_JOIN_HEALTH}"
        f" WHERE {where} AND d.url IS NOT NULL GROUP BY state",
        [STREAM_UNCHECKED] + list(params),
    ).fetchall()
    return {r[0]: r[1] for r in rows}


def source_counts(scope: Sequence[SourceScope]) -> Dict[str, Optional[int]]:
    """Document count per channel, honouring each one's extension allowlist.

    None means "never scanned", which the UI shows differently from a
    channel that was scanned and legitimately holds nothing.
    """
    if not scope:
        return {}
    channel_ids = [cid for cid, _ in scope]
    where, params = _scope_sql(scope)
    ph = ",".join("?" * len(channel_ids))
    conn = _read_conn()
    counted = dict(
        conn.execute(
            f"SELECT channel_id, COUNT(*) FROM documents WHERE {where} GROUP BY channel_id",
            params,
        ).fetchall()
    )
    known = {
        r[0]
        for r in conn.execute(
            f"SELECT channel_id FROM channels_meta WHERE channel_id IN ({ph})", channel_ids
        ).fetchall()
    }
    return {cid: (counted.get(cid, 0) if cid in known else None) for cid in channel_ids}


def count_documents(channel_id: str) -> int:
    """Unfiltered document count for one channel — compared against
    Telegram's own file count to detect deletions, so it must ignore
    extension allowlists the same way that count does."""
    return _read_conn().execute(
        "SELECT COUNT(*) FROM documents WHERE channel_id = ?", (channel_id,)
    ).fetchone()[0]


def iter_names(scope: Sequence[SourceScope]) -> Iterator[str]:
    """Stream filenames across `scope` for keyword extraction — streamed
    rather than returned as a list so a 66k-document collection never
    materializes all of its names at once."""
    where, params = _scope_sql(scope)
    for row in _read_conn().execute(f"SELECT name FROM documents WHERE {where}", params):
        yield row[0]


def iter_documents(scope: Sequence[SourceScope], sort: str = "date_asc") -> Iterator[DocumentOut]:
    """Stream every document across `scope` in `sort` order, for an export
    that wants every row rather than one page — see query_documents, which
    is built around a single LIMIT/OFFSET page instead. No stream_health
    join: an export doesn't need reachability, just what to write out."""
    where, params = _scope_sql(scope)
    order = _SORTS.get(sort, _SORTS[_DEFAULT_SORT])
    rows = _read_conn().execute(
        f"SELECT {_DOC_COLUMNS} FROM documents d WHERE {where} ORDER BY {order}", params
    ).fetchall()
    for row in rows:
        yield DocumentOut(
                id=row["msg_id"],
                name=row["name"],
                size=row["size"],
                date=row["date"],
                mime_type=row["mime_type"],
                sourceId=row["channel_id"],
                sourceType=row["source_type"],
                url=row["url"],
                logo=row["logo"],
                group=row["group_title"],
            )


def has_source(channel_id: str) -> bool:
    """Whether this channel has ever been scanned. A channel with a meta row
    but zero documents is 'scanned and empty', not 'unscanned'."""
    return (
        _read_conn().execute(
            "SELECT 1 FROM channels_meta WHERE channel_id = ?", (channel_id,)
        ).fetchone()
        is not None
    )


def get_fetched_at(channel_id: str) -> Optional[float]:
    row = _read_conn().execute(
        "SELECT fetched_at FROM channels_meta WHERE channel_id = ?", (channel_id,)
    ).fetchone()
    return row[0] if row else None


def _health_row(row: sqlite3.Row) -> dict:
    return {
        "status": row["status"],
        "error": row["error"],
        "lastAttemptAt": row["last_attempt_at"],
        "lastOkAt": row["last_ok_at"],
        "failStreak": row["fail_streak"],
    }


def get_source_health(source_id: str) -> Optional[dict]:
    """How this source's last fetch went, or None if one has never been
    attempted — which is not the same as one having failed."""
    row = _read_conn().execute(
        "SELECT * FROM source_health WHERE source_id = ?", (source_id,)
    ).fetchone()
    return _health_row(row) if row else None


def source_health_many(source_ids: Sequence[str]) -> Dict[str, dict]:
    """The health of several sources in one query — for the list endpoints,
    which would otherwise pay a round trip per playlist."""
    if not source_ids:
        return {}
    ph = ",".join("?" * len(source_ids))
    rows = _read_conn().execute(
        f"SELECT * FROM source_health WHERE source_id IN ({ph})", list(source_ids)
    ).fetchall()
    return {r["source_id"]: _health_row(r) for r in rows}


def get_max_id(channel_id: str) -> int:
    """Highest Telegram message ID captured so far, used as the `min_id`
    cursor for incremental refreshes. 0 for a channel never fully scanned."""
    row = _read_conn().execute(
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


def _stream_ext(doc: DocumentOut) -> Optional[str]:
    """Extension for an M3U entry, taken from its stream URL rather than its
    display name — a channel called "BBC News HD" has no extension, but the
    URL it points at ends in .m3u8/.ts/.mp4. That is what a playlist's
    allowedExtensions is matched against, so "only .m3u8 streams" works the
    same way "only .pdf files" does for a channel."""
    if not doc.url:
        return _ext_of(doc.name)
    path = doc.url.split("?", 1)[0].split("#", 1)[0]
    return _ext_of(path.rsplit("/", 1)[-1])


def replace_source_documents(source_id: str, docs: Sequence[DocumentOut]) -> int:
    """Replace everything cached for one source with `docs`, atomically.

    An M3U playlist is a single HTTP response describing its *entire*
    contents, so a refresh is a snapshot swap rather than the incremental
    add upsert_documents does — an entry the provider dropped has to
    actually disappear, and there is no equivalent of Telegram's message-id
    cursor to scan forward from.

    Delete and insert share one transaction: if the insert fails the
    previous snapshot is still there, which matters because the fetch that
    produced `docs` came off the network and may well have been truncated.
    """
    rows = [
        (
            source_id,
            d.id,
            d.name,
            d.name.lower(),
            _stream_ext(d),
            d.size,
            d.date,
            d.mime_type,
            d.sourceType,
            d.url,
            d.logo,
            d.group,
        )
        for d in docs
    ]
    with _lock:
        _conn.execute("BEGIN")
        try:
            _conn.execute("DELETE FROM documents WHERE channel_id = ?", (source_id,))
            _conn.executemany(
                "INSERT INTO documents"
                "(channel_id, msg_id, name, name_lower, ext, size, date, mime_type,"
                " source_type, url, logo, group_title)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                rows,
            )
            # max_id is meaningless for a snapshot source, but the column is
            # NOT NULL and has_source() keys off the row existing at all.
            _conn.execute(
                "INSERT INTO channels_meta(channel_id, fetched_at, max_id) VALUES(?,?,0)"
                " ON CONFLICT(channel_id) DO UPDATE SET fetched_at=excluded.fetched_at",
                (source_id, time.time()),
            )
            _conn.execute("COMMIT")
        except Exception:
            _conn.execute("ROLLBACK")
            raise
    return len(rows)


def _due_sql(
    scope: Optional[Sequence[SourceScope]],
    checked_before: Optional[float],
    backoff_after: int,
    backoff_max_days: int,
) -> Tuple[str, list]:
    """Which stream URLs are due for a probe.

    Carries a backoff so a URL that has been dead for a week isn't probed
    every single night forever: past `backoff_after` consecutive failures
    each further failure buys another day of quiet, capped so it always
    recovers on its own once the provider comes back. The first failures
    are deliberately exempt — a URL has to be re-probed the next night to
    reach the second strike that condemns it at all.
    """
    where = "d.url IS NOT NULL"
    params: list = []
    if scope is not None:
        scope_sql, scope_params = _scope_sql(scope)
        where += f" AND {scope_sql}"
        params += list(scope_params)
    if checked_before is not None:
        where += (
            " AND (h.checked_at IS NULL OR h.checked_at <"
            "      ? - MAX(0, MIN(COALESCE(h.fail_streak, 0) - ?, ?)) * 86400.0)"
        )
        params += [checked_before, backoff_after, backoff_max_days]
    return where, params


def urls_needing_check(
    scope: Optional[Sequence[SourceScope]] = None,
    checked_before: Optional[float] = None,
    limit: int = 50000,
    backoff_after: int = 2,
    backoff_max_days: int = 6,
) -> List[Tuple[str, int]]:
    """The stream URLs a sweep should probe, as (url, current_fail_streak).

    DISTINCT because the same URL appears across playlists and is worth
    exactly one probe. Ordered unchecked-first, then least-recently-checked,
    which is what lets a budgeted sweep stop early and still work its way
    round everything over a few nights instead of re-probing the same head
    of the list forever.
    """
    where, params = _due_sql(scope, checked_before, backoff_after, backoff_max_days)
    rows = _read_conn().execute(
        f"SELECT DISTINCT d.url, COALESCE(h.fail_streak, 0), h.checked_at"
        f" FROM {_JOIN_HEALTH} WHERE {where}"
        " ORDER BY h.checked_at IS NOT NULL, h.checked_at LIMIT ?",
        params + [limit],
    ).fetchall()
    return [(r[0], r[1]) for r in rows]


def count_urls_needing_check(
    scope: Optional[Sequence[SourceScope]] = None,
    checked_before: Optional[float] = None,
    backoff_after: int = 2,
    backoff_max_days: int = 6,
) -> int:
    """How many distinct URLs a sweep would probe right now — for the size
    estimate the UI shows before asking the user to confirm one. Counts in
    SQL rather than measuring the list urls_needing_check would build,
    because this is polled by a settings page."""
    where, params = _due_sql(scope, checked_before, backoff_after, backoff_max_days)
    return _read_conn().execute(
        f"SELECT COUNT(DISTINCT d.url) FROM {_JOIN_HEALTH} WHERE {where}", params
    ).fetchone()[0]


def record_stream_health(rows: Sequence[tuple]) -> None:
    """Bulk-write probe results: (url, status, http_code, latency_ms,
    fail_streak, error).

    The streak is computed by the caller from what urls_needing_check
    handed it, rather than read back per row here — a sweep writes
    thousands of these and a read-modify-write each would hold the shared
    connection lock for the whole night.
    """
    if not rows:
        return
    now = time.time()
    with _lock:
        _conn.execute("BEGIN")
        try:
            _conn.executemany(
                "INSERT INTO stream_health"
                "(url, status, http_code, latency_ms, checked_at, fail_streak, error)"
                " VALUES(?,?,?,?,?,?,?)"
                " ON CONFLICT(url) DO UPDATE SET"
                "  status=excluded.status, http_code=excluded.http_code,"
                "  latency_ms=excluded.latency_ms, checked_at=excluded.checked_at,"
                "  fail_streak=excluded.fail_streak, error=excluded.error",
                [(u, st, code, ms, now, streak, err) for u, st, code, ms, streak, err in rows],
            )
            _conn.execute("COMMIT")
        except Exception:
            _conn.execute("ROLLBACK")
            raise


def prune_stream_health() -> int:
    """Drop health rows for URLs no playlist lists any more.

    A snapshot swap silently orphans every entry the provider dropped, and
    without this the table would only ever grow — it keys on the URL, so it
    has no idea a playlist stopped mentioning one.
    """
    with _lock:
        cur = _conn.execute(
            "DELETE FROM stream_health WHERE NOT EXISTS"
            " (SELECT 1 FROM documents d WHERE d.url = stream_health.url)"
        )
        return cur.rowcount


def get_setting(key: str) -> Optional[str]:
    row = _read_conn().execute("SELECT value FROM schema_meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def set_setting(key: str, value: str) -> None:
    """Small derived bookkeeping that belongs with the cache rather than in
    config/ — currently just when the last stream sweep finished. Losing it
    costs one extra sweep, which is why it lives in the rebuildable
    database and not in user data."""
    with _lock:
        _conn.execute(
            "INSERT INTO schema_meta(key, value) VALUES(?,?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def record_fetch(source_id: str, status: str, error: Optional[str] = None) -> int:
    """Record how an attempt to fetch a source went, returning the resulting
    consecutive-failure streak.

    Tracked separately from `fetched_at`, which only moves when documents
    are actually written: a source whose URL is dead never updates that, so
    without a `last_attempt_at` of its own the refresh scheduler would see
    it as permanently overdue and retry it every single tick.

    The streak is what stops one bad night from condemning a playlist — a
    single failure reads as a blip, a run of them as genuinely broken, and
    it also drives the retry backoff in refresh.py.
    """
    now = time.time()
    with _lock:
        if status == FETCH_OK:
            _conn.execute(
                "INSERT INTO source_health"
                "(source_id, status, error, last_attempt_at, last_ok_at, fail_streak)"
                " VALUES(?,?,NULL,?,?,0)"
                " ON CONFLICT(source_id) DO UPDATE SET"
                "  status=excluded.status, error=NULL,"
                "  last_attempt_at=excluded.last_attempt_at,"
                "  last_ok_at=excluded.last_ok_at, fail_streak=0",
                (source_id, FETCH_OK, now, now),
            )
            return 0
        _conn.execute(
            "INSERT INTO source_health"
            "(source_id, status, error, last_attempt_at, last_ok_at, fail_streak)"
            " VALUES(?,?,?,?,NULL,1)"
            " ON CONFLICT(source_id) DO UPDATE SET"
            "  status=excluded.status, error=excluded.error,"
            "  last_attempt_at=excluded.last_attempt_at,"
            "  fail_streak=source_health.fail_streak + 1",
            (source_id, status, error, now),
        )
        row = _conn.execute(
            "SELECT fail_streak FROM source_health WHERE source_id = ?", (source_id,)
        ).fetchone()
    return row[0] if row else 1


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
            _conn.execute("DELETE FROM source_health WHERE source_id = ?", (channel_id,))
            _conn.execute("COMMIT")
        except Exception:
            _conn.execute("ROLLBACK")
            raise
