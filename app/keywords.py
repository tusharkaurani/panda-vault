"""Top-keyword extraction from cached document filenames.

Powers the pill row shown under a collection's search bar ("Economist",
"Vogue", "Chennai", ...) — a cheap way to surface what a collection is
mostly made of without the user having to search first.

Deliberately simple word-frequency counting over filenames already sitting
in `cache.json` (no live Telegram calls, no NLP dependency): magazine/
newspaper/book dumps are highly repetitive by nature (the same publication
name recurs in every issue's filename), so plain unigram counts with a
small stopword/noise filter surface the right words with very little code.
See the README for the fuller rationale if this ever needs revisiting
(e.g. multi-word publication names like "India Today" currently surface
as two separate pills, "india" and "today" — acceptable today since pills
feed the existing substring `search` box either way).
"""
import re
from collections import Counter
from typing import List, TypedDict

_EXT_RE = re.compile(r"\.[A-Za-z0-9]{2,5}$")
# Split on anything that isn't a letter/digit — including underscore, which
# `\w` alone treats as a word character but which filenames use as a plain
# separator just as often as space/dash/dot (e.g. "bl.bl_mumbai.13_08_2026").
_TOKEN_RE = re.compile(r"[\W_]+", flags=re.UNICODE)

_MIN_TOKEN_LEN = 3

_STOPWORDS = {
    # English function words
    "the", "of", "and", "for", "a", "an", "in", "on", "at", "to", "with",
    "from", "by", "is", "are", "was", "were", "this", "that", "or", "as",
    # Structural/edition noise that isn't a meaningful search keyword
    "vol", "volume", "no", "num", "issue", "edition", "ed", "part",
    "weekly", "monthly", "daily", "new",
    # File-format leftovers (belt-and-suspenders; extension is stripped
    # before tokenizing, but covers stray "xyz.pdf.pdf"-style names)
    "pdf", "epub", "mobi", "fb2", "www", "com",
    # Month names/abbreviations — nearly every filename has one, and they
    # carry no publication-identifying signal
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
    "nov", "dec", "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
}


class KeywordCount(TypedDict):
    word: str
    count: int


def top_keywords(names: List[str], limit: int = 8) -> List[KeywordCount]:
    counter: Counter = Counter()
    for name in names:
        stem = _EXT_RE.sub("", name)
        for token in _TOKEN_RE.split(stem.lower()):
            if len(token) < _MIN_TOKEN_LEN:
                continue
            if token.isdigit():
                continue
            if token in _STOPWORDS:
                continue
            counter[token] += 1
    return [{"word": w, "count": c} for w, c in counter.most_common(limit)]
