"use strict";

const path = require("path");

const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
function unquote(value) {
  if (!/^'(?:[^']|'\\'')*'$/.test(value)) throw new Error("Launcher block was modified; nothing was overwritten.");
  return value.slice(1, -1).replace(/'\\''/g, "'");
}

function createZshProfile({ home, env, platform, execFileSync, start, end }) {
  let reason = "";
  if (platform !== "darwin") reason = "Only macOS + zsh and Windows PowerShell are supported.";
  else if (env.SHELL && path.basename(env.SHELL) !== "zsh") reason = "SHELL is not zsh; launcher installation skipped.";
  const zdotdir = env.ZDOTDIR === "~" ? home : env.ZDOTDIR?.replace(/^~\//, home + "/");
  if (!reason && zdotdir && path.resolve(zdotdir) !== path.resolve(home)) reason = "Custom ZDOTDIR is not supported; launcher installation skipped.";
  return {
    reason, warnOnSkip: platform === "darwin", unixPermissions: true,
    backupDirectory: "zsh-backups", backupName: "zshrc", eol: "\n",
    target: () => path.join(home, ".zshrc"),
    decode: (bytes) => ({ text: bytes?.toString("latin1") || "", encoding: "utf8", offset: (index) => index, prefixLength: 0 }),
    render: (node, launcher, eol) => [start, "claude() {", "  local node_command",
      `  node_command="$(whence -p node)" || node_command=${quote(node)}`,
      `  "$node_command" ${quote(launcher)} "$@"`, "}", end].join(eol),
    parse(content, eol) {
      const lines = content.split(eol);
      const nodePrefix = '  node_command="$(whence -p node)" || node_command=';
      const launchPrefix = '  "$node_command" ';
      const launchSuffix = ' "$@"';
      if (lines.length !== 7 || !lines[3].startsWith(nodePrefix) || !lines[4].startsWith(launchPrefix) || !lines[4].endsWith(launchSuffix)) {
        throw new Error("Launcher block was modified; nothing was overwritten.");
      }
      return { node: unquote(lines[3].slice(nodePrefix.length)), launcher: unquote(lines[4].slice(launchPrefix.length, -launchSuffix.length)) };
    },
    continuation: /\\\r?\n/g,
    definition: /(?:^|[;\n]|\b(?:then|do|else)\s)\s*(?:function\s+['"]?claude['"]?(?=\s|\()|['"]?claude['"]?\s*\(\s*\)|alias\s+[^\n;]*\bclaude['"]?\s*=)/m,
    validateSyntax: (file) => execFileSync("/bin/zsh", ["-f", "-n", file], { timeout: 5000, stdio: "pipe", env })
  };
}

module.exports = { createZshProfile };
