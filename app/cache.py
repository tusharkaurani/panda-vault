"""Disk-persisted cache for per-channel document listings.

Avoids re-scanning a Telegram channel's full message history on every
collection open (slow + risks Telegram FloodWait rate limiting). Unlike a
short TTL cache, entries here don't expire on their own — they're kept
fresh by a periodic background refresh loop (see
telegram_client.start_refresh_loop) and survive process restarts.
Callers can still force a live bypass (e.g. a "Refresh" button in the
UI, or a cache miss for a brand new channel).
"""
import json
import os
import threading
import time
from typing import Dict, List, Optional

from .models import DocumentOut

CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config")
CACHE_PATH = os.path.join(CONFIG_DIR, "document_cache.json")

_lock = threading.Lock()
_cache: Dict[str, dict] = {}  # channel_id -> {"fetched_at": float, "documents": [...]}


def _atomic_write(path: str, data) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def load() -> None:
    """Load the persisted cache from disk into memory. Call once at startup."""
    global _cache
    if not os.path.exists(CACHE_PATH):
        return
    with open(CACHE_PATH) as f:
        _cache = json.load(f)


def get_cached(channel_id: str) -> Optional[List[DocumentOut]]:
    entry = _cache.get(channel_id)
    if not entry:
        return None
    return [DocumentOut(**d) for d in entry["documents"]]


def get_cached_names(channel_id: str) -> Optional[List[str]]:
    """Like get_cached but skips Pydantic reconstruction — for callers that
    only need to count documents (e.g. the collection tree's per-node
    fileCount) building a full DocumentOut for every cached doc on every
    request is wasted work."""
    entry = _cache.get(channel_id)
    if not entry:
        return None
    return [d["name"] for d in entry["documents"]]


def get_fetched_at(channel_id: str) -> Optional[float]:
    entry = _cache.get(channel_id)
    return entry["fetched_at"] if entry else None


def get_max_id(channel_id: str) -> int:
    """Highest Telegram message ID captured so far, used as the `min_id`
    cursor for incremental refreshes. 0 for a channel never fully scanned
    (including caches written before this field existed)."""
    entry = _cache.get(channel_id)
    return entry.get("max_id", 0) if entry else 0


def set_cached(channel_id: str, docs: List[DocumentOut], max_id: int) -> None:
    with _lock:
        _cache[channel_id] = {
            "fetched_at": time.time(),
            "max_id": max_id,
            "documents": [d.model_dump() for d in docs],
        }
        _atomic_write(CACHE_PATH, _cache)


def invalidate(channel_id: str) -> None:
    with _lock:
        if _cache.pop(channel_id, None) is not None:
            _atomic_write(CACHE_PATH, _cache)
