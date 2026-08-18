from typing import List, Optional

from fastapi import APIRouter, HTTPException

from .. import cache, store
from ..models import (
    Collection,
    CollectionIn,
    CollectionMove,
    CollectionReorder,
    CollectionTreeNode,
    CollectionUpdate,
)

router = APIRouter(prefix="/api/collections", tags=["collections"])


def _find(nodes: List[Collection], collection_id: str) -> Optional[Collection]:
    for n in nodes:
        if n.id == collection_id:
            return n
        if n.children:
            found = _find(n.children, collection_id)
            if found:
                return found
    return None


def _find_parent_list(nodes: List[Collection], collection_id: str) -> Optional[List[Collection]]:
    if any(n.id == collection_id for n in nodes):
        return nodes
    for n in nodes:
        if n.children:
            res = _find_parent_list(n.children, collection_id)
            if res is not None:
                return res
    return None


def _is_descendant(node: Collection, target_id: str) -> bool:
    for c in node.children:
        if c.id == target_id or _is_descendant(c, target_id):
            return True
    return False


def _with_counts(nodes: List[Collection], counts: dict) -> List[CollectionTreeNode]:
    out = []
    for n in nodes:
        children = _with_counts(n.children, counts)
        if n.channelIds:
            file_count = sum(counts.get(cid) or 0 for cid in n.channelIds)
        else:
            file_count = sum(c.fileCount for c in children)
        out.append(
            CollectionTreeNode(
                **n.model_dump(exclude={"children"}),
                children=children,
                fileCount=file_count,
                folderCount=len(n.children),
            )
        )
    return out


@router.get("/tree", response_model=List[CollectionTreeNode])
def get_tree():
    collections = store.load_collections()
    channels = store.load_channels()
    # One grouped count for every channel up front. This endpoint is on the
    # hot path — reloaded on every collection navigation — and previously
    # walked each bound channel's entire filename list per node just to
    # produce one integer each.
    counts = cache.channel_counts([(c.id, c.allowedExtensions) for c in channels])
    return _with_counts(collections, counts)


@router.post("", response_model=Collection, status_code=201)
def create_collection(body: CollectionIn):
    collections = store.load_collections()
    node = Collection(name=body.name, description=body.description, icon=body.icon, channelIds=body.channelIds)

    if body.parentId:
        parent = _find(collections, body.parentId)
        if not parent:
            raise HTTPException(404, "Parent collection not found")
        if parent.channelIds:
            raise HTTPException(400, "Cannot add a sub-collection to a channel-bound collection")
        parent.children.append(node)
    else:
        collections.append(node)

    store.save_collections(collections)
    return node


@router.put("/{collection_id}", response_model=Collection)
def update_collection(collection_id: str, body: CollectionUpdate):
    collections = store.load_collections()
    node = _find(collections, collection_id)
    if not node:
        raise HTTPException(404, "Collection not found")

    data = body.model_dump(exclude_unset=True)
    if "name" in data:
        node.name = data["name"]
    if "description" in data:
        node.description = data["description"]
    if "icon" in data:
        node.icon = data["icon"]
    if "channelIds" in data:
        channel_ids = data["channelIds"] or []
        if channel_ids and node.children:
            raise HTTPException(400, "Cannot bind channels to a collection that has sub-collections")
        node.channelIds = channel_ids

    store.save_collections(collections)
    return node


@router.delete("/{collection_id}", status_code=204)
def delete_collection(collection_id: str):
    collections = store.load_collections()
    parent_list = _find_parent_list(collections, collection_id)
    if parent_list is None:
        raise HTTPException(404, "Collection not found")
    parent_list[:] = [n for n in parent_list if n.id != collection_id]
    store.save_collections(collections)
    return None


@router.post("/reorder", status_code=204)
def reorder_collections(body: CollectionReorder):
    """Rewrite the sibling order of one level. `orderedIds` must be exactly a
    permutation of that level's current members — anything else means the
    caller is working from a tree that has since changed (a collection added,
    deleted or moved from another tab), and applying a partial order would
    silently drop or duplicate nodes."""
    collections = store.load_collections()

    if body.parentId:
        parent = _find(collections, body.parentId)
        if not parent:
            raise HTTPException(404, "Parent collection not found")
        siblings = parent.children
    else:
        siblings = collections

    by_id = {n.id: n for n in siblings}
    if len(body.orderedIds) != len(siblings) or set(body.orderedIds) != set(by_id):
        raise HTTPException(409, "Collection order is out of date — reload and try again")

    siblings[:] = [by_id[cid] for cid in body.orderedIds]
    store.save_collections(collections)
    return None


@router.post("/{collection_id}/move", response_model=Collection)
def move_collection(collection_id: str, body: CollectionMove):
    collections = store.load_collections()
    node = _find(collections, collection_id)
    if not node:
        raise HTTPException(404, "Collection not found")
    if body.parentId == collection_id:
        raise HTTPException(400, "Cannot move a collection into itself")
    if body.parentId and _is_descendant(node, body.parentId):
        raise HTTPException(400, "Cannot move a collection into its own descendant")

    parent_list = _find_parent_list(collections, collection_id)
    parent_list[:] = [n for n in parent_list if n.id != collection_id]

    if body.parentId:
        target = _find(collections, body.parentId)
        if not target:
            raise HTTPException(404, "Target parent collection not found")
        if target.channelIds:
            raise HTTPException(400, "Cannot move into a channel-bound collection")
        target.children.append(node)
    else:
        collections.append(node)

    store.save_collections(collections)
    return node
