"""Slug rules: a slug is a flat filename stem inside the notes directory."""
from __future__ import annotations

import re

from src.domain.notes.errors import InvalidSlug

_BAD = re.compile(r'[\\/\x00-\x1f]')


def validate_slug(slug: str) -> str:
    if not slug or slug != slug.strip() or slug.startswith(".") or _BAD.search(slug) or len(slug) > 200:
        raise InvalidSlug(f"Invalid note slug: {slug!r}")
    return slug


def slugify(title: str) -> str:
    """Lower-case, hyphen-separated slug, matching the existing notes' filenames."""
    s = re.sub(r"[^\w]+", "-", title.lower(), flags=re.UNICODE).strip("-_")
    if not s:
        raise InvalidSlug(f"Cannot derive a slug from title {title!r}")
    return s
