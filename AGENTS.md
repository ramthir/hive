# Hive

File-backed notes app: markdown files in `NOTES_DIR` (default `~/Workspace/notes`), versioned with git (one commit per save/rename/delete). Based on ~/Workspace/pandora's notes feature, without the database.

- Tests: `uv run pytest` (single file: `uv run pytest tests/<path>`)
- Every new feature needs automated tests next to the existing ones in `tests/`.
- Layers: `src/domain` (entities, ports) -> `src/application` -> `src/infrastructure` (git, fs_notes) -> `src/api`.
- A note's title is its first `# heading`; its file name is the kebab-case of that title (never set by hand). Changing the heading renames the file (service rewrites `[[slug]]`/`[[Title]]` links). Notes whose file has no heading show the frontmatter title as one until saved. `/` and `/notes` open the most recently edited note: there is no list page.
- Note identity is the filename slug. Frontmatter (`title`, `tags`, `created`, `updated`) is round-tripped with ruamel so diffs stay minimal.
- Never run tests against the real notes dir; use temp git repos.

## Performance monitoring
- Live: `GET /api/metrics` -> counters (`watcher_batches`, `watcher_events`, `index_invalidations`), timings (`index_rebuild`, `git_commit`: count/avg/max ms) and process stats (`cpu_s`, `rss_kb`, `threads`). Poll `cpu_s` twice to get CPU use over an interval.
- Benchmark: `uv run python scripts/bench.py <COPY of notes> [--with-hook] [--no-watch]` (edits files and commits: use a copy).
- Design: the watcher (watchfiles/inotify, `step=250ms`, `debounce=400ms`) only invalidates the index; it is rebuilt lazily on the next request, so bursts coalesce into one rebuild and an idle app does nothing.
- `commit --only` runs hooks on a temp index, so `GitClient.commit_paths` re-syncs the real index afterwards; do not remove that or formatter hooks leave phantom staged changes.

## Running
`NOTES_DIR=~/Workspace/notes uv run python main.py` serves on port 80 (needs `net.ipv4.ip_unprivileged_port_start` <= 80 or root). Binds 0.0.0.0 by default and there is no auth, so anyone who can reach the port can edit notes; `HOST=127.0.0.1` limits it to this machine. `PORT` overrides the port. Every save is a real git commit in `NOTES_DIR`.

## PlantUML previews
Fenced ```plantuml / ```puml blocks render as images in the preview. `DiagramService` (`src/application/diagrams`) runs `java -jar plantuml.jar -pipe -tsvg` per diagram (~200 ms) under `PLANTUML_SECURITY_PROFILE=SANDBOX`, so the renderer itself reads no files and opens no URLs; `!include <file>.puml` is inlined by us, only from `NOTES_DIR` and never outside it, and `!include monokai-theme.puml` / `!theme monokai-pro` always use the bundled theme (as in Pandora). Results are cached by source hash. The SVG is shown through an `<img>` data URL, never inline, so a diagram cannot run script.
Setup (no root needed): a JRE (`mise install java@temurin-21`) and `plantuml.jar` in `~/.local/share/hive/plantuml/` (verify the SHA-256 GitHub publishes for the release), then `PLANTUML_JAVA` / `PLANTUML_JAR` in `.env`. Without them the code block stays and a message says why.
Graphviz (`apt-get install graphviz`, needs root) is needed for the theme's boxed connectors: PlantUML still draws class/component diagrams without it, but with a layout that ignores `LineType ortho`, so lines come out diagonal. `/api/diagram/status` reports `graphviz`, and a real-Java test fails if it is missing. Mindmaps do not use Graphviz; their connectors are always curved.

## Frontmatter conventions (match the vault)
`tags` is an inline list (`tags: [a, b]`); `type` is a single value (`type: task`), or an inline list when a note has several. Hive reads block lists, inline lists and scalars, and only rewrites `tags`/`type` when they actually change; a changed value is written in the convention above. Types map to icons in `static/type-icons.js` (add a vault type there; `tests/js/type-icons.test.mjs` fails if a name is not in the vendored Font Awesome).
