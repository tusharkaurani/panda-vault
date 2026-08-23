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


def added() -> List[str]:
    """The integration ids this vault has added, in catalog order."""
    stored = store.load_integrations()
    if stored is None:
        stored = _infer()
        store.save_integrations(stored)
        log.info("Initialized integrations.json from existing config: %s", stored or "none")
    known = set(stored)
    return [i for i in _IDS if i in known]


def is_added(integration_id: str) -> bool:
    return integration_id in added()


def add(integration_id: str) -> List[str]:
    current = added()
    if integration_id not in current:
        current.append(integration_id)
        store.save_integrations([i for i in _IDS if i in set(current)])
    return added()


def remove(integration_id: str) -> List[str]:
    current = [i for i in added() if i != integration_id]
    store.save_integrations(current)
    return current


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
        "added": is_on,
        "configured": configured,
        "connected": connected,
        "sourceCount": source_count(integration_id),
        # Added, but not yet usable — the UI leads with this.
        "needsSetup": is_on and not connected,
    }


async def describe_all() -> List[Dict]:
    return [await describe(i) for i in _IDS]
