---
name: project-code-memory
description: Reuses SHA-256-verified knowledge before repository code discovery and reconciles affected memory JSON after every eligible code change. Use before any source/test search, read, or modification, including localized tasks; check and refresh affected records before finishing edits. Skip non-code tasks or tasks needing no repository code discovery; avoid first-time setup only in projects with 10 or fewer owned source/test files.
---

# Project Code Memory

Use `projectCodeMemory/` as a compact, ignored cache of verified code knowledge. Optimize total investigation cost, not the number of records. Current source is authoritative; a fingerprint-valid record is a trusted proxy only for the files and facts it covers.

## 1. Memory-first eligibility gate

Pin `PRIMARY_PROJECT_ROOT` once to the repository that owns the code the user asked about. Default to the nearest repository containing the task's initial working directory; change roots only when the user explicitly switches the target project.

For every code task that will search, read, or modify repository-owned source or tests, use this workflow before direct repository discovery. This includes localized lookups, known-file edits, mechanical changes, broad analysis, debugging, and implementation. Skip it only for non-code tasks or tasks that require no repository code discovery. This is model-driven guidance, not an automatically installed hook.

Before the first source-symbol/path search or source-content read:

1. If `<root>/projectCodeMemory/` already exists, skip counting and continue to **Query first**, regardless of task scope.
2. Otherwise, count repository-owned source and test file paths without reading their contents. Include tracked and non-ignored untracked files; exclude vendored dependencies, generated files, build outputs, and caches. Stop once the count reaches 11.
3. If the count is 10 or fewer, bypass this skill for the rest of the task. Do not initialize memory or modify `.gitignore`.
4. If the count reaches 11, continue to **Query first**; the query will initialize memory when absent.

## 2. Query first

For an eligible project, make the memory query the first repository code-discovery operation. Run it before `rg`, `grep`, `find`, or other source/path discovery (except the eligibility file count above), and before reading source files. Build a focused query from the user's domain terms plus any known paths, classes, methods, event names, or error codes; avoid generic filler words.

```bash
python3 -I -B "<absolute-skill-dir>/scripts/pcm.py" query \
  --root <primary-project-root> \
  --limit 1 \
  "<focused task terms, paths, and symbols>"
```

Use Python 3.9 or newer. On macOS, use `python3 -I -B`; on Windows, use `python -I -B` or `py -3 -I -B`. Resolve `<absolute-skill-dir>` to the installed `~/.claude/skills/project-code-memory` directory (or `skills/project-code-memory` under the actual `CLAUDE_CONFIG_DIR` root); quote the absolute script path if it contains spaces. Do not depend on the current working directory. Load [references/record-format.md](references/record-format.md) on demand by path relative to the skill directory.

Use `--limit 1` for a focused question or one flow; raise it to at most `3` only when the task genuinely spans independent topics. The limit counts fingerprint-valid records, so stale or malformed higher-ranked candidates are pruned without hiding a later valid hit. Add `--locate` for code changes or reviews when current `path:line` matches for saved symbols would avoid another navigation search; omit it for read-only questions that need only the stored knowledge. `query` initializes memory when absent, creating the target `projectCodeMemory/` cache, ensures the root `.gitignore` contains `/projectCodeMemory/`, validates matching fingerprints, and prunes matched stale or malformed records.

Choose one path:

- **Complete `VALID` hit:** For read-only work, answer directly from the record and do not reopen its evidence files merely to reconfirm it. For a code change, use `--locate` results when available, then read only the exact edit sites and relevant tests.
- **Partial `VALID` hit:** Keep the valid facts and inspect only the explicitly missing behavior or symbols.
- **`NO_MATCH`, `EMPTY_INDEX`, `STALE`, or `ERROR`:** Inspect current source, starting with targeted symbol/path searches rather than a broad rescan.

Query again only when discovery exposes a genuinely new symbol or subsystem that could match a different record. Do not loop over paraphrased queries.

