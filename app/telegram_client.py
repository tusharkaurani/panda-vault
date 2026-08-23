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
import time
from typing import Callable, Dict, List, Optional, Tuple

from telethon import TelegramClient
from telethon.errors import FloodWaitError, SessionPasswordNeededError
from telethon.tl.custom import QRLogin
from telethon.tl.functions.channels import JoinChannelRequest
from telethon.tl.functions.messages import CheckChatInviteRequest, ImportChatInviteRequest
from telethon.tl.types import DocumentAttributeFilename, InputMessagesFilterDocument

from . import cache, store
from .models import DocumentOut

CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config")
SESSION_PATH = os.path.join(CONFIG_DIR, "session")
os.makedirs(CONFIG_DIR, exist_ok=True)

# Optional, not required. Telegram is one integration among several now,
# and an install that only uses M3U playlists has no reason to hold a
# Telegram API key — reading these eagerly used to abort startup for
# everyone who didn't. Unset means "the integration is not configured",
# which surfaces through configured() and is what the UI reports.
_RAW_API_ID = os.environ.get("TG_API_ID", "").strip()
API_HASH = os.environ.get("TG_API_HASH", "").strip()
try:
    API_ID = int(_RAW_API_ID) if _RAW_API_ID else 0
except ValueError:
    API_ID = 0
_PROGRESS_EVERY = 100  # documents between partial cache writes / progress updates
# Telegram's "Files" category: plain file attachments, excluding the media
# it classifies separately (video/music/voice/GIF/round video).
_FILE_FILTER = InputMessagesFilterDocument()

# connection_retries=None retries a dropped connection forever. Telethon's
# default (5 attempts, 1s apart) gives up after roughly five seconds of
# network trouble and then stays down for good: it sets the sender to
# disconnected, so every later call raises "Cannot send requests while
# disconnected" and only restarting the process brings it back. This app is a
# long-lived unattended container, so outlasting the outage is always what we
# want.
def configured() -> bool:
    """Whether TG_API_ID / TG_API_HASH were supplied at all. Distinct from
    is_authorized(): unconfigured means there is nothing to log in *to*, so
    the UI offers setup instructions rather than a login form."""
    return bool(API_ID and API_HASH)


# None when the integration isn't configured. Constructing a client eagerly
# would create config/session.session for installs that never use Telegram,
# and every entry point below already has to handle "not connected" anyway.
client: Optional[TelegramClient] = (
    TelegramClient(SESSION_PATH, API_ID, API_HASH, connection_retries=None, retry_delay=5)
    if configured()
    else None
)
log = logging.getLogger("panda_vault.telegram_client")

_connect_lock = asyncio.Lock()
_last_connect_failure: Optional[float] = None
_stopping = False
_RECONNECT_COOLDOWN = 5.0  # seconds between reconnect attempts while down
_channel_locks: Dict[str, asyncio.Lock] = {}
_login_phone: Optional[str] = None
_qr: Optional[QRLogin] = None
_qr_task: Optional[asyncio.Task] = None
_qr_result: Dict = {"status": "pending"}


def _lock_for(channel_id: str) -> asyncio.Lock:
    lock = _channel_locks.get(channel_id)
    if lock is None:
        lock = asyncio.Lock()
        _channel_locks[channel_id] = lock
    return lock

_INVITE_RE = re.compile(r"(?:https?://)?t\.me/(?:joinchat/|\+)([\w-]+)", re.IGNORECASE)


def _require_client() -> TelegramClient:
    """For the paths that talk to Telegram directly rather than going
    through ensure_connected() — they'd otherwise fail on None with an
    AttributeError instead of something a user can act on."""
    if client is None:
        raise RuntimeError(
            "Telegram is not configured — set TG_API_ID and TG_API_HASH to enable it"
        )
    return client


async def start() -> None:
    """Connect only — never blocks on interactive login. First-run auth is
    driven through the /api/auth endpoints (web login flow) instead of a
    terminal prompt, since the app is meant to run unattended in a
    container.

    A failure here is logged rather than raised: an unreachable Telegram at
    boot would otherwise abort the lifespan and take the whole app down,
    when ensure_connected() will pick the connection up on its own as soon
    as the network is back.
    """
    if not configured():
        log.info("Telegram is not configured (no TG_API_ID / TG_API_HASH) — skipping connect")
        return
    await ensure_connected()


async def stop() -> None:
    global _stopping
    _stopping = True
    if client is not None:
        await client.disconnect()


