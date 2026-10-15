# Source and bundle provenance

This directory bundles the `projectcodememory` project by shanshazhe from:

- Upstream: https://github.com/shanshazhe/projectcodememory.git
- Pinned commit: `7dc7b0dad137fa8e1e65af31143f4ead8109ca03`
- License: MIT (see `LICENSE`)
- Authorization: the source owner explicitly authorized this Toolkit copy to be distributed under MIT. The pinned upstream tree did not contain a tracked LICENSE; this authorization applies to this bundled copy and does not modify the upstream repository.

The upstream Python CLI, reference, OpenAI agent metadata, and upstream tests are retained. `SKILL.md` and `README.md` were adapted for Claude Code and this toolkit bundle (absolute installed skill path, Python 3.9+ invocation guidance, and explicit cache-writing behavior). `manifest.json` records original and deployed SHA-256 hashes for auditable provenance. No Git metadata or user data is included.

`SKILL.md` was later rewritten as a query-only skill for the toolkit's gateway-maintained mode: Claude queries the cache and reads cited lines before relying on a record, while the local gateway refreshes, adds and deletes records with a cheaper model. Claude never writes, saves or prunes records itself. The installed set is `scripts/pcm.py`, `LICENSE`, `SOURCE.md` and `SKILL.md`; `references/record-format.md` stays in the bundle unchanged as the reference for the gateway's maintenance prompt and is no longer installed. `scripts/pcm.py` remains byte-identical to upstream.

The bundle is not an installer. It must not replace an existing `~/.claude/skills/project-code-memory` checkout without the user's explicit consent.
