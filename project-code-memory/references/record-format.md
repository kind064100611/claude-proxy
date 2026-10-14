# Record authoring reference

Read this file only after the `SKILL.md` save gate passes.

## Draft location and shape

Create a JSON draft inside `<primary-project-root>/projectCodeMemory/drafts/`:

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
  "verification": ["Inspected src/auth.py and ran python3 -m unittest tests.test_auth"]
}
```

Required, non-empty fields are `id`, `keywords`, `paths`, `summary`, `facts`, and `verification`. Optional list fields may be empty. The ID must match `[a-z0-9][a-z0-9._-]{0,79}`.

## Field quality

- **id:** Stable topic name, not a task or ticket number unless the ticket itself is the lasting concept.
- **keywords:** User vocabulary plus exact domain terms that a future query is likely to contain.
- **paths:** The smallest sufficient invalidation dependency set.
- **symbols:** Exact source literals for classes, methods, endpoints, event types, properties, or database objects that improve retrieval. Prefer identifiers that `query --locate` can find verbatim inside an evidence path; line numbers are resolved on demand and must not be stored.
- **summary:** One compact routing or ownership sentence.
- **facts:** Dense, independently useful statements; each must be supported by `paths`.
- **flows:** Important entry-to-effect chains using concise arrows.
- **invariants:** Conditions that must remain true, including important negative behavior.
- **side_effects:** Persistence, event, network, authorization, or lifecycle effects.
- **verification:** Exact source inspection and checks actually performed. Never imply that tests ran when they did not.

## Optional archive references

When a save is already required by the normal workflow, include known, relevant references in an optional `references` array:

```json
"references": [
  {
    "kind": "sol-pi-observation",
    "id": "obs_original_id",
    "path": "/absolute/path/to/original/archive.txt",
    "session": "original-session-id",
    "label": "Original source inspection output"
  }
]
```

Each object requires a non-empty `kind` and at least one of `id` or `path`. Optional fields are `session` and `label`; no other fields are accepted. Use kinds such as `sol-pi-observation`, `gateway-archive`, or `file`. Supply only actual locators already known from the task: never fabricate an archive path from an ID. Preserve filesystem paths exactly, including spaces. Store only locator metadata, not original content, commands, credentials, or secrets.

The compact record and normal query output expose this array as `refs`. References do not enter source `paths`/`fp`, the index, topic similarity, or knowledge-continuity checks. The CLI does not open or fingerprint referenced files; missing or changed archives do not stale otherwise valid source knowledge. These are historical pointers, not proof that archived content still matches current source. An ID alone may be insufficient across sessions: use an exact path with the normal read tool when available, and use `obs_recall` only in the known owning session. Without a usable locator, inspect current source instead of guessing.

Same-ID refreshes and topic merges retain existing references and append new ones, deduplicating identical objects. Omitting `references` or passing an empty list preserves earlier references. A duplicate topic carrying only new references returns `REFERENCED` and keeps the canonical knowledge, fingerprints, and index unchanged. No new record, hook, compaction trigger, or extra save is required just because a reference exists. References disappear with a pruned record; this is not a standalone archive inventory, and it does not restore all references automatically after compaction.

## Evidence-path rules

`paths` is an invalidation dependency list, not a browsing log.

Include a file only when its current contents are necessary to support a stored claim. Do not include incidental callers, navigation-only files, shared wrappers, build files, or tests used solely to run verification. A test belongs in `paths` only when the record stores behavior established by that test rather than by production source.

Do not omit a genuine cross-file dependency merely to reduce invalidation. Split independent topics when that yields smaller evidence sets or separates files with different change cadences.

Every evidence path must be repository-relative, exist inside the primary root, and stay outside `projectCodeMemory/`. Never store knowledge supported only by external repositories.

## Refresh an affected record

After a code change, identify records whose indexed evidence paths overlap changed source/test files. For each record worth keeping, use its **existing `id`** in a new draft; rewrite the fields from current source rather than copying unsupported old claims. Recheck every retained claim and path even if only formatting changed, because the SHA-256 fingerprint must be updated. Record checks actually run in `verification`. If the record no longer describes current code, query its ID to prune the stale record rather than saving stale knowledge. Never hand-edit the compact JSON or its fingerprints.

## Save

```bash
python3 <skill-dir>/scripts/pcm.py save \
  --root <primary-project-root> \
  <primary-project-root>/projectCodeMemory/drafts/<id>.json
```

`save` validates the draft, computes SHA-256 fingerprints, writes a compact record, rebuilds the index, and removes the consumed draft. Saving the same ID replaces it. A strongly overlapping different ID may return `UNCHANGED` or `MERGED`; accept that canonicalization rather than creating a duplicate.

After saving, do not run `reindex` or `audit`: `save` already rebuilds the index and fingerprints its evidence.

## Final check

Before finishing, confirm that:

- every claim is reusable rather than task narration;
- every claim has direct evidence in `paths`;
- no secret, guess, code dump, or stale conclusion is present;
- verification wording matches what actually ran;
- affected existing records have been refreshed or pruned (or a blocking error is reported);
- the cache remains ignored and uncommitted.