## 3. Use memory narrowly

- Treat a record as authority only for its stated facts, flows, invariants, side effects, and fingerprinted paths.
- Read current source for uncovered details, exact edit context, or behavior not stated in the record.
- Never infer that an omitted fact is false.
- Returned `refs` are historical lookup pointers, not fingerprint-verified evidence. Read an archive only when its original content is needed, using normal tool permissions. Prefer its exact `path` across sessions; use `obs_recall` with an ID only when the owning session is known to be the active session. A missing archive does not invalidate the source knowledge; inspect current evidence if needed.
- Keep one fixed primary root. Code outside it is a secondary, read-only reference: never initialize memory there or store external-only behavior in the primary cache.

## 4. Reconcile memory after every eligible code change

This is a required closeout step, even when the initial query returned `NO_MATCH` or the change seems small. After inspecting the final diff and running relevant checks:

1. Compare changed repository source/test paths with the `paths` column (third, tab-separated field) of `<root>/projectCodeMemory/index.tsv`. Do not assume the initial query found every affected record; an indexed record can refer to a changed file without matching the task's keywords. This is a targeted path check, not a full audit. Read matching `<root>/projectCodeMemory/records/<id>.json` only to identify prior claims and IDs; after an evidence-file change, recheck every retained claim against current source rather than trusting old fingerprints.
2. For each affected record whose knowledge remains useful, prepare a draft with its **existing ID** using current evidence and checks, then run `save` to refresh its fingerprints. Update or remove facts, evidence paths, and verification that no longer hold. Do this even if the code change was only formatting: a changed evidence file invalidates its fingerprint. Do not edit compact records or `index.tsv` by hand. If a record is no longer true or useful, use a targeted query for its ID to prune the stale record and confirm `PRUNED`; do not recreate it merely to keep the count up.
3. Evaluate whether the task established new reusable knowledge using the save gate below. Create a new record only if it passes. Trivial edits can correctly produce **no new JSON**, but they cannot skip checking and reconciling existing affected records.
4. Before replying, confirm any drafts were saved or explicitly report why saving was blocked. State the memory outcome (`saved`, `refreshed`, `pruned`, or `no write` with reason) alongside code verification; do not silently omit this check. If the cache/index is unreadable or reconciliation fails, report the unresolved issue rather than claiming memory is current.

## 5. Save only high-value knowledge

Save a new record only when all are true:

1. The task established new or changed knowledge through current-source inspection or a verified code change.
2. The knowledge is stable and likely to help a future task.
3. It captures a meaningful flow, ownership boundary, invariant, persistence/event side effect, configuration gate, or similarly non-obvious behavior.
4. A small set of repository files directly supports every stored claim.

Do **not** save line numbers, code dumps, localized implementation trivia, transient failures, guesses, secrets, routine DTO plumbing, mechanical edits, or facts already covered by an unchanged complete hit.

When the gate passes for a new record, or an affected existing record needs a refresh, read [references/record-format.md](references/record-format.md) completely, create a draft, and run `save`. Include any known, task-relevant archive references in that draft; never invent IDs, paths, or session identity. References alone do not bypass the save gate or trigger an extra query/save. Otherwise finish without creating a new record. Do not run a full audit after an ordinary change or single save.

## 6. Integrity and maintenance

- A fingerprint mismatch always overrides remembered conclusions.
- Never edit stored fingerprints, compact records, or `index.tsv` by hand; use the CLI. CLI operations serialize through a repository-local lock and use atomic replacement, so concurrent agents should invoke the CLI rather than manipulating cache files directly.
- Keep every cache artifact under `<root>/projectCodeMemory/` and never commit it.
- `query` may write only that cache plus the root ignore rule; it must not modify source or project configuration.
- Run `audit --root <root>` only for deliberate full-cache maintenance, broad refactors likely to stale many records, or suspected corruption.
