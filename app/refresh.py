"""The periodic background refresh that keeps every source's cache warm.

Lives outside both source modules on purpose. It used to be
telegram_client._refresh_loop, iterating store.load_channels() directly —
which meant a second source type either grew its own competing loop, or
telegram_client had to import m3u and stop being about Telegram. Neither is
right, so the loop moved here and dispatches to each source type instead.

The loop is a *scheduler*, not a sweep: it wakes on a short tick and asks
each source whether it is due, rather than refreshing everything every
cycle. That distinction is the whole point on small hardware. A Telegram
refresh is incremental and usually reads nothing at all, but a playlist
refresh re-downloads the entire list, re-parses every line of it and swaps
the whole partition — doing that to every playlist every half hour is
hours of pointless work a day on a Raspberry Pi, for lists that change
daily at best.

Deliberately not tracked in jobs.py: these refreshes are routine
housekeeping, and surfacing one as a scan notification every half hour
would train users to ignore the notification bell.
"""
import asyncio
import logging
import os
import time
from typing import List, Optional

from . import cache, health, m3u, store, telegram_client
from .models import Playlist

log = logging.getLogger("panda_vault.refresh")

# How often the scheduler wakes to look for due work. Not how often anything
# is actually refreshed — that's the per-source interval below.
TICK_SECONDS = int(os.environ.get("REFRESH_TICK_SECONDS", "300"))  # 5 min

# Named for Telegram because that's what it used to control, and the name is
# in every existing compose file and the README's config table. It is now
# only the Telegram cadence; playlists have their own, because the two cost
# wildly different amounts.
CACHE_REFRESH_SECONDS = int(os.environ.get("TG_CACHE_REFRESH_SECONDS", "1800"))  # 30 min

# Default for a playlist that hasn't set its own. Daily, because a playlist
# is a full re-download and providers publish changes on the order of days.
M3U_REFRESH_MINUTES = int(os.environ.get("M3U_REFRESH_MINUTES", "1440"))  # 24h

# Anything on a daily-or-slower interval is heavy enough to want the quiet
# hours rather than whenever the process happened to start. Local time.
NIGHTLY_HOUR = int(os.environ.get("PANDA_NIGHTLY_HOUR", "3"))
NIGHTLY_WINDOW_HOURS = int(os.environ.get("PANDA_NIGHTLY_WINDOW_HOURS", "2"))

# Below this, an interval is short enough that waiting for tonight would
# defeat the point of setting it — run it as soon as it comes due.
_NIGHTLY_THRESHOLD_MINUTES = 720  # 12h

# A source that is overdue by this much stops waiting for the window and
# runs at the next tick. Without it, a Pi that is asleep at 3am (or in a
# different timezone than its owner assumed) would never refresh at all.
_OVERDUE_FACTOR = 1.5

# Consecutive failures back the retry off, so a URL that has been dead for a
# week is retried every few days instead of every night — capped, so it
# still recovers on its own once the provider comes back.
_MAX_BACKOFF = 4

# Between sources, so a cycle trickles rather than bursting at whichever
# provider is being refreshed.
_SPACING_SECONDS = 2

_task: Optional[asyncio.Task] = None
_last_telegram_cycle: float = 0.0


def _in_nightly_window(now: float) -> bool:
    hour = time.localtime(now).tm_hour
    return NIGHTLY_HOUR <= hour < NIGHTLY_HOUR + NIGHTLY_WINDOW_HOURS


def _last_attempt(playlist_id: str, health: Optional[dict]) -> Optional[float]:
    """When this playlist was last fetched, successfully or not.

    The attempt matters more than the success: `fetched_at` only moves when
    documents are actually written, so a playlist whose URL is dead would
    read as infinitely overdue and be retried on every single tick.

    Falls back to `fetched_at` for a playlist cached before source_health
    existed, so upgrading doesn't stampede every playlist at once.
    """
    if health:
        return health["lastAttemptAt"]
    return cache.get_fetched_at(playlist_id)


