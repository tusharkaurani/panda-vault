"""Looking up the sources a collection is bound to.

A "source" is whatever fills a leaf collection: a Telegram channel or an
M3U playlist. They live in different files and have different fields, but
share one id space and one thing the cache cares about — an id and an
extension allowlist — so everything downstream of here is type-agnostic.

Exists because the routers were each rebuilding the same
`[(id, allowedExtensions), ...]` scope by hand, three slightly different
ways, and adding a second source type would have made that four.
"""
from typing import Dict, Iterable, List, Union

from . import cache, store
from .models import TELEGRAM, Channel, Collection, Playlist, SourceType

Source = Union[Channel, Playlist]


def load_by_id(source_type: SourceType) -> Dict[str, Source]:
    """Every source of one type, keyed by id."""
    items = store.load_channels() if source_type == TELEGRAM else store.load_playlists()
    return {s.id: s for s in items}


def load_all_by_id() -> Dict[str, Source]:
    """Every source of every type, keyed by id — for the places that span
    both trees at once (global search, the collection tree's counts). Ids
    come from one generator, so they don't collide across types."""
    return {s.id: s for s in (*store.load_channels(), *store.load_playlists())}


def bound(node: Collection, sources: Dict[str, Source]) -> List[Source]:
    """The sources a leaf binds to, in binding order.

    Ids with no matching source are skipped rather than raising: a channel
    or playlist can be force-deleted out from under a collection, and the
    UI's job is to say "some bindings are missing", not to 500.
    """
    return [sources[sid] for sid in node.sourceIds if sid in sources]


def scope(sources: Iterable[Source]) -> List[cache.SourceScope]:
    """The (id, allowedExtensions) pairs every cache read query works in."""
    return [(s.id, s.allowedExtensions) for s in sources]
