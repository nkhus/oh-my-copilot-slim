---
name: codemap
description: Generate or incrementally update a hierarchical repository map (per-folder codemap.md files plus a root atlas) so agents can navigate unfamiliar code quickly. Use when asked to map, document, or understand a repository's structure.
---

<!-- Adapted from alvinunreal/oh-my-opencode-slim (MIT): src/skills/codemap/SKILL.md. The upstream Node script was replaced with git-based change detection. See NOTICE. -->

# Codemap

Builds a navigable map of the repository:

- `codemap.md` in each significant folder - what lives there and how it
  connects
- a root `codemap.md` atlas linking the folder maps
- `.slim/codemap.json` - state used for incremental updates

## State file

`.slim/codemap.json`:

```json
{
  "version": 2,
  "mappedCommit": "<git commit SHA the maps describe>",
  "folders": ["src", "src/agents"]
}
```

If the file has an older format (for example upstream's `file_hashes`), or
the repository is not a git repository, treat it as missing and do a full
run.

## Full run (no state)

1. **Select folders.** List tracked files (`git ls-files`, or glob when not
   a git repo). Skip generated, vendored, and dependency folders (e.g.
   `node_modules`, `dist`, `build`, `vendor`, `.git`, lockfile-only dirs).
   Map folders that contain source or meaningful config; merge tiny leaf
   folders into their parent's map.
2. **Write folder maps.** For each selected folder write `codemap.md`
   (delegate parallel batches to `fixer` when the orchestrator is
   available; each fixer owns a disjoint set of folders):

   ```markdown
   # <folder path>

   ## Responsibility
   One or two sentences on what this folder is for.

   ## Design
   Key patterns, abstractions, and conventions used here.

   ## Flow
   How control/data moves through the main entry points.

   ## Integration
   What it depends on and what depends on it (with paths).
   ```

   Base every statement on files you actually read. Keep each map short.
3. **Write the root atlas** `codemap.md`: a one-paragraph project summary,
   then a table of folders -> one-line responsibility -> link to the
   folder's `codemap.md`, plus the main entry points.
4. **Register the map** in `AGENTS.md` (create it if missing) with a
   section, replacing any previous one:

   ```markdown
   ## Repository Map
   Start with `codemap.md` (root atlas), then the folder-level
   `codemap.md` files it links to.
   ```
5. **Save state:** write `.slim/codemap.json` with the current
   `git rev-parse HEAD` and the mapped folder list.

## Incremental run (state present)

1. `git diff --name-status <mappedCommit> HEAD` plus
   `git status --porcelain` for uncommitted changes.
2. Map each changed path to its nearest mapped folder. Added folders
   with meaningful source become new mapped folders; deleted folders drop
   their maps.
3. Rewrite only the affected folder maps, then update the root atlas rows
   for those folders.
4. Update `mappedCommit` and `folders`.

If `mappedCommit` no longer exists (rebased history), do a full run.

## Rules
- Don't map secrets or copy sensitive values into maps.
- Prefer accuracy over coverage: omit what you haven't verified.
- Commit the maps only if the user asks.
