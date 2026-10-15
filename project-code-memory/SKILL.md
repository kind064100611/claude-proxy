---
name: project-code-memory
description: Reuses fingerprint-validated project knowledge before repository code discovery. Use before any source/test search, read, or modification, including localized tasks. Skip non-code tasks or tasks needing no repository code discovery; avoid first-time setup only in projects with 10 or fewer owned source/test files. Query only; the gateway maintains the records.
---

# Project Code Memory (query only)

`projectCodeMemory/` is a compact, ignored cache of code knowledge for one repository. In this installation you only query it. The local gateway maintains the records in the background with a cheaper model, so treat every record as a lead to verify, not as authority.

## 1. Eligibility

Pin `PRIMARY_PROJECT_ROOT` once to the repository that owns the code the user asked about. Default to the nearest repository containing the task's initial working directory; change roots only when the user explicitly switches the target project.

Use this workflow for every code task that will search, read, or modify repository-owned source or tests, before direct repository discovery. Skip it only for non-code tasks or tasks that require no repository code discovery. This is model-driven guidance, not an automatically installed hook.

Before the first source-symbol/path search or source-content read:

1. If `<root>/projectCodeMemory/` already exists, continue to **Query first**.
2. Otherwise, count repository-owned source and test file paths without reading their contents. Include tracked and non-ignored untracked files; exclude vendored dependencies, generated files, build outputs, and caches. Stop once the count reaches 11.
3. If the count is 10 or fewer, bypass this skill for the rest of the task. Do not initialize memory or modify `.gitignore`.
4. If the count reaches 11, continue to **Query first**; the query will initialize memory when absent.

## 2. Query first

Make the memory query the first repository code-discovery operation. Run it before `rg`, `grep`, `find`, or other source/path discovery (except the count above), and before reading source files. Build a focused query from the user's domain terms plus any known paths, classes, methods, event names, or error codes; avoid generic filler words.

```bash
python3 -I -B "<absolute-skill-dir>/scripts/pcm.py" query \
  --root <primary-project-root> \
  --limit 1 \
  "<focused task terms, paths, and symbols>"
```

Use Python 3.9 or newer. On macOS, use `python3 -I -B`; on Windows, use `python -I -B` or `py -3 -I -B`. Resolve `<absolute-skill-dir>` to the installed `~/.claude/skills/project-code-memory` directory (or `skills/project-code-memory` under the actual `CLAUDE_CONFIG_DIR` root); quote the absolute script path if it contains spaces. Do not depend on the current working directory.

Use `--limit 1` for a focused question or one flow; raise it to at most `3` only when the task genuinely spans independent topics. Add `--locate` for code changes and reviews: it returns current `path:line` matches for saved symbols. `query` initializes memory when absent, creating the target `projectCodeMemory/` cache, ensures the root `.gitignore` contains `/projectCodeMemory/`, validates matching fingerprints, and prunes matched stale or malformed records.

Query again only when discovery exposes a genuinely new symbol or subsystem that could match a different record. Do not loop over paraphrased queries.

## 3. Use records as leads

`VALID` only means the SHA-256 fingerprints of the record's files match the current files. It does not prove the stored claims: records are written by a cheaper model and can be wrong from the start.

- **`VALID` hit:** use it to decide where to look. Before editing, or before relying on a stated behavior in your answer, read the cited lines (use the `--locate` matches) and confirm the claim against current source. Do not present an unchecked record fact as verified.
- **`NO_MATCH`, `EMPTY_INDEX`, `STALE`, or `ERROR`:** inspect current source, starting with targeted symbol/path searches rather than a broad rescan.
- Current source always wins over a record. Never infer that an omitted fact is false.
- Returned `refs` are historical pointers, not verified evidence. Read an archive only when its original content is needed.
- Keep one fixed primary root. Code outside it is a read-only reference; never initialize memory there.

## 4. Never maintain records yourself

Do not write drafts, run `save`, `audit`, or `reindex`, prune records on purpose, or edit anything under `projectCodeMemory/`. The gateway refreshes, adds, and deletes records after code changes. When the `ProjectMemoryUpdate` tool is available, follow its instructions; that is the only way to report what a task changed or learned.
