"""The integration catalog — what this vault could connect, and what it has.

Not Telegram-gated: the catalog is exactly what an install with no Telegram
account needs to read in order to add its first integration.
"""
from fastapi import APIRouter, HTTPException

from .. import integrations, store

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


def _collections_for(integration_id: str):
    return [n for n in store.load_collections() if n.sourceType == integration_id]


@router.get("")
async def list_integrations():
    """Every integration this build knows about, each tagged with whether
    this vault has added it — the UI renders the whole catalog so it can
    offer the ones that are still available to add."""
    return {"integrations": await integrations.describe_all()}


@router.post("/{integration_id}", status_code=201)
async def add_integration(integration_id: str):
    entry = await integrations.describe(integration_id)
    if entry is None:
        raise HTTPException(404, f"Unknown integration {integration_id!r}")
    if entry["added"]:
        raise HTTPException(409, f"{entry['name']} is already added")
    integrations.add(integration_id)
    return await integrations.describe(integration_id)


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
