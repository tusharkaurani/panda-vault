"""Per-channel file-extension allowlist filtering.

A channel's `allowedExtensions` (Settings → Channels, pill UI) restricts
which documents ever surface in the document list / search / counts for
that channel. Empty list = no restriction, show everything.
"""
from typing import List

from .models import DocumentOut


def _ext_matches(name: str, allowed_set: set) -> bool:
    return "." in name and name.rsplit(".", 1)[-1].lower() in allowed_set


def filter_by_extensions(docs: List[DocumentOut], allowed: List[str]) -> List[DocumentOut]:
    if not allowed:
        return docs
    allowed_set = {ext.lower().lstrip(".") for ext in allowed}
    return [d for d in docs if _ext_matches(d.name, allowed_set)]


def filter_names_by_extensions(names: List[str], allowed: List[str]) -> List[str]:
    """Same allowlist semantics as filter_by_extensions, but for callers that
    only have raw filenames (e.g. cache.get_cached_names) — avoids building a
    DocumentOut per doc when only the name is needed (counting, keyword
    extraction, etc.)."""
    if not allowed:
        return names
    allowed_set = {ext.lower().lstrip(".") for ext in allowed}
    return [n for n in names if _ext_matches(n, allowed_set)]


def count_by_extensions(names: List[str], allowed: List[str]) -> int:
    """Like filter_names_by_extensions, but just the count — avoids building
    the intermediate filtered list for callers that only need a total."""
    return len(filter_names_by_extensions(names, allowed))