async def ensure_connected() -> bool:
    """True if the client is connected, reconnecting first if it isn't.

    Something has to call connect() again after the connection dies —
    Telethon's own retries can still run out (auth key rejected by the
    server, a proxy refusing us, retries disabled), and nothing else in this
    app ever reconnects after startup. Without this, one dropped connection
    leaves every request failing with "Cannot send requests while
    disconnected" until the container is restarted.
    """
    global _last_connect_failure
    if client is None or _stopping:
        return False
    if client.is_connected():
        return True
    async with _connect_lock:
        # Someone else may have reconnected while we waited for the lock.
        if client.is_connected():
            return True
        # While Telegram is unreachable connect() blocks for the full connect
        # timeout. The auth middleware calls this on every single request, so
        # without a cooldown a dead network turns into a pile of requests all
        # stalling on their own doomed connect. Only *failures* start the
        # cooldown — a connection that drops seconds after a good connect
        # still has to be allowed to come straight back.
        if _last_connect_failure is not None and (
            time.monotonic() - _last_connect_failure < _RECONNECT_COOLDOWN
        ):
            return False
        try:
            await client.connect()
        except Exception as e:
            _last_connect_failure = time.monotonic()
            log.warning("Could not connect to Telegram: %s", e)
            return False
        _last_connect_failure = None
        log.info("Connected to Telegram")
        return True


async def is_authorized() -> bool:
    if not await ensure_connected():
        return False
    try:
        return await client.is_user_authorized()
    except Exception as e:
        # A connection that dies mid-check would otherwise surface as a 500
        # from the auth middleware.
        log.warning("Authorization check failed: %s", e)
        return False


async def send_code(phone: str) -> None:
    global _login_phone
    # The /api/auth/* routes are exempt from the auth middleware, so they are
    # the one group of endpoints that never passes through ensure_connected()
    # on its way in — and they are exactly what a user reaches for when a lost
    # connection has bounced them back to the login screen.
    _require_client()
    await ensure_connected()
    _login_phone = phone
    await client.send_code_request(phone)


async def sign_in_code(code: str) -> bool:
    """Returns True if fully signed in, False if the account needs a 2FA
    password next (call sign_in_password)."""
    _require_client()
    if not _login_phone:
        raise RuntimeError("Send a login code first")
    await ensure_connected()
    try:
        await client.sign_in(_login_phone, code)
        return True
    except SessionPasswordNeededError:
        return False


async def sign_in_password(password: str) -> None:
    _require_client()
    await ensure_connected()
    await client.sign_in(password=password)


async def qr_login_start() -> Tuple[str, float]:
    """Starts (or restarts) a QR login flow. A background task owns the
    single `wait()` call for the code's whole lifetime so the event
    handler that catches Telegram's scan notification stays registered
    continuously — polling `wait()` itself per HTTP request would leave
    gaps where a scan could be missed. Returns (url, expires_epoch)."""
    global _qr, _qr_task, _qr_result
    _require_client()
    await ensure_connected()
    if _qr_task and not _qr_task.done():
        _qr_task.cancel()
    _qr = await client.qr_login()
    _qr_result = {"status": "pending"}
    _qr_task = asyncio.create_task(_qr_wait())
    return _qr.url, _qr.expires.timestamp()


async def _qr_wait() -> None:
    global _qr_result
    qr = _qr
    try:
        await qr.wait()
        _qr_result = {"status": "authorized"}
    except SessionPasswordNeededError:
        _qr_result = {"status": "needs_password"}
    except asyncio.TimeoutError:
        _qr_result = {"status": "expired"}
    except asyncio.CancelledError:
        raise
    except Exception as e:
        _qr_result = {"status": "error", "error": str(e)}


def qr_login_poll() -> Dict:
    return dict(_qr_result)


def _get_filename(document) -> str:
    for attr in document.attributes:
        if isinstance(attr, DocumentAttributeFilename):
            return attr.file_name
    return f"unnamed.{(document.mime_type or '').split('/')[-1] or 'bin'}"


async def _resolve_entity(channel_ref: str):
    _require_client()
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
    if client is None:
        return False, "Telegram is not configured — set TG_API_ID and TG_API_HASH to enable it"
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


async def _scan_documents(entity, min_id: int = 0, on_chunk: Optional[Callable] = None) -> Tuple[int, int]:
    """Scan messages newer than min_id (0 = full history), handing each
    batch straight to on_chunk. A Telegram channel's past never changes,
    so min_id lets a refresh only ask for what's new since the last scan
    instead of re-reading everything.

    The InputMessagesFilterDocument filter is what keeps this cheap:
    Telegram returns only messages carrying a file, so a chat-heavy
    channel costs one round trip per ~100 files rather than per ~100
    messages. It also matches what this app indexes — plain files, not
    videos/music/voice notes/GIFs, which Telegram classifies as separate
    media categories and which never appear under this filter.

    Documents are streamed out in batches of _PROGRESS_EVERY rather than
    accumulated: a full scan of a large channel would otherwise hold every
    document it has ever seen in memory at once. Returns
    (documents_seen, max_id).

    on_chunk(batch, max_id_so_far, total, seen_so_far) receives only the
    documents since the previous call. `total` is the server's count of
    matching messages — free, since Telethon populates it from the first
    response — or None before the first batch lands.
    """
    batch: List[DocumentOut] = []
    seen = 0
    max_id = min_id
    it = client.iter_messages(entity, min_id=min_id, filter=_FILE_FILTER)
    async for message in it:
        if message.id > max_id:
            max_id = message.id
        if not message.document:
            continue
        doc = message.document
        batch.append(
            DocumentOut(
                id=message.id,
                name=_get_filename(doc),
                size=doc.size,
                date=message.date.strftime("%Y-%m-%d %H:%M"),
                mime_type=doc.mime_type,
            )
        )
        seen += 1
        if len(batch) >= _PROGRESS_EVERY:
            if on_chunk:
                on_chunk(batch, max_id, it.total, seen)
            batch = []
    if on_chunk:
        on_chunk(batch, max_id, it.total, seen)
    return seen, max_id


