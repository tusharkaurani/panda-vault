"""Pydantic schemas shared across the API."""
import time
import uuid
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, computed_field

# The kinds of thing a collection can be filled from. Channels and playlists
# share one id space (both come from new_id()), which is what lets the
# document cache, jobs.py and cache._scope_sql stay type-agnostic.
SourceType = Literal["telegram", "m3u"]

TELEGRAM: SourceType = "telegram"
M3U: SourceType = "m3u"


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def human_size(n: float) -> str:
    for unit in ["B", "KB", "MB", "GB"]:
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


class Channel(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str
    description: str = ""
    channel: str  # username (@foo), numeric id, or t.me invite link, exactly as entered
    joined: bool = False
    allowedExtensions: List[str] = Field(default_factory=list)  # lowercase, no dot; empty = allow all
    created_at: float = Field(default_factory=time.time)


class ChannelOut(Channel):
    """Response-only shape for GET /api/channels — adds the computed, non
    -persisted cache state the UI shows next to a channel's name."""

    fileCount: int = 0
    # not_joined | unscanned | scanning | rebuilding | ready | empty | error
    status: str = "unscanned"


class ChannelIn(BaseModel):
    name: str
    description: str = ""
    channel: str
    allowedExtensions: List[str] = Field(default_factory=list)


class ChannelUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    channel: Optional[str] = None
    allowedExtensions: Optional[List[str]] = None


class Playlist(BaseModel):
    """An M3U playlist — the m3u source type's equivalent of a Channel.

    Deliberately a separate model rather than a `type` field on Channel:
    the two barely overlap (joined/channel ref vs. a plain URL), and
    keeping them apart leaves every existing Telegram code path, and
    channels.json itself, untouched.

    Unlike a channel there is nothing to join and no incremental cursor —
    a playlist is one HTTP response, so every refresh replaces the whole
    snapshot (see cache.replace_source_documents).
    """

    id: str = Field(default_factory=new_id)
    name: str
    description: str = ""
    url: str  # remote .m3u / .m3u8, exactly as entered
    allowedExtensions: List[str] = Field(default_factory=list)  # matched against the stream URL's extension
    # How often to re-fetch. None means the M3U_REFRESH_MINUTES default,
    # rather than a copy of it, so raising the default lifts every playlist
    # that never had an opinion.
    refreshMinutes: Optional[int] = None
    created_at: float = Field(default_factory=time.time)


class PlaylistOut(Playlist):
    """Response-only shape for GET /api/playlists — mirrors ChannelOut."""

    fileCount: int = 0
    # unscanned | scanning | rebuilding | ready | empty | error
    #   | stale | invalid | needs_review
    # The last three are playlist-only: a URL that has stopped answering,
    # one answering with something that isn't a playlist, and one whose
    # latest snapshot was refused for being far smaller than the last.
    status: str = "unscanned"

    # How the last fetch that reached the network went. None means one has
    # never been attempted, which is not the same as one having failed.
    fetchStatus: Optional[str] = None  # ok | failed | invalid | shrunk
    fetchError: Optional[str] = None
    lastOkAt: Optional[float] = None
    # Consecutive failures. 1 is a blip and stays quiet; the UI leads with
    # the problem once it climbs.
    failStreak: int = 0


# Floor and ceiling for a playlist's own refresh interval: often enough to
# be useful, never often enough to look like an attack on the provider.
MIN_REFRESH_MINUTES = 15
MAX_REFRESH_MINUTES = 60 * 24 * 7


class PlaylistIn(BaseModel):
    name: str
    description: str = ""
    url: str
    allowedExtensions: List[str] = Field(default_factory=list)
    refreshMinutes: Optional[int] = Field(
        default=None, ge=MIN_REFRESH_MINUTES, le=MAX_REFRESH_MINUTES
    )


class PlaylistUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    url: Optional[str] = None
    allowedExtensions: Optional[List[str]] = None
    refreshMinutes: Optional[int] = Field(
        default=None, ge=MIN_REFRESH_MINUTES, le=MAX_REFRESH_MINUTES
    )


class Collection(BaseModel):
    """A collection is either a container (has children) or a leaf bound to
    one or more sources (has sourceIds) — never both.

    `sourceType` is set when the collection is created and inherited by
    every descendant: a tree belongs to exactly one integration, and its
    leaves may only bind to sources of that type. Trees of different types
    sit side by side at the root, under the virtual Library node the UI
    renders."""

    id: str = Field(default_factory=new_id)
    name: str
    description: str = ""
    icon: Optional[str] = None
    sourceType: SourceType = TELEGRAM
    # Channel ids or playlist ids, according to sourceType. Read off disk as
    # the legacy `channelIds`/`channelId` — see store._migrate_source_fields.
    sourceIds: List[str] = Field(default_factory=list)
    children: List["Collection"] = Field(default_factory=list)


class CollectionIn(BaseModel):
    name: str
    description: str = ""
    icon: Optional[str] = None
    sourceIds: List[str] = Field(default_factory=list)
    parentId: Optional[str] = None  # None = create at root
    # Required at the root; inherited from the parent otherwise.
    sourceType: Optional[SourceType] = None


class CollectionUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    # Omitted = leave binding untouched. [] explicitly unbinds (becomes a container).
    sourceIds: Optional[List[str]] = None


class CollectionMove(BaseModel):
    parentId: Optional[str] = None  # None = move to root


class CollectionReorder(BaseModel):
    """Re-sorts one level of the tree. Sibling order *is* display order —
    collections.json is a plain ordered list — so this rewrites that list
    rather than storing a separate rank per node."""

    parentId: Optional[str] = None  # None = the root level
    orderedIds: List[str]
    # Root level only: which source type's roots `orderedIds` covers. The
    # root now holds one tree per integration, so a reorder that spans all
    # of them would never match a single tree's members.
    sourceType: Optional[SourceType] = None


class CollectionTreeNode(Collection):
    """Response-only shape for GET /api/collections/tree — adds computed,
    non-persisted counts on top of the stored Collection fields."""

    children: List["CollectionTreeNode"] = Field(default_factory=list)
    fileCount: int = 0
    folderCount: int = 0


class DocumentOut(BaseModel):
    """One item in a collection — a Telegram document, or an M3U stream
    entry. The m3u-only fields are None for documents and vice versa."""

    id: int
    name: str
    size: int
    date: str
    mime_type: Optional[str] = None
    # Set by the cache query layer when returning items (it's the partition
    # key, so it's never stored per-row) — the routers rely on it to build
    # download URLs. Holds a channel id or a playlist id, per sourceType.
    sourceId: Optional[str] = None
    sourceType: SourceType = TELEGRAM
    # m3u only. `id` is then the entry's 1-based ordinal within the playlist
    # snapshot rather than a Telegram message id, and `size` is 0 — a stream
    # has no length to report.
    url: Optional[str] = None
    logo: Optional[str] = None
    group: Optional[str] = None
    # m3u only, and None for anything without a URL to probe. Joined in at
    # query time from stream_health, which is keyed by URL rather than by
    # entry — a playlist refresh renumbers every entry, so a per-row status
    # would not survive the night. "unchecked" means no probe has happened
    # yet, which reads differently from one that came back unreachable.
    health: Optional[str] = None  # available | unavailable | unknown | unchecked
    healthCheckedAt: Optional[float] = None

    @computed_field
    @property
    def size_human(self) -> str:
        """Derived, never stored: persisting it cost ~12% of the old JSON
        cache for a string that's a pure function of `size`. Still emitted
        in every response, so the API contract is unchanged."""
        return human_size(self.size)


class PhoneIn(BaseModel):
    phone: str


class CodeIn(BaseModel):
    code: str


class PasswordIn(BaseModel):
    password: str


Collection.model_rebuild()
CollectionTreeNode.model_rebuild()
