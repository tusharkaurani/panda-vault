"""M3U playlist fetching, parsing and cache sync.

The m3u source type's counterpart to telegram_client: it owns everything
about turning one remote playlist URL into rows in the document cache.

The shape of the problem is the opposite of Telegram's. A channel is an
append-only history that can be scanned incrementally from a message-id
cursor, and deletions have to be *detected*. A playlist is a single HTTP
response describing its entire contents right now — so there is no cursor,
no incremental mode, and a refresh is a snapshot swap
(cache.replace_source_documents) in which entries the provider dropped
simply stop existing.
"""
import asyncio
import logging
import mimetypes
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable, Dict, Iterator, List, Optional

from . import cache
from .models import M3U, DocumentOut

log = logging.getLogger("panda_vault.m3u")

# Playlists are text, but a provider handing back something enormous (or a
# URL that isn't a playlist at all) shouldn't be able to exhaust memory.
# 64MB is far past any real playlist — iptv-org's full index is ~10MB.
MAX_BYTES = int(os.environ.get("M3U_MAX_BYTES", str(64 * 1024 * 1024)))
TIMEOUT_SECONDS = int(os.environ.get("M3U_TIMEOUT_SECONDS", "30"))

# Providers routinely reject unfamiliar clients, and every real M3U consumer
# identifies as VLC — a plain urllib UA gets a 403 from a large fraction of
# them. Overridable for the ones that want something else.
USER_AGENT = os.environ.get("M3U_USER_AGENT", "VLC/3.0.20 LibVLC/3.0.20")

_PROGRESS_EVERY = 500  # entries between progress callbacks while parsing

# Attribute pairs inside an #EXTINF line: tvg-name="…" group-title="…" etc.
_ATTR = re.compile(r'([\w-]+)\s*=\s*"([^"]*)"')

# Extensions a stream URL commonly ends in, where mimetypes doesn't know or
# guesses wrong. Everything else falls through to the stdlib.
_MIME_BY_EXT = {
    "m3u8": "application/vnd.apple.mpegurl",
    "m3u": "application/vnd.apple.mpegurl",
    "ts": "video/mp2t",
    "mpd": "application/dash+xml",
}

_playlist_locks: Dict[str, asyncio.Lock] = {}


def _lock_for(playlist_id: str) -> asyncio.Lock:
    lock = _playlist_locks.get(playlist_id)
    if lock is None:
        lock = asyncio.Lock()
        _playlist_locks[playlist_id] = lock
    return lock


@dataclass
class Entry:
    """One playable line of a playlist, after its directives are resolved."""

    name: str
    url: str
    logo: Optional[str] = None
    group: Optional[str] = None


# --------------------------------------------------------------------------
# parsing
# --------------------------------------------------------------------------


def _split_extinf(rest: str) -> tuple:
    """Split the body of an #EXTINF line into (attributes, display title).

    The separator is the first comma *outside* a quoted attribute value —
    naively splitting on the first comma corrupts the very common
    `group-title="News, Sport"`, and splitting on the last one swallows any
    comma in the title itself.
    """
    in_quotes = False
    for i, ch in enumerate(rest):
        if ch == '"':
            in_quotes = not in_quotes
        elif ch == "," and not in_quotes:
            return rest[:i], rest[i + 1 :]
    # No comma at all: a malformed directive. Treat the whole thing as
    # attributes and let the URL line supply the name, rather than dropping
    # the entry that follows.
    return rest, ""


def _name_from_url(url: str) -> str:
    path = urllib.parse.urlsplit(url).path
    return path.rsplit("/", 1)[-1] or url


def parse(text: str) -> Iterator[Entry]:
    """Yield one Entry per playable line.

    Deliberately a line scanner rather than one big regex over the file:
    playlists reach hundreds of thousands of lines, directives carry state
    forward to the URL line that follows them, and a single malformed line
    must not take the rest of the file with it.
    """
    name: Optional[str] = None
    attrs: Dict[str, str] = {}
    # #EXTGRP is a *sticky* "current group" directive, not a per-entry one:
    # it applies to every following entry until another #EXTGRP changes it.
    # Writers place it both before a block of entries and between a single
    # #EXTINF and its URL, and carrying it forward handles both. A per-entry
    # group-title attribute still wins over it.
    group: Optional[str] = None

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue

        if line.startswith("#"):
            upper = line.upper()
            if upper.startswith("#EXTINF:"):
                attr_blob, title = _split_extinf(line[8:])
                attrs = {k.lower(): v for k, v in _ATTR.findall(attr_blob)}
                name = title.strip()
            elif upper.startswith("#EXTGRP:"):
                group = line[8:].strip() or None
            # Everything else is metadata for a player, not for us:
            # #EXTM3U, #EXTVLCOPT, #KODIPROP, #EXT-X-*, plain comments.
            continue

        # Any non-directive line is the URL the preceding directives describe.
        display = attrs.get("tvg-name") or name or ""
        yield Entry(
            name=display.strip() or _name_from_url(line),
            url=line,
            logo=(attrs.get("tvg-logo") or "").strip() or None,
            group=(attrs.get("group-title") or group or "").strip() or None,
        )
        name, attrs = None, {}  # `group` deliberately persists — see above


