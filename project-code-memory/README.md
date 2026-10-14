# Project Code Memory

This bundle is model-driven guidance for Claude Code, not an automatically installed hook. Python 3.9 or newer is required; run the bundled CLI with `python3 -I -B` on macOS (Windows: `python -I -B` or `py -3 -I -B`) using its quoted absolute installed path.

Project Code Memory is a Codex skill that preserves compact, verified knowledge about a codebase between tasks. It helps Codex reuse prior analysis without repeatedly scanning the same source files, while SHA-256 fingerprints prevent stale conclusions from being trusted.

The cache is local to the target repository, machine-oriented, and never a replacement for the source code itself.

## Highlights

- Reuses verified architecture, control-flow, invariant, and side-effect notes.
- Validates every record against fingerprints of its supporting source files.
- Uses the smallest sufficient evidence set to avoid invalidating unrelated knowledge.
- Prunes stale or malformed records safely and repairs the searchable index without letting invalid candidates consume the valid-result limit.
- Resolves saved symbols to current `path:line` locations on demand after fingerprint validation.
- Serializes concurrent CLI operations and atomically replaces cache files.
- Avoids duplicate records by merging highly similar, structurally anchored topics at save time.
- Keeps all generated state under an ignored `projectCodeMemory/` directory.
- Queries before repository source/test discovery even for narrow code work; reconciles affected JSON records after each eligible code change.
- Avoids first-time memory setup for projects with 10 or fewer owned source and test files.
- Keeps low-frequency record-authoring details in an on-demand reference instead of every skill load.
- Returns optional archive references through the existing save/query workflow without adding archive files to source fingerprints.
- Uses only the Python standard library.

## Install with claude-proxy

Use the independent **Install Project Code Memory** button on the local `/login` page. It installs only `SKILL.md`, `scripts/pcm.py`, `references/record-format.md`, `LICENSE`, and `SOURCE.md` into `~/.claude/skills/project-code-memory`, or `skills/project-code-memory` under `CLAUDE_CONFIG_DIR` when configured. No download or access to the upstream repository is needed.

Claude CLI and Python 3.9+ must already be installed; the button does not install dependencies or execute the Python CLI. It does not change settings, CLAUDE.md, hooks, credentials, or projects. An identical complete deployment or pinned upstream original is a no-write success; different or incomplete installations must be handled manually. Existing `.git` and cache files are preserved.

Open a new Claude session after installation. Invoke `/project-code-memory` explicitly or let the model select it based on its description. This is guidance, not hook-enforced behavior. Running `query` later creates the target project's `projectCodeMemory/` cache and adds its ignore rule.

The retained `agents/openai.yaml` is optional Codex metadata, not a Claude dependency. Upstream development tests and this README stay in the claude-proxy bundle and are not deployed by the button.

## How the workflow behaves

1. Use the workflow for code tasks requiring repository source/test discovery, including narrow, known-file work. Skip only non-code tasks or tasks needing no repository code discovery.
2. Pin one primary project root. On first use, count repository-owned source and test paths without reading contents and stop as soon as the count reaches 11; an existing cache skips this count.
3. With no existing cache, bypass first-time memory setup when the count is 10 or fewer.
4. For eligible projects, query memory before reading or broadly searching source content, using `--limit 1` for focused work and up to three only for genuinely cross-cutting work. Add `--locate` when a code change or review benefits from current line locations for saved symbols.
5. Reuse complete fingerprint-valid hits and inspect only missing, stale, or exact edit details. Stale higher-ranked candidates are pruned while the query continues looking for the requested number of valid records.
6. After every eligible code change, compare changed source/test paths with the evidence paths in `index.tsv`; refresh affected records under their existing IDs from current source or prune stale ones. Do not rely on the initial query to find every affected record.
7. Save new records only for verified, stable, reusable knowledge that passes the save gate. A small change may require no new JSON, but never skip checking existing affected records. Report the memory outcome or why a write was unnecessary/blocked.
8. Let normal queries validate and prune matched records; reserve full-cache audits for deliberate maintenance.

Directories outside the primary project are treated as read-only references. The skill never creates a second memory cache for them.

## Cache layout

```text
projectCodeMemory/
├── index.tsv       # Compact searchable index
├── records/        # Normalized, fingerprinted records
└── drafts/         # Temporary JSON drafts waiting to be saved
```

The skill ensures the target repository's root `.gitignore` contains:

```gitignore
/projectCodeMemory/
```

Do not commit the cache.

## CLI reference

Resolve `<absolute-skill-dir>` to the installed directory and pass the target project with `--root` (Python 3.9+; on Windows replace `python3` with `python` or `py -3`):

```bash
python3 -I -B "<absolute-skill-dir>/scripts/pcm.py" init --root /path/to/project
python3 -I -B "<absolute-skill-dir>/scripts/pcm.py" query --root /path/to/project "symbol path or task terms"
python3 -I -B "<absolute-skill-dir>/scripts/pcm.py" query --root /path/to/project --limit 1 --locate "symbol to edit"
python3 -I -B "<absolute-skill-dir>/scripts/pcm.py" save --root /path/to/project /path/to/project/projectCodeMemory/drafts/topic.json
python3 -I -B "<absolute-skill-dir>/scripts/pcm.py" reindex --root /path/to/project
python3 -I -B "<absolute-skill-dir>/scripts/pcm.py" audit --root /path/to/project
```

