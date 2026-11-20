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
