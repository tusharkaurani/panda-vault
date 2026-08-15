"""JSON-backed persistence for channels.json / collections.json.

Small, human-inspectable files under config/ (already git-backed, same as
the Telethon session) — plenty for a personal home-lab scale library.
"""
import json
import os
import threading
from typing import List

from .models import Channel, Collection

CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config")
CHANNELS_PATH = os.path.join(CONFIG_DIR, "channels.json")
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


def _migrate_channel_id(node: dict) -> dict:
    """Transparently upgrade the legacy single `channelId` field to the
    `channelIds` list on read. In-memory only — persisted on the next write
    via save_collections, same lazy-migration spirit as the folders.json
    rename above."""
    if "channelId" in node:
        legacy = node.pop("channelId")
        node.setdefault("channelIds", [legacy] if legacy else [])
    for child in node.get("children", []):
        _migrate_channel_id(child)
    return node


def load_collections() -> List[Collection]:
    if not os.path.exists(COLLECTIONS_PATH) and os.path.exists(_LEGACY_FOLDERS_PATH):
        # One-time transparent migration from the pre-rename filename.
        os.replace(_LEGACY_FOLDERS_PATH, COLLECTIONS_PATH)
    if not os.path.exists(COLLECTIONS_PATH):
        return []
    with open(COLLECTIONS_PATH) as f:
        raw = json.load(f)
    return [Collection(**_migrate_channel_id(node)) for node in raw]


def save_collections(collections: List[Collection]) -> None:
    with _lock:
        _atomic_write(COLLECTIONS_PATH, [c.model_dump() for c in collections])
