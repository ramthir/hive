from src.domain.iptv.search import Query, parse_query


def test_words_are_title_words_and_group_is_the_category():
    assert parse_query("Heat") == Query(words=("heat",))
    assert parse_query("heat group:hollywood") == Query(("heat",), ("hollywood",))
    assert parse_query('group:"Tamil Movies" raja') == Query(("raja",), ("tamil movies",))
    assert parse_query("GROUP:Tamil group:vip") == Query((), ("tamil", "vip"))


def test_an_empty_group_is_ignored_and_nothing_is_nothing():
    assert parse_query("heat group:") == Query(("heat",))
    assert parse_query('group:"" heat') == Query(("heat",))
    assert parse_query(None) == Query() and parse_query("   ") == Query()


def test_a_word_that_only_contains_group_is_a_title_word():
    assert parse_query("subgroup:x") == Query(words=("subgroup:x",))


def test_is_starred_is_a_filter_not_a_title_word():
    assert parse_query("is:starred") == Query(starred=True)
    assert parse_query("raja IS:Starred group:tamil") == Query(("raja",), ("tamil",), True)
    assert parse_query("is:star heat") == Query(("heat",), (), True)
    assert parse_query("is:starredx this:is:starred") == Query(("is:starredx", "this:is:starred"))
