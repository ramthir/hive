"""A live channel's name without the provider's noise.

Providers put a country or provider tag in front of a name ("US: TNT", "IND: TG: SAKSHI TV", "Af | DSTV: Moja Love"), the
quality word after it ("BBC One HD"), a star at the end and sometimes a bracketed note ("Hindu Dharmam ( Spiritual )").
The stored name is left as the provider sent it, because a sync brings it back; this is applied when a channel is read.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# Prefixes of three to five letters that really are a country or provider tag. Others ("NCIS:", "CSI:", "F1TV:") belong to a name.
_PREFIXES = frozenset({
    "IND", "ARG", "BIH", "UKR", "AFG", "SUR", "CAR", "BHR", "PAK", "PAKI", "TJK", "ISL", "USA", "LAO", "DSTV", "KIDS", "DOC",
    "CRI", "ININD", "IIND", "XXX", "XXM", "NPL", "NPL-LOC", "VIP-XXX",
})
_LEADING_SYMBOLS = re.compile(r"^[\s•●★✦|*&\-–—_]+")
_PREFIX = re.compile(r"^([A-Za-z]{2}(?![A-Za-z])|[A-Za-z]{2,5}(?:[-_][A-Za-z0-9]{1,8})?|\d{1,2}/\d{1,2})\s*[:|]\s*")
_SUBPREFIX = re.compile(r"^[A-Za-z][A-Za-z0-9]{1,11}\s*[:|]\s*")
_QUALITY = {"4K": "4K", "UHD": "4K", "2160P": "4K", "FHD": "FHD", "1080P": "FHD", "1080": "FHD", "HD": "HD", "720P": "HD", "720": "HD", "SD": "SD"}
_TRAILING_QUALITY = re.compile(r"\s+(4K|UHD|2160P?|FHD|1080P?|HD|720P?|SD)\s*$", re.IGNORECASE)
_TRAILING_NOTE = re.compile(r"\s*\(\s*([^()]{2,24}?)\s*\)\s*$")
_TRAILING_STAR = re.compile(r"\s*\*+\s*$")
_TRAILING_DECORATION = re.compile(r"[\s•●★✦*\-–—_]+$")
_YEAR = re.compile(r"^(?:19|20)\d{2}$")


@dataclass(frozen=True)
class CleanName:
    name: str
    quality: str = ""  # 4K, FHD, HD or SD, or empty
    note: str = ""  # a bracketed note at the end of the name, such as "Spiritual"


def _prefix_length(text: str) -> int:
    match = _PREFIX.match(text)
    if not match:
        return 0
    word = match.group(1).upper()
    # Two letters ("US:", "Af |"), a hyphenated code ("IN-MAL |") and a day count ("24/7:") are tags; longer words only when known.
    is_tag = bool(re.fullmatch(r"[A-Z]{2}", word)) or word[0].isdigit() or "-" in word or "_" in word or word in _PREFIXES
    return match.end() if is_tag else 0


def _quality_of(word: str) -> str:
    word = word.upper()
    return "4K" if word in ("2160", "2160P") else _QUALITY.get(word, "")


def clean_channel_name(name: str | None) -> CleanName:
    """The name a viewer should see, with its quality and note apart. A name that would be left empty is returned as it was."""
    original = (name or "").strip()
    text = _LEADING_SYMBOLS.sub("", original)
    first = _prefix_length(text)
    if first:
        text = text[first:]
        for _ in range(2):
            sub = _SUBPREFIX.match(text)
            if not sub:
                break
            text = text[sub.end():]
    quality = note = ""
    for _ in range(3):
        before = text
        text = _TRAILING_STAR.sub("", text)
        bracket = _TRAILING_NOTE.search(text)
        # A year in brackets ("(2026)") is part of the name, not a note.
        if bracket and not _YEAR.match(bracket.group(1)):
            inner = bracket.group(1).upper()
            if inner in _QUALITY:
                quality = quality or _QUALITY[inner]
            else:
                note = note or bracket.group(1)
            text = text[: bracket.start()]
        tail = _TRAILING_QUALITY.search(text)
        rest = text[: tail.start()] if tail else ""
        # A name that is only a quality word, or a prefix left with a quality, keeps it as the name.
        if tail and re.search(r"[^\s:|]{2}", rest) and not re.search(r"[:|]\s*$", rest):
            quality = quality or _quality_of(tail.group(1))
            text = rest
        if text == before:
            break
    # A banner such as "•●★--- Welcome ----★●•" loses its decoration at both ends.
    text = re.sub(r"\s+", " ", _TRAILING_DECORATION.sub("", text)).strip()
    if not text:
        return CleanName(name=original)
    return CleanName(name=text, quality=quality, note=note)
