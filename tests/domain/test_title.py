from src.domain.notes.title import extract_h1, set_h1, with_h1


def test_extract_first_nonblank_line_only():
    assert extract_h1("# Title\n\nbody") == "Title"
    assert extract_h1("\n\n#   Spaced   Title  \nbody") == "Spaced   Title"
    assert extract_h1("# Closed ##\n") == "Closed"
    assert extract_h1("#\nbody") == ""  # a bare '#': heading present, title empty
    for none in ["", "   \n", "plain text\n# Later heading", "## Level two", "#nospace", "    # indented code"]:
        assert extract_h1(none) is None


def test_set_h1_replaces_or_inserts():
    assert set_h1("# Old\n\nbody", "New") == "# New\n\nbody"
    assert set_h1("body line\n", "New") == "# New\n\nbody line\n"
    assert set_h1("\n\nbody", "New") == "# New\n\nbody"
    assert set_h1("", "New") == "# New\n"
    assert set_h1("## Sub heading\ntext", "New") == "# New\n\n## Sub heading\ntext"


def test_with_h1_only_inserts_when_missing():
    assert with_h1("T", "# Own\nx") == "# Own\nx"
    assert with_h1("T", "x") == "# T\n\nx"
