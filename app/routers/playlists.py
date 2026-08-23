"""CRUD for M3U playlists — the m3u source type's counterpart to channels.py.

Deliberately parallel to that module, including its background-task
pattern, so the two read the same way. The differences are all consequences
of a playlist being a snapshot rather than a history: there is nothing to
join, no incremental scan, and "rescan" is the only sync there is.
"""
import asyncio
import logging
import time
from typing import List, Set
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException

from .. import cache, jobs, m3u, store
from ..models import M3U, Playlist, PlaylistIn, PlaylistOut, PlaylistUpdate

router = APIRouter(prefix="/api/playlists", tags=["playlists"])
log = logging.getLogger("panda_vault.playlists")

# asyncio only holds a *weak* reference to a running task, so a fire-and
# -forget create_task() whose result nobody keeps can be garbage collected
# mid-scan — the scan would then vanish silently, leaving its job stuck on
# "running" forever and the UI waiting for a completion that never comes.
_background_tasks: Set[asyncio.Task] = set()


def _spawn(coro) -> asyncio.Task:
    """Callers must be `async def` routes — create_task needs a running loop
    in the calling thread, and a sync `def` route runs in the threadpool
    where there isn't one."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


def _validate_url(url: str) -> str:
    url = url.strip()
    scheme = urlsplit(url).scheme.lower()
    if scheme not in ("http", "https"):
        raise HTTPException(400, "Playlist URL must start with http:// or https://")
    return url


async def _scan(job_id: str, playlist: Playlist, kind: str) -> None:
    """Fetch and parse a playlist in the background.

    Runs on add and on rescan alike — unlike a channel there's no cheap
    incremental path to prefer, so both are the same work and differ only
    in how the UI words the job.
    """
    started = time.time()
    log.info("%s started for playlist %s (%s), job %s", kind.title(), playlist.name, playlist.id, job_id)
    try:
        count = await m3u.sync_playlist(
            playlist.id, playlist.url, force_refresh=True, on_progress=jobs.progress_cb(job_id)
        )
    except asyncio.CancelledError:
        # Server shutting down (or the task was cancelled) mid-scan. Without
        # this the job would stay "running" forever, since CancelledError is
        # a BaseException and slips past `except Exception`.
        log.warning("Playlist %s for %s cancelled", kind, playlist.id)
        jobs.finish(job_id, "error", f"{kind.title()} was interrupted — the server restarted or it was cancelled")
        raise
    except Exception as e:
        log.warning("Playlist %s failed for %s: %s", kind, playlist.id, e)
        jobs.finish(job_id, "error", str(e))
        return
    # The playlist may have been deleted while this was in flight —
    # sync_playlist doesn't know that and writes the cache anyway, so check
    # afterward and clean up the now-orphaned entries.
    if not any(p.id == playlist.id for p in store.load_playlists()):
        cache.invalidate(playlist.id)
    log.info(
        "%s finished for playlist %s: %d entr%s in %.1fs",
        kind.title(), playlist.name, count, "y" if count == 1 else "ies", time.time() - started,
    )
    jobs.finish(job_id, "done")


def _collections_using_playlist(collections, playlist_id: str):
    found = []

    def walk(nodes):
        for n in nodes:
            if n.sourceType == M3U and playlist_id in n.sourceIds:
                found.append(n)
            if n.children:
                walk(n.children)

    walk(collections)
    return found


@router.get("", response_model=List[PlaylistOut])
def list_playlists():
    playlists = store.load_playlists()
    # One grouped count for every playlist rather than a query each.
    counts = cache.source_counts([(p.id, p.allowedExtensions) for p in playlists])
    return [jobs.to_playlist_out(p, counts.get(p.id)) for p in playlists]


@router.post("", response_model=Playlist, status_code=201)
async def create_playlist(body: PlaylistIn):
    playlists = store.load_playlists()
    playlist = Playlist(
        name=body.name,
        description=body.description,
        url=_validate_url(body.url),
        allowedExtensions=body.allowedExtensions,
    )
    playlists.append(playlist)
    store.save_playlists(playlists)
    # Scanned immediately: a playlist is one HTTP request, so there's no
    # reason to make the user wait for the next refresh cycle to see it.
    _spawn(_scan(jobs.record(playlist, jobs.SCAN, M3U), playlist, "scan"))
    return playlist


@router.put("/{playlist_id}", response_model=Playlist)
async def update_playlist(playlist_id: str, body: PlaylistUpdate):
    playlists = store.load_playlists()
    for i, p in enumerate(playlists):
        if p.id != playlist_id:
            continue
        data = p.model_dump()
        data.update(body.model_dump(exclude_unset=True))
        if body.url is not None:
            data["url"] = _validate_url(body.url)
        updated = Playlist(**data)
        url_changed = updated.url != p.url
        playlists[i] = updated
        store.save_playlists(playlists)
        if url_changed:
            # The cache is keyed by playlist id, not by URL — without this,
            # entries from the old playlist would keep being served.
            cache.invalidate(updated.id)
            _spawn(_scan(jobs.record(updated, jobs.SCAN, M3U), updated, "scan"))
        return updated
    raise HTTPException(404, "Playlist not found")


@router.delete("/{playlist_id}", status_code=204)
def delete_playlist(playlist_id: str, force: bool = False):
    playlists = store.load_playlists()
    if not any(p.id == playlist_id for p in playlists):
        raise HTTPException(404, "Playlist not found")

    collections = store.load_collections()
    used_by = _collections_using_playlist(collections, playlist_id)
    if used_by and not force:
        names = ", ".join(c.name for c in used_by)
        raise HTTPException(
            409,
            f"Playlist is used by {len(used_by)} collection(s): {names}. Retry with force=true to unlink them.",
        )
    if used_by:
        def unlink(nodes):
            for n in nodes:
                if n.sourceType == M3U and playlist_id in n.sourceIds:
                    n.sourceIds = [s for s in n.sourceIds if s != playlist_id]
                if n.children:
                    unlink(n.children)

        unlink(collections)
        store.save_collections(collections)

    store.save_playlists([p for p in playlists if p.id != playlist_id])
    cache.invalidate(playlist_id)
    return None


@router.post("/{playlist_id}/rescan", status_code=202)
async def rescan_playlist(playlist_id: str):
    """Re-fetch the playlist now and replace everything cached for it.

    Unlike a channel rebuild this doesn't invalidate first: the refetch
    might fail, and replace_source_documents swaps the snapshot in one
    transaction anyway, so the previous entries stay browsable until new
    ones actually arrive.
    """
    for p in store.load_playlists():
        if p.id == playlist_id:
            job_id = jobs.record(p, jobs.REBUILD, M3U)
            _spawn(_scan(job_id, p, "rescan"))
            return {"rebuilding": True, "jobId": job_id}
    raise HTTPException(404, "Playlist not found")
