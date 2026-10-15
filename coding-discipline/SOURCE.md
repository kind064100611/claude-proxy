# Source and bundle provenance

This directory bundles an adapted copy of the `karpathy-guidelines` skill from:

- Upstream: https://github.com/multica-ai/andrej-karpathy-skills (formerly `forrestchang/andrej-karpathy-skills`)
- Pinned commit: `2c606141936f1eeef17fa3043a72095b4765b9c2`
- Upstream file: `skills/karpathy-guidelines/SKILL.md` (SHA-256 `6e22cc54cb02a5e98ae42d06d9d7292db0c1b43894831b32879beb0166b2aea7`)
- License: MIT (see `LICENSE`). The pinned upstream tree declares MIT in its README ("License: MIT") and in the skill frontmatter (`license: MIT`) but has no tracked LICENSE file; `LICENSE` here reproduces the standard MIT text for this bundled copy and does not modify the upstream repository.

`SKILL.md` was adapted for this toolkit: renamed to `coding-discipline` (name and title), given a mandatory "load first before any code change" description, extended with When to Use, When NOT to Use and Success Signals sections, with bold markers and the `license` frontmatter field removed and the intro's link to Andrej Karpathy's post replaced by a note to merge with project-specific instructions. `manifest.json` records the deployed and original SHA-256 hashes for auditable provenance. No Git metadata or user data is included.

The bundle is not an installer. It must not replace an existing different `~/.claude/skills/coding-discipline` without the user's explicit consent.
