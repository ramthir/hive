from src.domain.notes.meetings import count_action_items


def test_counts_action_items_across_sections_and_ignores_code_fences():
    content = """# Meeting

## Decisions
- [ ] Not an action item

## ✅ Action Items
- [x] Done item
- [ ] Open item
- Unboxed item
1. Numbered item
  - [ ] Nested item is ignored

```markdown
## Action Items
- [ ] Fenced item
```

## Open Questions
- Any blockers?
"""
    summary = count_action_items(content)
    assert summary.done == 1
    assert summary.total == 4
    assert summary.pending == 3


def test_empty_when_no_action_items_section():
    assert count_action_items("# Meeting\n\n## Notes\n- Just notes\n") == count_action_items("")
    summary = count_action_items("# Meeting\n")
    assert (summary.done, summary.total, summary.pending) == (0, 0, 0)
