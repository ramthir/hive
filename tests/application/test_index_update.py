"""`NoteIndex.updated` must equal a fresh `NoteIndex` over the same notes, whatever changed."""
import random
from dataclasses import replace

from src.application.notes.index import NoteIndex
from src.domain.notes.entities import Note

TITLES = ["Alpha", "Beta", "Gamma", "Dup", "Dup", "Delta: One", "Delta One"]


def make(slug, title, links=()):
    body = " ".join(f"[[{t}]]" for t in links)
    return Note(slug=slug, title=title, content=f"# {title}\n\n{body}", tags=("t",), types=("task",))


def snapshot(index):
    ordered = list(index.notes)
    return {
        "order": ordered,
        "notes": index.notes,
        "links": {s: index.links_from(s) for s in ordered},
        "back": {s: [n.slug for n in index.backlinks(s)] for s in ordered},
        "unresolved": index.unresolved,
        "ambiguous": index.ambiguous,
        "tags": index.tags(),
        "types": index.types(),
        "resolve": {t: index.resolve(t) for t in TITLES + ["nope", "alpha", "delta-one"]},
    }


def test_removing_a_note_keeps_links_to_it_unresolved():
    notes = [make("a", "Alpha", ["Beta"]), make("b", "Beta", ["Alpha"])]
    index = NoteIndex(notes).updated([], removed=["b"])
    assert index.unresolved == {"a": ["Beta"]}
    assert index.backlinks("a") == []
    assert snapshot(index) == snapshot(NoteIndex(notes[:1]))


def test_editing_content_only_relinks_that_note():
    notes = [make("a", "Alpha", ["Beta"]), make("b", "Beta")]
    edited = make("b", "Beta", ["Alpha", "Gamma"])
    index = NoteIndex(notes).updated([edited])
    assert snapshot(index) == snapshot(NoteIndex([notes[0], edited]))
    assert index.unresolved == {"b": ["Gamma"]}


def test_a_new_title_resolves_links_that_were_broken():
    notes = [make("a", "Alpha", ["Gamma"])]
    index = NoteIndex(notes)
    assert index.unresolved == {"a": ["Gamma"]}
    patched = index.updated([make("g", "Gamma")])
    assert patched.unresolved == {}
    assert [n.slug for n in patched.backlinks("g")] == ["a"]


def test_the_old_index_is_not_modified():
    notes = [make("a", "Alpha", ["Beta"]), make("b", "Beta")]
    index = NoteIndex(notes)
    before = snapshot(index)
    index.updated([make("a", "Alpha", [])], removed=["b"])
    assert snapshot(index) == before


def test_random_edits_match_a_fresh_index():
    rng = random.Random(7)
    slugs = [f"n{i}" for i in range(12)]
    notes = {s: make(s, rng.choice(TITLES), rng.sample(TITLES, 2)) for s in slugs[:8]}
    index = NoteIndex(sorted(notes.values(), key=lambda n: f"{n.slug}.md"))
    for step in range(300):
        changed, removed = [], []
        for slug in rng.sample(slugs, rng.randint(1, 3)):
            if slug in notes and rng.random() < 0.3:
                del notes[slug]
                removed.append(slug)
            else:
                notes[slug] = make(slug, rng.choice(TITLES) if rng.random() < 0.5 else notes.get(slug, make(slug, "Alpha")).title,
                                   rng.sample(TITLES + ["n1", "n2"], rng.randint(0, 3)))
                changed.append(notes[slug])
        removed = [s for s in removed if s not in notes]
        index = index.updated(changed, removed)
        fresh = NoteIndex(sorted(notes.values(), key=lambda n: f"{n.slug}.md"))
        assert snapshot(index) == snapshot(fresh), f"diverged at step {step}"
