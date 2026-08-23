"""The periodic background refresh that keeps every source's cache warm.

Lives outside both source modules on purpose. It used to be
telegram_client._refresh_loop, iterating store.load_channels() directly —
which meant a second source type either grew its own competing loop, or
telegram_client had to import m3u and stop being about Telegram. Neither is
right, so the loop moved here and dispatches to each source type instead.

Deliberately not tracked in jobs.py: these refreshes are routine
housekeeping, and surfacing one as a scan notification every half hour
would train users to ignore the notification bell.
"""
import asyncio
import logging
import os
from typing import Optional

from . import m3u, store, telegram_client

log = logging.getLogger("panda_vault.refresh")

# Named for Telegram because that's what it used to control, and the name is
# in every existing compose file and the README's config table.
CACHE_REFRESH_SECONDS = int(os.environ.get("TG_CACHE_REFRESH_SECONDS", "1800"))  # 30 min

# Between sources, so a cycle trickles rather than bursting at whichever
# provider is being refreshed.
_SPACING_SECONDS = 2

_task: Optional[asyncio.Task] = None


async def refresh_all_once() -> None:
    # Telegram is optional and may not be connected; skip it rather than
    # logging a failure per channel every cycle.
    if await telegram_client.is_authorized():
        for channel in store.load_channels():
            try:
                await telegram_client.sync_channel(channel.id, channel.channel, force_refresh=True)
            except Exception as e:
                log.warning("Background refresh failed for channel %s: %s", channel.id, e)
            await asyncio.sleep(_SPACING_SECONDS)

    for playlist in store.load_playlists():
        try:
            await m3u.sync_playlist(playlist.id, playlist.url, force_refresh=True)
        except Exception as e:
            log.warning("Background refresh failed for playlist %s: %s", playlist.id, e)
        await asyncio.sleep(_SPACING_SECONDS)


async def _loop() -> None:
    while True:
        try:
            await refresh_all_once()
        except Exception as e:
            log.warning("Background refresh cycle errored: %s", e)
        await asyncio.sleep(CACHE_REFRESH_SECONDS)


def start() -> None:
    global _task
    _task = asyncio.create_task(_loop())


def stop() -> None:
    if _task:
        _task.cancel()
