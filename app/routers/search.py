from typing import List

from fastapi import APIRouter, Query

from .. import store
from ..ext_filter import filter_by_extensions
from ..models import Collection
from ..telegram_client import list_documents

router = APIRouter(prefix="/api/search", tags=["search"])


def _walk_channel_collections(nodes: List[Collection]):
    for n in nodes:
        if n.channelIds:
            yield n
        if n.children:
            yield from _walk_channel_collections(n.children)


@router.get("")
async def search(q: str = Query(..., min_length=1)):
    collections = store.load_collections()
    channels = {c.id: c for c in store.load_channels()}
    needle = q.lower()
    results = []

    for collection in _walk_channel_collections(collections):
        for channel_id in collection.channelIds:
            channel = channels.get(channel_id)
            if not channel:
                continue
            try:
                docs = await list_documents(channel.id, channel.channel)
            except RuntimeError:
                continue
            docs = filter_by_extensions(docs, channel.allowedExtensions)
            for d in docs:
                if needle in d.name.lower():
                    d.channelId = channel.id
                    results.append({"collection": collection, "channel": channel, "document": d})

    return {"query": q, "results": results}
