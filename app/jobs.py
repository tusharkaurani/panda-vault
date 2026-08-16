"""In-memory tracker for background channel scans, plus the derived
per-channel state the UI renders from it.

Lives outside the routers because both /api/channels and the collection
document endpoint report a channel's status and file count, and they must
never disagree about what a channel is doing right now.

Jobs are deliberately not persisted — like the scans they describe, they're
only meaningful for the life of this process.
"""
import time
import uuid
from typing import Callable, Dict, List, Optional

from . import cache
from .models import Channel, ChannelOut

_jobs: Dict[str, dict] = {}
_MAX_JOBS = 50

# Job kinds: a channel's first pass over its history vs. a manual full
# re-scan of one that was already cached. The UI words them differently.
SCAN = "scan"
REBUILD = "rebuild"

# Distinguishes "caller didn't pass a count" from a count of None, which is
# itself meaningful (channel never scanned).
_UNSET = object()


def record(channel: Channel, kind: str) -> str:
    job_id = uuid.uuid4().hex
    _jobs[job_id] = {
        "id": job_id,
        "channelId": channel.id,
        "channelName": channel.name,
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


def for_channel(channel_id: str) -> List[dict]:
    return [j for j in _jobs.values() if j["channelId"] == channel_id]


def _count_for(channel: Channel) -> Optional[int]:
    return cache.channel_counts([(channel.id, channel.allowedExtensions)]).get(channel.id)


def channel_status(channel: Channel, count: Optional[int] = _UNSET) -> str:
    """Single source of truth for the status pill. `count` lets a caller
    that already queried this channel's document count pass it in rather
    than have it recomputed. None means the channel has never been
    scanned, which reads differently from a scanned-but-empty one."""
    if not channel.joined:
        return "not_joined"
    running = [j for j in for_channel(channel.id) if j["status"] == "running"]
    if running:
        latest = max(running, key=lambda j: j["startedAt"])
        return "rebuilding" if latest["kind"] == REBUILD else "scanning"
    if count is _UNSET:
        count = _count_for(channel)
    if count is None:
        # Never scanned — or a scan wiped the cache and then died.
        return "error" if any(j["status"] == "error" for j in for_channel(channel.id)) else "unscanned"
    if not count:
        return "empty"
    return "ready"


def to_out(channel: Channel, count: Optional[int] = _UNSET) -> ChannelOut:
    """`count` is the channel's document count under its own extension
    allowlist. Callers rendering several channels at once should fetch
    them together via cache.channel_counts and pass them in, rather than
    paying one query per channel."""
    if count is _UNSET:
        count = _count_for(channel)
    return ChannelOut(
        **channel.model_dump(),
        fileCount=count or 0,
        status=channel_status(channel, count),
    )