def _interval_seconds(playlist: Playlist, health: Optional[dict]) -> float:
    base = (playlist.refreshMinutes or M3U_REFRESH_MINUTES) * 60
    streak = (health or {}).get("failStreak") or 0
    return base * min(2**streak, _MAX_BACKOFF) if streak else base


def _due_playlists(now: float) -> List[Playlist]:
    playlists = store.load_playlists()
    # One query for the whole set: this runs every tick, forever.
    health_by_id = cache.source_health_many([p.id for p in playlists])

    due = []
    for playlist in playlists:
        health = health_by_id.get(playlist.id)
        last = _last_attempt(playlist.id, health)
        if last is None:
            # Never fetched — added while the app was down, or its first
            # scan died. Nothing to wait for.
            due.append(playlist)
            continue

        interval = _interval_seconds(playlist, health)
        age = now - last
        if age < interval:
            continue
        if interval < _NIGHTLY_THRESHOLD_MINUTES * 60:
            due.append(playlist)
        elif _in_nightly_window(now) or age >= interval * _OVERDUE_FACTOR:
            due.append(playlist)
    return due


async def _refresh_telegram() -> None:
    # Telegram is optional and may not be connected; skip it rather than
    # logging a failure per channel every cycle.
    if not await telegram_client.is_authorized():
        return
    for channel in store.load_channels():
        try:
            await telegram_client.sync_channel(channel.id, channel.channel, force_refresh=True)
        except Exception as e:
            log.warning("Background refresh failed for channel %s: %s", channel.id, e)
        await asyncio.sleep(_SPACING_SECONDS)


async def _refresh_playlists(now: float) -> None:
    due = _due_playlists(now)
    if not due:
        return
    log.info("Refreshing %d playlist(s) due for it", len(due))
    for playlist in due:
        try:
            # The shrink guard stays on for scheduled refreshes: an
            # unattended job must never be the thing that throws away a
            # snapshot the user cannot get back. Overriding it is a
            # deliberate act, from the rescan endpoint.
            await m3u.sync_playlist(playlist.id, playlist.url, force_refresh=True)
        except Exception as e:
            # Already recorded against the source's health inside
            # sync_playlist, so the UI shows it — this is just the log line.
            log.warning("Background refresh failed for playlist %s: %s", playlist.id, e)
        await asyncio.sleep(_SPACING_SECONDS)


async def _sweep_streams(now: float) -> None:
    """The nightly stream check, run *after* the playlist refresh above.

    Order matters and is the whole reason this lives here rather than in its
    own loop: many free playlist URLs carry a session token that expires, so
    probing yesterday's snapshot would report the stale token as a dead
    channel. Checking the freshly-fetched URLs measures the stream.

    Like the refresh itself it is deliberately untracked in jobs.py — a
    notification every night for routine housekeeping is a notification
    nobody reads. A user-triggered check does get a job.
    """
    if not health.is_due(now, _in_nightly_window(now)):
        return
    try:
        await health.sweep()
    except Exception as e:
        log.warning("Nightly stream check errored: %s", e)


async def refresh_all_once(force: bool = False) -> None:
    """One scheduler pass. `force` ignores every interval and refreshes
    everything — for a manual "refresh all", never for the loop."""
    global _last_telegram_cycle
    now = time.time()

    if force or now - _last_telegram_cycle >= CACHE_REFRESH_SECONDS:
        _last_telegram_cycle = now
        await _refresh_telegram()

    if force:
        for playlist in store.load_playlists():
            try:
                await m3u.sync_playlist(playlist.id, playlist.url, force_refresh=True)
            except Exception as e:
                log.warning("Forced refresh failed for playlist %s: %s", playlist.id, e)
            await asyncio.sleep(_SPACING_SECONDS)
    else:
        await _refresh_playlists(now)
        await _sweep_streams(now)


async def _loop() -> None:
    while True:
        try:
            await refresh_all_once()
        except Exception as e:
            log.warning("Background refresh cycle errored: %s", e)
        await asyncio.sleep(TICK_SECONDS)


def start() -> None:
    global _task
    _task = asyncio.create_task(_loop())


def stop() -> None:
    if _task:
        _task.cancel()
