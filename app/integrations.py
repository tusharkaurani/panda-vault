"""The catalog of integration types, and which of them this vault has added.

An integration is something the user *adds*, not merely something that
happens to be configured. That distinction is what lets the Library show a
node for an integration that is added but still empty — and it's what makes
room for the next source type: adding one here and in the UI's catalog is
the whole surface, because everything downstream keys off `sourceType`.

Integration ids and source types are deliberately the same strings, so a
collection's `sourceType` names the integration it belongs to.
"""
import logging
from typing import Dict, List, Optional

from . import store, telegram_client
from .models import M3U, TELEGRAM, SourceType

log = logging.getLogger("panda_vault.integrations")

# Order here is display order in the Library and in the Add menu.
CATALOG: List[Dict] = [
    {
        "id": TELEGRAM,
        "name": "Telegram",
        "description": "Documents posted across private channels. Needs an API key and a one-time sign-in.",
        "needsCredentials": True,
    },
    {
        "id": M3U,
        "name": "M3U Playlists",
        "description": "Live streams listed in remote playlists. No account needed — just a URL.",
        "needsCredentials": False,
    },
]

_IDS = [entry["id"] for entry in CATALOG]


def _infer() -> List[str]:
    """What an install that predates integrations.json must already have.

    Anyone upgrading has never been asked which integrations they wanted, so
    infer it from what they've actually configured rather than presenting
    them with an empty vault.
    """
    added = []
    if telegram_client.configured() or store.load_channels():
        added.append(TELEGRAM)
    if store.load_playlists():
        added.append(M3U)
    return added


def _entries() -> List[Dict]:
    """The added integrations as stored: `{"id", "name"}`, in catalog order.

    `name` is the label the user gave this integration's root node in the
    Library, and is None until they pick one — `name_for` resolves that to
    the catalog default. Unknown ids (a downgrade, or a hand-edited file) are
    dropped rather than surfaced.
    """
    stored = store.load_integrations()
    if stored is None:
        stored = [{"id": i, "name": None} for i in _infer()]
        store.save_integrations(stored)
        log.info(
            "Initialized integrations.json from existing config: %s",
            ", ".join(e["id"] for e in stored) or "none",
        )
    by_id = {e["id"]: e for e in stored if e["id"] in _IDS}
    return [by_id[i] for i in _IDS if i in by_id]


def added() -> List[str]:
    """The integration ids this vault has added, in catalog order."""
    return [e["id"] for e in _entries()]


def is_added(integration_id: str) -> bool:
    return integration_id in added()


def default_name(integration_id: str) -> str:
    """What this integration is called before the user renames it — also what
    the Add menu offers, since it names the *type*."""
    entry = next((e for e in CATALOG if e["id"] == integration_id), None)
    return entry["name"] if entry else integration_id


def name_for(integration_id: str) -> str:
    """The label this integration's root node carries in the Library."""
    stored = next((e for e in _entries() if e["id"] == integration_id), None)
    return (stored or {}).get("name") or default_name(integration_id)


def add(integration_id: str, name: Optional[str] = None) -> List[str]:
    current = _entries()
    if integration_id not in {e["id"] for e in current}:
        current.append({"id": integration_id, "name": name or None})
        by_id = {e["id"]: e for e in current}
        store.save_integrations([by_id[i] for i in _IDS if i in by_id])
    return added()


def rename(integration_id: str, name: Optional[str]) -> str:
    """Set (or, with a falsy name, clear) the root node's label.

    Clearing is not a deletion of anything the user can see — it just falls
    back to the catalog default, which is what an unnamed integration shows.
    """
    entries = _entries()
    for entry in entries:
        if entry["id"] == integration_id:
            entry["name"] = name or None
            break
    store.save_integrations(entries)
    return name_for(integration_id)


def remove(integration_id: str) -> List[str]:
    store.save_integrations([e for e in _entries() if e["id"] != integration_id])
    return added()


def source_count(integration_id: str) -> int:
    if integration_id == TELEGRAM:
        return len(store.load_channels())
    if integration_id == M3U:
        return len(store.load_playlists())
    return 0


async def describe(integration_id: str) -> Optional[Dict]:
    """One catalog entry plus this vault's live state for it."""
    entry = next((e for e in CATALOG if e["id"] == integration_id), None)
    if entry is None:
        return None
    if integration_id == TELEGRAM:
        configured = telegram_client.configured()
        connected = await telegram_client.is_authorized()
    else:
        # Nothing to configure and nothing to sign in to.
        configured = True
        connected = True
    is_on = is_added(integration_id)
    return {
        **entry,
        # The user's label for the root node wins over the catalog's; the
        # catalog name stays available as `defaultName` so the UI can offer
        # it as a placeholder and say what kind of thing this is.
        "name": name_for(integration_id) if is_on else entry["name"],
        "defaultName": entry["name"],
        "added": is_on,
        "configured": configured,
        "connected": connected,
        "sourceCount": source_count(integration_id),
        # Added, but not yet usable — the UI leads with this.
        "needsSetup": is_on and not connected,
    }


async def describe_all() -> List[Dict]:
    return [await describe(i) for i in _IDS]
