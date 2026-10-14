# Statusline source and provenance

The bundled statusline runtime was copied byte-for-byte from the supplied local, read-only migration snapshot. This migration had no upstream commit, tag, or remote verification available; the snapshot is the sole provenance asserted here. No upstream authenticity or remote verification is claimed.

The source bundle identifies the HUD as Claude HUD 0.1.0 from https://github.com/jarrodwatts/claude-hud. That attribution and version are retained; this migration did not inspect a user plugin cache or independently verify a remote release/tag.

The runtime bundle contains 44 JavaScript files under `claude-hud/dist/`, plus the ESM `claude-hud/package.json`, its `claude-hud/LICENSE`, `hud-config.json`, and `statusline-command.sh`. The wrapper is included exactly as found in the snapshot. No changes were made to the 44 bundled JavaScript files during migration. The non-runtime `original/` archive was excluded because it contains a personal absolute executable path and is never deployed or executed.

## Existing vendor adaptations

- `claude-hud/dist/claude-config-dir.js` retains the actual CLI-root resolution. In bundled mode, `getHudPluginDir()` uses `TOOLKIT_STATUSLINE_DIR` as a flag and resolves the HUD config/cache from its own ESM file URL into the generation's `claude-hud/plugins/claude-hud/`. This also avoids interpreting Git Bash drive paths as native Windows paths. It does not override `CLAUDE_CONFIG_DIR`.
- The entrypoint consumes stdin, local transcripts, rendering, and project display data. The source bundle omits the unused upstream `usage-api.js` (credential/keychain and network usage probes); it is not part of the entrypoint dependency graph. No official usage API is invoked by the bundled entrypoint.
- The adapted wrapper selects `TOOLKIT_NODE`, `TOOLKIT_JQ`, and `TOOLKIT_STATUSLINE_DIR` and appends warm/dropped/hit prompt-cache display. It contains no personal executable path. The installer retains these internal variables and the `.toolkit-generation` protocol, quoting probed dependencies and converting Windows drive paths for Git Bash.

These adaptations predate this migration and were preserved, not newly developed here. The new private deployment root is `<actual CLI config directory>/claude-proxy/statusline/`. No credentials, plugin caches, source maps, declaration files, or `node_modules` were copied.

`claude-hud/package.json` declares the MIT license; the accompanying MIT `LICENSE` (copyright 2026 Jarrod Watts) is retained with the bundle. See that file for the complete license terms.

## Aggregate digest

Measured SHA-256: `3e4ef5b74c17e9d354767cbf045968df492668d2724656c2541f000429346d9a`

This digest covers the 48 regular runtime-bundle files listed above (including the wrapper, excluding this document). To calculate it, sort paths lexicographically relative to `statusline/`; for each path, hash its UTF-8 bytes, a NUL byte, the file's exact bytes, and a trailing NUL byte. This is an integrity measurement of the copied local snapshot, not remote verification.
