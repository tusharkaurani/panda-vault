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

# Distinguishes "caller didn't pass a count" from a count of None, which is
# itself meaningful (source never scanned).
_UNSET = object()


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


def _count_for(source: Source) -> Optional[int]:
    return cache.source_counts([(source.id, source.allowedExtensions)]).get(source.id)


def source_status(
    source: Source, source_type: SourceType = TELEGRAM, count: Optional[int] = _UNSET
) -> str:
    """Single source of truth for the status pill. `count` lets a caller
    that already queried this source's document count pass it in rather
    than have it recomputed. None means the source has never been
    scanned, which reads differently from a scanned-but-empty one."""
    # Only a Telegram channel can be un-joined; a playlist is just a URL.
    if source_type == TELEGRAM and not getattr(source, "joined", True):
        return "not_joined"
    running = [j for j in for_source(source.id) if j["status"] == "running"]
    if running:
        latest = max(running, key=lambda j: j["startedAt"])
        return "rebuilding" if latest["kind"] == REBUILD else "scanning"
    if count is _UNSET:
        count = _count_for(source)
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
    whichever kind the collection happens to be bound to."""
    return to_out(source, count) if source_type == TELEGRAM else to_playlist_out(source, count)


def to_playlist_out(playlist: Playlist, count: Optional[int] = _UNSET) -> PlaylistOut:
    """The playlist counterpart of to_out — same batching advice applies."""
    if count is _UNSET:
        count = _count_for(playlist)
    return PlaylistOut(
        **playlist.model_dump(),
        fileCount=count or 0,
        status=source_status(playlist, M3U, count),
    )