| Command | Behavior |
| --- | --- |
| `init` | Creates the cache directories and index, then ensures the ignore rule exists. |
| `query` | Initializes if needed, ranks index matches, and emits up to `--limit` fingerprint-valid records. Matching stale or invalid records are pruned without consuming that limit. `--locate` adds bounded current line matches for saved symbols after a second freshness check. The default limit is 3. |
| `save` | Validates and fingerprints a draft. The same ID replaces its record; a different, highly similar topic is left `UNCHANGED` or `MERGED` into the existing ID and summary. Otherwise a new record is saved. The index is rebuilt and the draft is removed after success. |
| `reindex` | Rebuilds the index from readable, structurally valid records. It does not check source fingerprints or perform a full cleanup. |
| `audit` | Validates every record, prunes all stale or invalid records, and rebuilds the index. |

`query` is intentionally not read-only: it can create `projectCodeMemory/`, update `.gitignore`, prune matched records, and repair the index. It only validates records selected by the query and `--limit`; use `audit` for a deliberate full-cache health check after broad changes or when corruption is suspected. Unmatched stale records may remain until a later query or audit, but they are never returned as `VALID` without fingerprint validation.

Common status lines include `SAVED`, `MERGED`, `REFERENCED`, `UNCHANGED`, `VALID`, `STALE`, `ERROR`, `PRUNED`, `EMPTY_INDEX`, `NO_MATCH`, and `NO_MEMORY`.

## Draft format

Drafts must live inside `<root>/projectCodeMemory/drafts/` and use repository-relative source paths:

```json
{
  "id": "authentication-flow",
  "keywords": ["auth", "login", "session"],
  "paths": ["src/auth.py"],
  "symbols": ["authenticate", "SessionStore"],
  "summary": "Authentication routing and session ownership",
  "facts": ["authenticate validates credentials before creating a session"],
  "flows": ["request -> authenticate -> SessionStore"],
  "invariants": ["A session is created only after successful validation"],
  "side_effects": ["Successful login persists a session"],
  "verification": ["python3 -m unittest tests.test_auth"]
}
```

Required, non-empty fields are `id`, `keywords`, `paths`, `summary`, `facts`, and `verification`. The `id` must match `[a-z0-9][a-z0-9._-]{0,79}`. Every path must resolve to an existing file inside the target project and must not point into `projectCodeMemory/`.

`paths` is an invalidation dependency list, not a research log. Include a file only when its current contents directly support a stored fact, flow, invariant, or side effect. Browsed files, incidental callers, shared wrappers, build files, and tests used only for verification should stay out of `paths`; keep commands and results in `verification`. Do not omit genuinely necessary cross-file evidence. Split independent topics into separate records when that keeps their evidence and change cadence separate.

Use exact source identifiers in `symbols` when possible. `query --locate` searches those literals only inside fingerprint-valid evidence paths and returns at most five current line matches for each of the first 50 symbols. It reports omitted-symbol counts rather than allowing location output to grow without bound, and it does not persist line numbers in the record.

The CLI stores normalized records rather than generating analysis itself. The agent is responsible for inspecting the code, verifying conclusions, and preparing drafts. After edits, use the same ID to refresh affected records with updated evidence and verification; never manually patch compact JSON or fingerprints.

## Optional archive references

When the existing workflow already calls for a save, an agent should include any known, relevant archive locators in the draft:

```json
"references": [
  {
    "kind": "sol-pi-observation",
    "id": "obs_original_id",
    "path": "/absolute/path/to/original/archive.txt",
    "session": "original-session-id",
    "label": "Original inspection output"
  }
]
```

`kind` and at least one of `id` or `path` are required; `session` and `label` are optional. Only those five fields are accepted. Keep exact paths and supply only locators actually known; do not guess paths or copy archive content or secrets. Gateway archives can use `kind: "gateway-archive"` with their native `Read` path.

Records and normal queries return these as `refs`. They are historical lookup metadata, not verified source evidence: references never enter `paths`/`fp`, search ranking, or topic similarity, and the CLI never reads or hashes their targets. Archive deletion or changes therefore do not invalidate source knowledge. Across sessions, prefer an actual archive path; `obs_recall` IDs alone may not resolve outside their owning session.

Same-ID refreshes and topic merges retain earlier references and append new ones; identical objects are deduplicated. Omitting the field or providing an empty array does not erase earlier references. A duplicate with only new references reports `REFERENCED` while preserving canonical knowledge, source fingerprints, and index content. Old records remain compatible. References are returned only with a valid matching record and disappear when that record is pruned; this is not an independent archive index or automatic post-compaction injection.

Query/save timing and the save gate stay unchanged: references alone do not trigger a new save, hook, scan, or compaction action. Full field guidance is in [`references/record-format.md`](references/record-format.md).

## Development

Requires Python 3.9 or newer. Run the test suite with:

```bash
python3 -m unittest discover -s tests -v
```

See [`SKILL.md`](SKILL.md) for the core agent workflow and safety rules. Record-authoring details live in [`references/record-format.md`](references/record-format.md) and are loaded only when needed.
