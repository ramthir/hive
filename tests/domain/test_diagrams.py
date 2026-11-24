from src.domain.notes.diagrams import plantuml_blocks


def test_blocks_in_order_with_other_fences_ignored():
    text = "# T\n```plantuml\n@startuml\nA -> B\n@enduml\n```\n```python\nx = 1\n```\n~~~puml\n@startuml\nC -> D\n@enduml\n~~~\n"
    assert plantuml_blocks(text) == ["@startuml\nA -> B\n@enduml", "@startuml\nC -> D\n@enduml"]


def test_a_plantuml_fence_inside_another_fence_is_code():
    assert plantuml_blocks("````md\n```plantuml\nA\n```\n````\n") == []


def test_empty_fence_counts_so_numbers_match_the_page():
    assert plantuml_blocks("```plantuml\n```\n```plantuml\nB\n```") == ["", "B"]
    assert plantuml_blocks("") == []
