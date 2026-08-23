"""The integration catalog — what this vault could connect, and what it has.

Not Telegram-gated: the catalog is exactly what an install with no Telegram
account needs to read in order to add its first integration.
"""
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException

from .. import integrations, store
from ..models import (
    TELEGRAM,
    MAX_REFRESH_MINUTES,
    MIN_REFRESH_MINUTES,
    Channel,
    Collection,
    CollectionExport,
    IntegrationExport,
    IntegrationIn,
    IntegrationUpdate,
    Playlist,
    SourceExport,
)

# A root node's label sits in breadcrumbs and cards; long enough for a real
# name, short enough that it can't blow out a layout.
_MAX_NAME = 60

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


def _collections_for(integration_id: str):
    return [n for n in store.load_collections() if n.sourceType == integration_id]


def _require_added(integration_id: str) -> None:
    if integration_id not in (e["id"] for e in integrations.CATALOG):
        raise HTTPException(404, f"Unknown integration {integration_id!r}")
    if not integrations.is_added(integration_id):
        raise HTTPException(404, f"{integrations.default_name(integration_id)} is not added")


def _export_collections(nodes: List[Collection]) -> List[dict]:
    return [
        {
            "name": n.name,
            "description": n.description,
            "icon": n.icon,
            "sourceIds": list(n.sourceIds),
            "children": _export_collections(n.children),
        }
        for n in nodes
    ]


def _count_collections(nodes: List[Collection]) -> int:
    return len(nodes) + sum(_count_collections(n.children) for n in nodes)


def _build_collections(nodes: List[CollectionExport], source_type: str, id_map: Dict[str, str]) -> List[Collection]:
    return [
        Collection(
            name=n.name,
            description=n.description,
            icon=n.icon,
            sourceType=source_type,
            sourceIds=[id_map[sid] for sid in n.sourceIds if sid in id_map],
            children=_build_collections(n.children, source_type, id_map),
        )
        for n in nodes
    ]


@router.get("")
async def list_integrations():
    """Every integration this build knows about, each tagged with whether
    this vault has added it — the UI renders the whole catalog so it can
    offer the ones that are still available to add."""
    return {"integrations": await integrations.describe_all()}


def _clean_name(name: Optional[str]) -> Optional[str]:
    """None/blank means "no override" — the catalog default is shown instead,
    so clearing the field is a reset rather than an error."""
    if name is None:
        return None
    name = name.strip()
    if not name:
        return None
    if len(name) > _MAX_NAME:
        raise HTTPException(400, f"Name must be {_MAX_NAME} characters or fewer")
    return name


@router.post("/{integration_id}", status_code=201)
async def add_integration(integration_id: str, body: Optional[IntegrationIn] = None):
    entry = await integrations.describe(integration_id)
    if entry is None:
        raise HTTPException(404, f"Unknown integration {integration_id!r}")
    if entry["added"]:
        raise HTTPException(409, f"{entry['name']} is already added")
    integrations.add(integration_id, _clean_name(body.name if body else None))
    return await integrations.describe(integration_id)


@router.patch("/{integration_id}")
async def rename_integration(integration_id: str, body: IntegrationUpdate):
    """Rename this integration's root node in the Library.

    Only the label moves: `sourceType` (and so every collection, source and
    cached document under it) is keyed on the id, which never changes.
    """
    entry = await integrations.describe(integration_id)
    if entry is None:
        raise HTTPException(404, f"Unknown integration {integration_id!r}")
    if not entry["added"]:
        raise HTTPException(404, f"{entry['name']} is not added")
    integrations.rename(integration_id, _clean_name(body.name))
    return await integrations.describe(integration_id)


@router.get("/{integration_id}/export", response_model=IntegrationExport)
def export_integration(integration_id: str):
    """Everything this integration's Settings page shows — sources and the
    collection tree built from them — as a portable file the same vault (or
    a different one) can hand to import_integration. Deliberately not the
    document cache: the destination scans for itself, same as adding a
    source by hand does."""
    _require_added(integration_id)

    if integration_id == TELEGRAM:
        sources = [
            SourceExport(
                id=c.id, name=c.name, description=c.description,
                channel=c.channel, allowedExtensions=c.allowedExtensions,
            )
            for c in store.load_channels()
        ]
    else:
        sources = [
            SourceExport(
                id=p.id, name=p.name, description=p.description,
                url=p.url, allowedExtensions=p.allowedExtensions, refreshMinutes=p.refreshMinutes,
            )
            for p in store.load_playlists()
        ]

    return IntegrationExport(
        sourceType=integration_id,
        integrationName=integrations.name_for(integration_id),
        sources=sources,
        collections=_export_collections(_collections_for(integration_id)),
    )


@router.post("/{integration_id}/import")
def import_integration(integration_id: str, body: IntegrationExport):
    """The inverse of export_integration. Every source in the file is
    created fresh with a new id — ids never travel between vaults — and the
    collection tree is rebuilt against those new ids, then appended as
    additional root-level trees alongside whatever this vault already has.
    The integration's own name is not touched: renaming the destination as a
    side effect of importing someone else's file would be surprising."""
    _require_added(integration_id)
    if body.sourceType != integration_id:
        raise HTTPException(400, f"This file is for {body.sourceType}, not {integration_id}")

    id_map: Dict[str, str] = {}
    if integration_id == TELEGRAM:
        channels = store.load_channels()
        for s in body.sources:
            if not s.channel:
                raise HTTPException(400, f"Source {s.name!r} is missing its channel")
            channel = Channel(name=s.name, description=s.description, channel=s.channel, allowedExtensions=s.allowedExtensions)
            id_map[s.id] = channel.id
            channels.append(channel)
        store.save_channels(channels)
    else:
        playlists = store.load_playlists()
        for s in body.sources:
            if not s.url:
                raise HTTPException(400, f"Source {s.name!r} is missing its URL")
            refresh_minutes = s.refreshMinutes
            if refresh_minutes is not None:
                refresh_minutes = max(MIN_REFRESH_MINUTES, min(MAX_REFRESH_MINUTES, refresh_minutes))
            playlist = Playlist(
                name=s.name, description=s.description, url=s.url,
                allowedExtensions=s.allowedExtensions, refreshMinutes=refresh_minutes,
            )
            id_map[s.id] = playlist.id
            playlists.append(playlist)
        store.save_playlists(playlists)

    new_roots = _build_collections(body.collections, integration_id, id_map)
    collections = store.load_collections()
    collections.extend(new_roots)
    store.save_collections(collections)

    return {"sourcesAdded": len(body.sources), "collectionsAdded": _count_collections(new_roots)}


@router.delete("/{integration_id}", status_code=204)
async def remove_integration(integration_id: str):
    """Removing is refused while the integration still holds anything.

    Deliberately no `force`: unlike deleting one channel, this would cascade
    across every source *and* a whole collection tree. Whoever wants that
    should delete those first and see what they're losing.
    """
    entry = await integrations.describe(integration_id)
    if entry is None:
        raise HTTPException(404, f"Unknown integration {integration_id!r}")
    if not entry["added"]:
        raise HTTPException(404, f"{entry['name']} is not added")

    blockers = []
    if entry["sourceCount"]:
        noun = "channel" if integration_id == "telegram" else "playlist"
        blockers.append(f"{entry['sourceCount']} {noun}(s)")
    trees = _collections_for(integration_id)
    if trees:
        blockers.append(f"{len(trees)} collection(s)")
    if blockers:
        raise HTTPException(
            409,
            f"{entry['name']} still has {' and '.join(blockers)}. Remove them first.",
        )

    integrations.remove(integration_id)
    return None