async def _server_file_count(entity) -> Optional[int]:
    """Telegram's own count of file-carrying messages in this chat. limit=0
    fetches no messages at all — the count rides along on the response — so
    this costs one cheap call. None if Telegram didn't report a total."""
    try:
        return (await client.get_messages(entity, limit=0, filter=_FILE_FILTER)).total
    except Exception as e:
        log.warning("Could not read file count for entity: %s", e)
        return None


async def sync_channel(
    channel_id: str,
    channel_ref: str,
    force_refresh: bool = False,
    full_rebuild: bool = False,
    on_progress: Optional[Callable] = None,
) -> int:
    """Bring a channel's cached listing up to date, returning how many
    documents it holds afterwards.

    Deliberately returns a count rather than the documents themselves:
    callers want a page of 20 rows, and materializing a 66k-document
    channel to serve them was the single most expensive thing this module
    used to do. Read the documents back through cache.query_documents,
    which pages in SQL.
    """
    # No TTL check here on purpose: the cache is kept warm by the background
    # refresh loop below, so a cache hit is served regardless of age. This is
    # what keeps per-request Telegram API calls to (near) zero.
    #
    # full_rebuild deliberately ignores whatever's cached (ignore, don't
    # merge) so a corrupted/stale cache can be thrown away and rebuilt from
    # a clean full history scan — force_refresh alone only does an
    # incremental min_id-based top-up against the existing cache.
    known = False if full_rebuild else cache.has_source(channel_id)
    if known and not force_refresh:
        return cache.count_documents(channel_id)

    # A per-channel lock keeps two concurrent callers (e.g. the background
    # warm-up task and a user opening the collection at the same time) from both
    # running a full history scan against Telegram — the loser just waits
    # and gets served whatever the winner produced.
    async with _lock_for(channel_id):
        known = False if full_rebuild else cache.has_source(channel_id)
        if known and not force_refresh:
            return cache.count_documents(channel_id)

        try:
            entity = await _resolve_entity(channel_ref)
        except FloodWaitError as e:
            raise RuntimeError(f"Telegram rate-limited this channel — retry in {e.seconds}s")
        except Exception as e:
            raise RuntimeError(f"Could not access channel: {e}")

        if full_rebuild:
            # Drop everything first so a rebuild really does start from a
            # clean slate — otherwise rows the channel has since deleted
            # would survive the "rebuild" that was meant to clear them.
            cache.invalidate(channel_id)

        # First time we've ever seen this channel (or a full_rebuild): scan
        # the full history once and cache it — it never needs a full
        # re-scan again. Every later call (background refresh or manual
        # "Refresh") only asks Telegram for messages newer than the
        # highest ID we already have.
        last_max_id = cache.get_max_id(channel_id) if known else 0

        if known:
            # ...but an incremental scan can only ever *add*. Channels that
            # prune old posts (auto-delete TTLs are common on newspaper
            # channels) leave the cache holding messages that no longer
            # exist: they stay listed in the UI and 404 on download, and no
            # amount of refreshing removes them. Telegram's own file count
            # is one cheap call and dropping below what we have cached is a
            # reliable "something was deleted" signal — it counts a superset
            # of what the scan keeps, never a subset. When it fires, throw
            # the cache away and rescan the full history so the dead entries
            # actually disappear.
            cached_count = cache.count_documents(channel_id)
            server_count = await _server_file_count(entity)
            if server_count is not None and server_count < cached_count:
                log.info(
                    "Channel %s has %d file(s) on Telegram but %d cached — rescanning to drop deleted ones",
                    channel_id,
                    server_count,
                    cached_count,
                )
                cache.invalidate(channel_id)
                known, last_max_id = False, 0

        def on_chunk(
            batch: List[DocumentOut], partial_max_id: int, total: Optional[int], seen: int
        ) -> None:
            # Publish each batch as it arrives: collection counts and the
            # document list read straight off the cache, so they climb as
            # the scan runs instead of showing 0 until it completes.
            #
            # upsert_documents cannot advance the min_id cursor, which is
            # what makes an interrupted scan safe — see set_cursor below.
            cache.upsert_documents(channel_id, batch)
            if on_progress:
                on_progress(seen, total)

        _, seen_max_id = await _scan_documents(entity, min_id=last_max_id, on_chunk=on_chunk)

        # Only now that the scan has run to completion is it safe to move
        # the cursor: messages arrive newest-first, so a partial scan is
        # missing its older tail.
        cache.set_cursor(channel_id, max(seen_max_id, last_max_id))
        return cache.count_documents(channel_id)


async def download_stream(channel_ref: str, msg_id: int):
    _require_client()
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
