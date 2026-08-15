"""Pydantic schemas shared across the API."""
import time
import uuid
from typing import List, Optional

from pydantic import BaseModel, Field


def new_id() -> str:
    return uuid.uuid4().hex[:12]


class Channel(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str
    description: str = ""
    channel: str  # username (@foo), numeric id, or t.me invite link, exactly as entered
    joined: bool = False
    allowedExtensions: List[str] = Field(default_factory=list)  # lowercase, no dot; empty = allow all
    created_at: float = Field(default_factory=time.time)


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


class Collection(BaseModel):
    """A collection is either a container (has children) or a leaf bound to
    one or more channels (has channelIds) — never both."""

    id: str = Field(default_factory=new_id)
    name: str
    description: str = ""
    icon: Optional[str] = None
    channelIds: List[str] = Field(default_factory=list)
    children: List["Collection"] = Field(default_factory=list)


class CollectionIn(BaseModel):
    name: str
    description: str = ""
    icon: Optional[str] = None
    channelIds: List[str] = Field(default_factory=list)
    parentId: Optional[str] = None  # None = create at root


class CollectionUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    # Omitted = leave binding untouched. [] explicitly unbinds (becomes a container).
    channelIds: Optional[List[str]] = None


class CollectionMove(BaseModel):
    parentId: Optional[str] = None  # None = move to root


class CollectionTreeNode(Collection):
    """Response-only shape for GET /api/collections/tree — adds computed,
    non-persisted counts on top of the stored Collection fields."""

    children: List["CollectionTreeNode"] = Field(default_factory=list)
    fileCount: int = 0
    folderCount: int = 0


class DocumentOut(BaseModel):
    id: int
    name: str
    size: int
    size_human: str
    date: str
    mime_type: Optional[str] = None
    # Set by the collection/search routers when merging docs from multiple
    # bound channels — not populated by telegram_client/cache, which stay
    # channel-agnostic.
    channelId: Optional[str] = None


class PhoneIn(BaseModel):
    phone: str


class CodeIn(BaseModel):
    code: str


class PasswordIn(BaseModel):
    password: str


Collection.model_rebuild()
CollectionTreeNode.model_rebuild()
