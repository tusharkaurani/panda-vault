"""Telethon client lifecycle + entity resolution/join/list/download helpers.

One shared Telegram account/session (unchanged from the original single
-channel app) is reused across every configured channel — "adding a
channel" in the UI just points the same account at another chat, joining
it first if needed.
"""
import asyncio
import logging
import os
import re
from typing import Dict, List, Optional, Tuple

from telethon import TelegramClient
from telethon.errors import FloodWaitError
from telethon.tl.functions.channels import JoinChannelRequest
from telethon.tl.functions.messages import CheckChatInviteRequest, ImportChatInviteRequest
from telethon.tl.types import DocumentAttributeFilename

from . import store
from .cache import get_cached, get_max_id, set_cached
from .models import DocumentOut

CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config")
SESSION_PATH = os.path.join(CONFIG_DIR, "session")

API_ID = int(os.environ["TG_API_ID"])
API_HASH = os.environ["TG_API_HASH"]
CACHE_REFRESH_SECONDS = int(os.environ.get("TG_CACHE_REFRESH_SECONDS", "1800"))  # 30 min

client = TelegramClient(SESSION_PATH, API_ID, API_HASH)
log = logging.getLogger("panda_vault.telegram_client")

_refresh_task: Optional[asyncio.Task] = None
_channel_locks: Dict[str, asyncio.Lock] = {}


def _lock_for(channel_id: str) -> asyncio.Lock:
    lock = _channel_locks.get(channel_id)
    if lock is None:
        lock = asyncio.Lock()
        _channel_locks[channel_id] = lock
    return lock

_INVITE_RE = re.compile(r"(?:https?://)?t\.me/(?:joinchat/|\+)([\w-]+)", re.IGNORECASE)


async def start() -> None:
    await client.start()


async def stop() -> None:
    await client.disconnect()


def _get_filename(document) -> str:
    for attr in document.attributes:
        if isinstance(attr, DocumentAttributeFilename):
            return attr.file_name
    return f"unnamed.{(document.mime_type or '').split('/')[-1] or 'bin'}"


def _human_size(n: float) -> str:
    for unit in ["B", "KB", "MB", "GB"]:
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


async def _resolve_entity(channel_ref: str):
    ref = channel_ref.strip()
    m = _INVITE_RE.match(ref)
    if m:
        result = await client(CheckChatInviteRequest(m.group(1)))
        chat = getattr(result, "chat", None)
        if chat:
            return chat
        raise RuntimeError("Not a member of this invite link's chat yet — use Join first")
    return await client.get_entity(ref)


async def resolve_and_check(channel_ref: str) -> bool:
    """Best-effort reachability check used when adding/editing a channel."""
    try:
        await _resolve_entity(channel_ref)
        return True
    except Exception:
        return False


async def join_channel(channel_ref: str) -> Tuple[bool, str]:
    ref = channel_ref.strip()
    try:
        m = _INVITE_RE.match(ref)
        if m:
            await client(ImportChatInviteRequest(m.group(1)))
        else:
            entity = await client.get_entity(ref)
            await client(JoinChannelRequest(entity))
        return True, "joined"
    except FloodWaitError as e:
        return False, f"Telegram rate-limited this action — retry in {e.seconds}s"
    except Exception as e:
        return False, str(e)


async def _scan_documents(entity, min_id: int = 0) -> Tuple[List[DocumentOut], int]:
    """Scan messages newer than min_id (0 = full history). A Telegram
    channel's past never changes, so min_id lets a refresh only ask for
    what's new since the last scan instead of re-reading everything."""
    docs: List[DocumentOut] = []
    max_id = min_id
    async for message in client.iter_messages(entity, min_id=min_id):
        if message.id > max_id:
            max_id = message.id
        if message.document:
            doc = message.document
            docs.append(
                DocumentOut(
                    id=message.id,
                    name=_get_filename(doc),
                    size=doc.size,
                    size_human=_human_size(doc.size),
                    date=message.date.strftime("%Y-%m-%d %H:%M"),
                    mime_type=doc.mime_type,
                )
            )
    return docs, max_id


def _merge_by_id(existing: List[DocumentOut], fresh: List[DocumentOut]) -> List[DocumentOut]:
    by_id = {d.id: d for d in existing}
    for d in fresh:
        by_id[d.id] = d
    return list(by_id.values())


async def list_documents(
    channel_id: str, channel_ref: str, force_refresh: bool = False, full_rebuild: bool = False
) -> List[DocumentOut]:
    # No TTL check here on purpose: the cache is kept warm by the background
    # refresh loop below, so a cache hit is served regardless of age. This is
    # what keeps per-request Telegram API calls to (near) zero.
    #
    # full_rebuild deliberately ignores whatever's cached (ignore, don't
    # merge) so a corrupted/stale cache can be thrown away and rebuilt from
    # a clean full history scan — force_refresh alone only does an
    # incremental min_id-based top-up against the existing cache.
    cached = None if full_rebuild else get_cached(channel_id)
    if cached is not None and not force_refresh:
        return cached

    # A per-channel lock keeps two concurrent callers (e.g. the background
    # warm-up task and a user opening the collection at the same time) from both
    # running a full history scan against Telegram — the loser just waits
    # and gets served whatever the winner produced.
    async with _lock_for(channel_id):
        cached = None if full_rebuild else get_cached(channel_id)
        if cached is not None and not force_refresh:
            return cached

        try:
            entity = await _resolve_entity(channel_ref)
        except FloodWaitError as e:
            raise RuntimeError(f"Telegram rate-limited this channel — retry in {e.seconds}s")
        except Exception as e:
            raise RuntimeError(f"Could not access channel: {e}")

        # First time we've ever seen this channel (or a full_rebuild): scan
        # the full history once and cache it — it never needs a full
        # re-scan again. Every later call (background refresh or manual
        # "Refresh") only asks Telegram for messages newer than the
        # highest ID we already have.
        last_max_id = get_max_id(channel_id) if cached is not None else 0
        fresh_docs, seen_max_id = await _scan_documents(entity, min_id=last_max_id)

        docs = _merge_by_id(cached, fresh_docs) if cached is not None else fresh_docs
        set_cached(channel_id, docs, max(seen_max_id, last_max_id))
        return docs


async def download_stream(channel_ref: str, msg_id: int):
    entity = await _resolve_entity(channel_ref)
    message = await client.get_messages(entity, ids=msg_id)
    if not message or not message.document:
        return None

    filename = _get_filename(message.document)
    size = message.document.size
    mime = message.document.mime_type or "application/octet-stream"

    async def gen():
        async for chunk in client.iter_download(message.document):
            yield chunk

    return gen, filename, size, mime


async def _refresh_all_once() -> None:
    for channel in store.load_channels():
        try:
            await list_documents(channel.id, channel.channel, force_refresh=True)
        except Exception as e:
            log.warning("Background refresh failed for channel %s: %s", channel.id, e)
        await asyncio.sleep(2)  # spread calls out instead of bursting Telegram


async def _refresh_loop() -> None:
    while True:
        try:
            await _refresh_all_once()
        except Exception as e:
            log.warning("Background refresh cycle errored: %s", e)
        await asyncio.sleep(CACHE_REFRESH_SECONDS)


def start_refresh_loop() -> None:
    global _refresh_task
    _refresh_task = asyncio.create_task(_refresh_loop())


def stop_refresh_loop() -> None:
    if _refresh_task:
        _refresh_task.cancel()
