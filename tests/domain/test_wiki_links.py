from src.domain.notes.wiki_links import extract_targets, rewrite_targets


def test_extract_forms():
    assert extract_targets("[[a]] and [[B c|Label]]") == ["a", "B c"]


def test_skips_code_and_escapes():
    text = "`[[inline]]`\n```\n[[fenced]]\n```\n    [[indented]]\n\\[[escaped]] [[real]]\n"
    assert extract_targets(text) == ["real"]


def test_rewrite_keeps_label_and_skips_code():
    text = "[[old]] [[old|Lbl]] [[other]] `[[old]]`\n```\n[[old]]\n```\n"
    out = rewrite_targets(text, lambda t: "new" if t == "old" else None)
    assert out == "[[new]] [[new|Lbl]] [[other]] `[[old]]`\n```\n[[old]]\n```\n"


def test_empty():
    assert extract_targets("") == [] and rewrite_targets("", lambda t: "x") == ""


def test_diagram_embeds_are_links_to_their_note():
    text = "![A](/notes/plan/diagram.svg?n=2) ![B](/notes/other/diagram.png)\n`![](/notes/code/diagram.svg)`\n```\n![](/notes/fenced/diagram.svg)\n```\n"
    assert extract_targets(text) == ["plan", "other"]


def test_rewrite_follows_a_renamed_embed_but_only_by_slug():
    text = "![A](/notes/old/diagram.svg?n=2) [[old]] ![B](/notes/other/diagram.svg)\n```\n![](/notes/old/diagram.svg)\n```\n"
    mapping = lambda t: "new-name" if t == "old" else ("New Title" if t == "x" else None)
    assert rewrite_targets(text, mapping) == "![A](/notes/new-name/diagram.svg?n=2) [[new-name]] ![B](/notes/other/diagram.svg)\n```\n![](/notes/old/diagram.svg)\n```\n"
    assert rewrite_targets("![](/notes/x/diagram.svg)", mapping) == "![](/notes/x/diagram.svg)"  # a title is not an address
