import asyncio
import logging
import time
from typing import List, Set

from fastapi import APIRouter, HTTPException

from .. import cache, jobs, store
from ..models import Channel, ChannelIn, ChannelOut, ChannelUpdate
from ..telegram_client import join_channel, resolve_and_check, sync_channel

router = APIRouter(prefix="/api/channels", tags=["channels"])
log = logging.getLogger("panda_vault.channels")

# asyncio only holds a *weak* reference to a running task, so a fire-and
# -forget create_task() whose result nobody keeps can be garbage collected
# mid-scan — the scan would then vanish silently, leaving its job stuck on
# "running" forever and the UI waiting for a completion that never comes.
_background_tasks: Set[asyncio.Task] = set()


def _spawn(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


async def _warm_cache(job_id: str, channel: Channel) -> None:
    """Kick off the (potentially slow, full-history) document scan in the
    background so a newly added/rebound/joined channel doesn't sit
    uncached until the next 30-min refresh cycle or a user happens to
    open it. Tracked as a job like a rebuild is, so the UI can show scan
    progress for a channel that was just added."""
    started = time.time()
    log.info("Scan started for channel %s (%s), job %s", channel.name, channel.id, job_id)
    try:
        count = await sync_channel(channel.id, channel.channel, on_progress=jobs.progress_cb(job_id))
    except asyncio.CancelledError:
        log.warning("Cache warm-up cancelled for channel %s", channel.id)
        jobs.finish(job_id, "error", "Scan was interrupted — the server restarted or the scan was cancelled")
        raise
    except Exception as e:
        log.warning("Cache warm-up failed for channel %s: %s", channel.id, e)
        jobs.finish(job_id, "error", str(e))
        return
    # The channel may have been deleted while this scan was in flight —
    # sync_channel doesn't know that and writes the cache anyway, so
    # check afterward and clean up the now-orphaned entry.
    if not any(c.id == channel.id for c in store.load_channels()):
        cache.invalidate(channel.id)
    log.info(
        "Scan finished for channel %s: %d file(s) in %.1fs", channel.name, count, time.time() - started
    )
    jobs.finish(job_id, "done")


async def _rebuild_cache(job_id: str, channel: Channel) -> None:
    """Manual "Rebuild" trigger: discards whatever's cached for this
    channel and re-scans its entire message history from scratch. Unlike
    the incremental min_id-based refresh used everywhere else, this is
    for recovering from a corrupted/stale cache or picking up messages
    that were deleted-and-reposted with lower IDs than the last scan."""
    started = time.time()
    log.info("Rescan started for channel %s (%s), job %s", channel.name, channel.id, job_id)
    try:
        count = await sync_channel(
            channel.id, channel.channel, full_rebuild=True, on_progress=jobs.progress_cb(job_id)
        )
    except asyncio.CancelledError:
        # Server shutting down (or the task was cancelled) mid-scan. Without
        # this the job would stay "running" forever, since CancelledError is
        # a BaseException and slips past `except Exception`.
        log.warning("Cache rescan cancelled for channel %s", channel.id)
        jobs.finish(job_id, "error", "Rescan was interrupted — the server restarted or the scan was cancelled")
        raise
    except Exception as e:
        log.warning("Cache rescan failed for channel %s: %s", channel.id, e)
        jobs.finish(job_id, "error", str(e))
        return
    if not any(c.id == channel.id for c in store.load_channels()):
        cache.invalidate(channel.id)
    log.info(
        "Rescan finished for channel %s: %d file(s) in %.1fs",
        channel.name,
        count,
        time.time() - started,
    )
    jobs.finish(job_id, "done")


def _collections_using_channel(collections, channel_id: str):
    found = []

    def walk(nodes):
        for n in nodes:
            if channel_id in n.channelIds:
                found.append(n)
            if n.children:
                walk(n.children)

    walk(collections)
    return found


@router.get("", response_model=List[ChannelOut])
def list_channels():
    channels = store.load_channels()
    # One grouped count for every channel rather than a query each.
    counts = cache.channel_counts([(c.id, c.allowedExtensions) for c in channels])
    return [jobs.to_out(c, counts.get(c.id)) for c in channels]


@router.post("", response_model=Channel, status_code=201)
async def create_channel(body: ChannelIn):
    channels = store.load_channels()
    channel = Channel(name=body.name, description=body.description, channel=body.channel)
    channel.joined = await resolve_and_check(channel.channel)
    channels.append(channel)
    store.save_channels(channels)
    if channel.joined:
        _spawn(_warm_cache(jobs.record(channel, jobs.SCAN), channel))
    return channel


@router.put("/{channel_id}", response_model=Channel)
async def update_channel(channel_id: str, body: ChannelUpdate):
    channels = store.load_channels()
    for i, c in enumerate(channels):
        if c.id == channel_id:
            data = c.model_dump()
            data.update(body.model_dump(exclude_unset=True))
            updated = Channel(**data)
            channel_ref_changed = body.channel is not None and body.channel != c.channel
            if body.channel is not None:
                updated.joined = await resolve_and_check(updated.channel)
            channels[i] = updated
            store.save_channels(channels)
            if channel_ref_changed:
                # The cache is keyed by channel_id, not the underlying chat
                # ref — if the ref changed, stale documents from the old
                # chat would otherwise keep being served.
                cache.invalidate(updated.id)
                if updated.joined:
                    _spawn(_warm_cache(jobs.record(updated, jobs.SCAN), updated))
            return updated
    raise HTTPException(404, "Channel not found")


@router.delete("/{channel_id}", status_code=204)
def delete_channel(channel_id: str, force: bool = False):
    channels = store.load_channels()
    if not any(c.id == channel_id for c in channels):
        raise HTTPException(404, "Channel not found")

    collections = store.load_collections()
    used_by = _collections_using_channel(collections, channel_id)
    if used_by and not force:
        names = ", ".join(f.name for f in used_by)
        raise HTTPException(
            409,
            f"Channel is used by {len(used_by)} collection(s): {names}. Retry with force=true to unlink them.",
        )
    if used_by:
        def unlink(nodes):
            for n in nodes:
                if channel_id in n.channelIds:
                    n.channelIds = [c for c in n.channelIds if c != channel_id]
                if n.children:
                    unlink(n.children)

        unlink(collections)
        store.save_collections(collections)

    store.save_channels([c for c in channels if c.id != channel_id])
    cache.invalidate(channel_id)
    return None


@router.post("/{channel_id}/join")
async def join(channel_id: str):
    channels = store.load_channels()
    for i, c in enumerate(channels):
        if c.id == channel_id:
            ok, msg = await join_channel(c.channel)
            c.joined = ok
            channels[i] = c
            store.save_channels(channels)
            if not ok:
                raise HTTPException(400, msg)
            _spawn(_warm_cache(jobs.record(c, jobs.SCAN), c))
            return {"joined": True}
    raise HTTPException(404, "Channel not found")


@router.post("/{channel_id}/rebuild", status_code=202)
async def rebuild_channel(channel_id: str):
    channels = store.load_channels()
    for c in channels:
        if c.id == channel_id:
            # Clear immediately so callers (e.g. collection card counts)
            # stop showing stale data right away instead of waiting for
            # the background scan to finish.
            cache.invalidate(channel_id)
            job_id = jobs.record(c, jobs.REBUILD)
            _spawn(_rebuild_cache(job_id, c))
            return {"rebuilding": True, "jobId": job_id}
    raise HTTPException(404, "Channel not found")


@router.get("/rebuild-jobs")
def rebuild_jobs():
    return {"jobs": jobs.all_jobs()}


@router.get("/{channel_id}/status")
async def status(channel_id: str):
    channels = store.load_channels()
    for i, c in enumerate(channels):
        if c.id == channel_id:
            ok = await resolve_and_check(c.channel)
            if ok != c.joined:
                c.joined = ok
                channels[i] = c
                store.save_channels(channels)
            return {"joined": ok}
    raise HTTPException(404, "Channel not found")