def _mime_for(url: str) -> Optional[str]:
    path = urllib.parse.urlsplit(url).path
    ext = path.rsplit(".", 1)[-1].lower() if "." in path.rsplit("/", 1)[-1] else ""
    if ext in _MIME_BY_EXT:
        return _MIME_BY_EXT[ext]
    return mimetypes.guess_type(path)[0]


# --------------------------------------------------------------------------
# fetching
# --------------------------------------------------------------------------


def fetch(url: str) -> str:
    """Download a playlist. Blocking — call it off the event loop."""
    scheme = urllib.parse.urlsplit(url).scheme.lower()
    if scheme not in ("http", "https"):
        # Without this, a file:// or ftp:// URL would let anyone who can add
        # a playlist read files off the server through the entry list.
        raise RuntimeError(f"Only http and https playlist URLs are supported (got {scheme or 'none'!r})")

    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            # One byte past the cap, so an oversized body is detected rather
            # than silently truncated into a half-parsed playlist.
            raw = response.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Playlist fetch failed — HTTP {e.code} {e.reason}") from e
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f"Could not reach the playlist URL: {getattr(e, 'reason', e)}") from e

    if len(raw) > MAX_BYTES:
        raise RuntimeError(f"Playlist is larger than {MAX_BYTES // (1024 * 1024)}MB — refusing to load it")
    # Providers are inconsistent about encoding and a stray byte shouldn't
    # cost the whole playlist, so replace rather than raise.
    return raw.decode("utf-8", errors="replace")


# --------------------------------------------------------------------------
# sync
# --------------------------------------------------------------------------


def _to_documents(entries: Iterator[Entry], on_progress: Optional[Callable]) -> List[DocumentOut]:
    stamp = time.strftime("%Y-%m-%d %H:%M")
    docs: List[DocumentOut] = []
    for entry in entries:
        docs.append(
            DocumentOut(
                # The ordinal within this snapshot. Safe as the unique key
                # because replace_source_documents swaps the whole partition,
                # so ordinals from two snapshots never coexist.
                id=len(docs) + 1,
                name=entry.name,
                # A stream has no length to report, and `size` is NOT NULL.
                size=0,
                # When we last saw it. Keeps date sorts total and meaningful,
                # and the (channel_id, msg_id) tiebreaker then falls back to
                # playlist order — which is what a viewer expects.
                date=stamp,
                mime_type=_mime_for(entry.url),
                sourceId=None,  # set by the cache layer; it's the partition key
                sourceType=M3U,
                url=entry.url,
                logo=entry.logo,
                group=entry.group,
            )
        )
        if on_progress and len(docs) % _PROGRESS_EVERY == 0:
            on_progress(len(docs), None)
    if on_progress:
        on_progress(len(docs), len(docs))
    return docs


def _sync_blocking(playlist_id: str, url: str, on_progress: Optional[Callable]) -> int:
    text = fetch(url)
    docs = _to_documents(parse(text), on_progress)
    return cache.replace_source_documents(playlist_id, docs)


async def sync_playlist(
    playlist_id: str,
    url: str,
    force_refresh: bool = False,
    on_progress: Optional[Callable] = None,
) -> int:
    """Bring a playlist's cached entries up to date, returning how many it
    holds afterwards.

    Mirrors telegram_client.sync_channel's contract — a count, never the
    entries themselves, so the routers never hold more than the page they
    are about to serve.

    There is no full_rebuild counterpart: every sync is already a full
    rebuild, because a playlist has no incremental mode to rebuild *from*.
    """
    if not force_refresh and cache.has_source(playlist_id):
        return cache.count_documents(playlist_id)

    # Same double-checked locking as sync_channel: a background refresh and
    # a user hitting Rescan must not both fetch the same playlist.
    async with _lock_for(playlist_id):
        if not force_refresh and cache.has_source(playlist_id):
            return cache.count_documents(playlist_id)
        # Fetch, parse and the bulk insert are all blocking, and a large
        # playlist is hundreds of thousands of lines — this would stall the
        # event loop for everyone else.
        count = await asyncio.to_thread(_sync_blocking, playlist_id, url, on_progress)
        log.info("Playlist %s synced: %d entr%s", playlist_id, count, "y" if count == 1 else "ies")
        return count
