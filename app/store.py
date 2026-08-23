"""JSON-backed persistence for the config/*.json files.

Small, human-inspectable files under config/ (already git-backed, same as
the Telethon session) — plenty for a personal home-lab scale library.
"""
import json
import os
import threading
from typing import List, Optional

from .models import Channel, Collection, Playlist

CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config")
CHANNELS_PATH = os.path.join(CONFIG_DIR, "channels.json")
PLAYLISTS_PATH = os.path.join(CONFIG_DIR, "playlists.json")
INTEGRATIONS_PATH = os.path.join(CONFIG_DIR, "integrations.json")
COLLECTIONS_PATH = os.path.join(CONFIG_DIR, "collections.json")
_LEGACY_FOLDERS_PATH = os.path.join(CONFIG_DIR, "folders.json")

_lock = threading.Lock()


def _atomic_write(path: str, data) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def load_channels() -> List[Channel]:
    if not os.path.exists(CHANNELS_PATH):
        return []
    with open(CHANNELS_PATH) as f:
        raw = json.load(f)
    return [Channel(**c) for c in raw]


def save_channels(channels: List[Channel]) -> None:
    with _lock:
        _atomic_write(CHANNELS_PATH, [c.model_dump() for c in channels])


def load_playlists() -> List[Playlist]:
    if not os.path.exists(PLAYLISTS_PATH):
        return []
    with open(PLAYLISTS_PATH) as f:
        raw = json.load(f)
    return [Playlist(**p) for p in raw]


def save_playlists(playlists: List[Playlist]) -> None:
    with _lock:
        _atomic_write(PLAYLISTS_PATH, [p.model_dump() for p in playlists])


def load_integrations() -> Optional[List[str]]:
    """The integration ids this vault has added, or None if it has never
    said. None and [] are different: None means "not decided yet", so the
    set can be inferred once from what's already configured, while []
    means the user genuinely removed them all."""
    if not os.path.exists(INTEGRATIONS_PATH):
        return None
    with open(INTEGRATIONS_PATH) as f:
        raw = json.load(f)
    return [str(i) for i in raw] if isinstance(raw, list) else None


def save_integrations(ids: List[str]) -> None:
    with _lock:
        _atomic_write(INTEGRATIONS_PATH, list(ids))


def _migrate_source_fields(node: dict) -> dict:
    """Transparently upgrade the legacy binding fields on read, in the same
    lazy spirit as the folders.json rename below — in memory only, persisted
    on the next write via save_collections.

    Two generations of renames, applied oldest first:
      channelId (single)  -> channelIds (list)
      channelIds          -> sourceIds  (+ sourceType, defaulting to telegram)

    Every pre-existing collection was necessarily a Telegram one, so the
    default is exactly right and no user action is needed.
    """
    if "channelId" in node:
        legacy = node.pop("channelId")
        node.setdefault("channelIds", [legacy] if legacy else [])
    if "channelIds" in node:
        node.setdefault("sourceIds", node.pop("channelIds"))
    node.setdefault("sourceType", "telegram")
    for child in node.get("children", []):
        _migrate_source_fields(child)
    return node


def load_collections() -> List[Collection]:
    if not os.path.exists(COLLECTIONS_PATH) and os.path.exists(_LEGACY_FOLDERS_PATH):
        # One-time transparent migration from the pre-rename filename.
        os.replace(_LEGACY_FOLDERS_PATH, COLLECTIONS_PATH)
    if not os.path.exists(COLLECTIONS_PATH):
        return []
    with open(COLLECTIONS_PATH) as f:
        raw = json.load(f)
    return [Collection(**_migrate_source_fields(node)) for node in raw]


def save_collections(collections: List[Collection]) -> None:
    with _lock:
        _atomic_write(COLLECTIONS_PATH, [c.model_dump() for c in collections])
