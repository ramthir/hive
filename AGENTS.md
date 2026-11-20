# Hive

File-backed notes app: markdown files in `NOTES_DIR` (default `~/Workspace/notes`), versioned with git (one commit per save/rename/delete). Based on ~/Workspace/pandora's notes feature, without the database.

- Tests: `uv run pytest` (single file: `uv run pytest tests/<path>`)
- Every new feature needs automated tests next to the existing ones in `tests/`.
- Layers: `src/domain` (entities, ports) -> `src/application` -> `src/infrastructure` (git, fs_notes) -> `src/api`.
- Note identity is the filename slug. Frontmatter (`title`, `tags`, `created`, `updated`) is round-tripped with ruamel so diffs stay minimal.
- Never run tests against the real notes dir; use temp git repos.
