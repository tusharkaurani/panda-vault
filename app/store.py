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
UPLOADS_DIR = os.path.join(CONFIG_DIR, "uploads")

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


def _upload_path(playlist_id: str) -> str:
    return os.path.join(UPLOADS_DIR, f"{playlist_id}.m3u")


def save_uploaded_playlist(playlist_id: str, content: bytes) -> None:
    """Persists the raw bytes of an uploaded playlist file, so a rescan or a
    server restart can re-parse it without the browser holding onto it."""
    with _lock:
        os.makedirs(UPLOADS_DIR, exist_ok=True)
        path = _upload_path(playlist_id)
        tmp = f"{path}.tmp"
        with open(tmp, "wb") as f:
            f.write(content)
        os.replace(tmp, path)


def load_uploaded_playlist(playlist_id: str) -> bytes:
    with open(_upload_path(playlist_id), "rb") as f:
        return f.read()


def delete_uploaded_playlist(playlist_id: str) -> None:
    path = _upload_path(playlist_id)
    if os.path.exists(path):
        os.remove(path)


def load_integrations() -> Optional[List[dict]]:
    """The integrations this vault has added, as `{"id", "name"}` records, or
    None if it has never said. None and [] are
    different: None means "not decided yet", so the set can be inferred once
    from what's already configured, while [] means the user genuinely removed
    them all.

    The file used to be a bare list of ids, before a root node could be
    renamed. That form is upgraded on read (in memory; persisted by the next
    write) with `name` left unset for `integrations.name_for` to fill from the
    catalog — the same lazy-migration approach as `_migrate_source_fields`.
    """
    if not os.path.exists(INTEGRATIONS_PATH):
        return None
    with open(INTEGRATIONS_PATH) as f:
        raw = json.load(f)
    if not isinstance(raw, list):
        return None
    entries = []
    for item in raw:
        if isinstance(item, str):
            entries.append({"id": item, "name": None})
        elif isinstance(item, dict) and item.get("id"):
            name = item.get("name")
            entries.append({"id": str(item["id"]), "name": str(name) if name else None})
    return entries


def save_integrations(entries: List[dict]) -> None:
    with _lock:
        _atomic_write(INTEGRATIONS_PATH, [{"id": e["id"], "name": e.get("name")} for e in entries])


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
