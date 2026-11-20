# Hive

File-backed notes app: markdown files in `NOTES_DIR` (default `~/Workspace/notes`), versioned with git (one commit per save/rename/delete). Based on ~/Workspace/pandora's notes feature, without the database.

- Tests: `uv run pytest` (single file: `uv run pytest tests/<path>`)
- Every new feature needs automated tests next to the existing ones in `tests/`.
- Layers: `src/domain` (entities, ports) -> `src/application` -> `src/infrastructure` (git, fs_notes) -> `src/api`.
- Note identity is the filename slug. Frontmatter (`title`, `tags`, `created`, `updated`) is round-tripped with ruamel so diffs stay minimal.
- Never run tests against the real notes dir; use temp git repos.

## Performance monitoring
- Live: `GET /api/metrics` -> counters (`watcher_batches`, `watcher_events`, `index_invalidations`), timings (`index_rebuild`, `git_commit`: count/avg/max ms) and process stats (`cpu_s`, `rss_kb`, `threads`). Poll `cpu_s` twice to get CPU use over an interval.
- Benchmark: `uv run python scripts/bench.py <COPY of notes> [--with-hook] [--no-watch]` (edits files and commits: use a copy).
- Design: the watcher (watchfiles/inotify, `step=250ms`, `debounce=400ms`) only invalidates the index; it is rebuilt lazily on the next request, so bursts coalesce into one rebuild and an idle app does nothing.
- `commit --only` runs hooks on a temp index, so `GitClient.commit_paths` re-syncs the real index afterwards; do not remove that or formatter hooks leave phantom staged changes.

## Running
`NOTES_DIR=~/Workspace/notes uv run python main.py` serves on port 80 (needs `net.ipv4.ip_unprivileged_port_start` <= 80 or root). Binds 0.0.0.0 by default and there is no auth, so anyone who can reach the port can edit notes; `HOST=127.0.0.1` limits it to this machine. `PORT` overrides the port. Every save is a real git commit in `NOTES_DIR`.
