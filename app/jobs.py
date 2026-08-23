"""In-memory tracker for background source scans, plus the derived
per-source state the UI renders from it.

Lives outside the routers because both the source list endpoints and the
collection document endpoint report a source's status and file count, and
they must never disagree about what a source is doing right now.

Everything here works structurally on `.id` / `.name` /
`.allowedExtensions`, so a Telegram channel and an M3U playlist are both
just a "source" — the one place the difference shows is the `not_joined`
status, which only a channel can be in.

Jobs are deliberately not persisted — like the scans they describe, they're
only meaningful for the life of this process.
"""
import time
import uuid
from typing import Callable, Dict, List, Optional, Protocol, Sequence

from . import cache
from .models import M3U, TELEGRAM, Channel, ChannelOut, Playlist, PlaylistOut, SourceType

_jobs: Dict[str, dict] = {}
_MAX_JOBS = 50

# Job kinds: a source's first pass over its contents vs. a manual full
# re-scan of one that was already cached. The UI words them differently.
SCAN = "scan"
REBUILD = "rebuild"
# Checking stream URLs, which is not a scan of a source at all — it is
# always recorded against a synthetic id (see health_source), never a real
# playlist's, so it can't collide with that playlist's own scan state.
HEALTH = "health"

# Distinguishes "caller didn't pass a count" from a count of None, which is
# itself meaningful (source never scanned).
_UNSET = object()

# Consecutive failed fetches before a source's pill turns. One failure is a
# blip — a home connection hiccup, a provider restarting — and flagging it
# immediately would cry wolf often enough that a real outage stops standing
# out. Deterministic failures (a body that isn't a playlist, a refused
# snapshot swap) don't wait: repeating them proves nothing.
_STALE_AFTER = 2


class Source(Protocol):
    """The shape this module needs from a Channel or a Playlist."""

    id: str
    name: str
    allowedExtensions: Sequence[str]


def record(source: Source, kind: str, source_type: SourceType = TELEGRAM) -> str:
    job_id = uuid.uuid4().hex
    _jobs[job_id] = {
        "id": job_id,
        "sourceId": source.id,
        "sourceName": source.name,
        "sourceType": source_type,
        "kind": kind,
        "status": "running",
        "scanned": 0,
        "total": None,
        "startedAt": time.time(),
        "finishedAt": None,
        "error": None,
    }
    if len(_jobs) > _MAX_JOBS:
        oldest = sorted(_jobs.values(), key=lambda j: j["startedAt"])[0]
        del _jobs[oldest["id"]]
    return job_id


def progress_cb(job_id: str) -> Callable:
    """Callback handed to the scanner so it can report progress as it goes."""

    def report(scanned: int, total: Optional[int]) -> None:
        job = _jobs.get(job_id)
        if job:
            job["scanned"] = scanned
            if total is not None:
                job["total"] = total

    return report


def finish(job_id: str, status: str, error: Optional[str] = None) -> None:
    job = _jobs.get(job_id)
    if job:
        job["status"] = status
        job["error"] = error
        job["finishedAt"] = time.time()


def all_jobs() -> List[dict]:
    return sorted(_jobs.values(), key=lambda j: j["startedAt"], reverse=True)


def for_source(source_id: str) -> List[dict]:
    return [j for j in _jobs.values() if j["sourceId"] == source_id]


class _SyntheticSource:
    """A stand-in Source for work that isn't about one stored source.

    jobs.record only needs id/name/allowedExtensions, and a stream check
    spans every playlist at once. Giving it an id of its own — rather than
    borrowing a real playlist's — is what keeps it out of that playlist's
    status pill and out of the UI's jobsBySource map, while still reaching
    the notification bell like any other job.
    """

    allowedExtensions = ()

    def __init__(self, id: str, name: str):
        self.id = id
        self.name = name


def health_source(playlist_name: Optional[str] = None) -> _SyntheticSource:
    return _SyntheticSource(
        f"stream-health:{playlist_name}" if playlist_name else "stream-health",
        f"Streams in {playlist_name}" if playlist_name else "All streams",
    )


def _count_for(source: Source) -> Optional[int]:
    return cache.source_counts([(source.id, source.allowedExtensions)]).get(source.id)


def source_status(
    source: Source,
    source_type: SourceType = TELEGRAM,
    count: Optional[int] = _UNSET,
    health: Optional[dict] = _UNSET,
) -> str:
    """Single source of truth for the status pill. `count` lets a caller
    that already queried this source's document count pass it in rather
    than have it recomputed. None means the source has never been
    scanned, which reads differently from a scanned-but-empty one.

    `health` is the persisted record of the last fetch (cache.record_fetch),
    and is what stops a playlist whose URL died weeks ago from still
    reporting "ready" off the snapshot it managed to take before it broke.
    A cached count alone cannot tell the difference between fresh and
    abandoned.
    """
    # Only a Telegram channel can be un-joined; a playlist is just a URL.
    if source_type == TELEGRAM and not getattr(source, "joined", True):
        return "not_joined"
    running = [
        j for j in for_source(source.id) if j["status"] == "running" and j["kind"] != HEALTH
    ]
    if running:
        latest = max(running, key=lambda j: j["startedAt"])
        return "rebuilding" if latest["kind"] == REBUILD else "scanning"
    if count is _UNSET:
        count = _count_for(source)
    if health is _UNSET:
        # Only fetched-by-URL sources ever have a health row — a Telegram
        # channel's liveness is a Telethon error, not an HTTP one — so the
        # channel list doesn't pay a lookup per channel for a guaranteed miss.
        health = None if source_type == TELEGRAM else cache.get_source_health(source.id)

    # A live problem with the source itself outranks whatever is cached:
    # what's cached is exactly what's in question.
    if health and health["status"] != cache.FETCH_OK:
        if health["status"] == cache.FETCH_INVALID:
            return "invalid"
        if health["status"] == cache.FETCH_SHRUNK:
            return "needs_review"
        if health["failStreak"] >= _STALE_AFTER:
            # Still browsable if something was cached before it broke, so
            # "stale" rather than "error" — the entries are real, just
            # possibly out of date.
            return "stale" if count else "error"

    if count is None:
        # Never scanned — or a scan wiped the cache and then died.
        return "error" if any(j["status"] == "error" for j in for_source(source.id)) else "unscanned"
    if not count:
        return "empty"
    return "ready"


def to_out(channel: Channel, count: Optional[int] = _UNSET) -> ChannelOut:
    """`count` is the channel's document count under its own extension
    allowlist. Callers rendering several channels at once should fetch
    them together via cache.source_counts and pass them in, rather than
    paying one query per channel."""
    if count is _UNSET:
        count = _count_for(channel)
    return ChannelOut(
        **channel.model_dump(),
        fileCount=count or 0,
        status=source_status(channel, TELEGRAM, count),
    )


def to_source_out(source: Source, source_type: SourceType, count: Optional[int] = _UNSET):
    """Dispatch to the right response shape for a source of unknown type —
    for the endpoints (a collection's contents, the job list) that handle
    whichever kind the collection happens to be bound to.

    Health is left to to_playlist_out to look up: this is the
    one-source-at-a-time path, where batching would buy nothing.
    """
    return to_out(source, count) if source_type == TELEGRAM else to_playlist_out(source, count)


def to_playlist_out(
    playlist: Playlist, count: Optional[int] = _UNSET, health: Optional[dict] = _UNSET
) -> PlaylistOut:
    """The playlist counterpart of to_out — same batching advice applies, to
    `health` as much as to `count`: fetch both for a whole list at once with
    cache.source_counts and cache.source_health_many."""
    if count is _UNSET:
        count = _count_for(playlist)
    if health is _UNSET:
        health = cache.get_source_health(playlist.id)
    return PlaylistOut(
        **playlist.model_dump(),
        fileCount=count or 0,
        status=source_status(playlist, M3U, count, health),
        fetchStatus=(health or {}).get("status"),
        fetchError=(health or {}).get("error"),
        lastOkAt=(health or {}).get("lastOkAt"),
        failStreak=(health or {}).get("failStreak") or 0,
    )
