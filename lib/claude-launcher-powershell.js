"use strict";

const path = require("path");

const quote = (value) => "'" + value.replace(/'/g, "''") + "'";
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
function unquote(value) {
  if (!/^'(?:[^']|'')*'$/.test(value)) throw new Error("Launcher block was modified; nothing was overwritten.");
  return value.slice(1, -1).replace(/''/g, "'");
}

function createPowerShellProfile({ home, env, execFileSync, start, end }) {
  const powershell = path.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const run = (command) => {
    if (!path.isAbsolute(powershell) || /[\x00-\x1f\x7f-\x9f]/.test(powershell)) throw new Error("Unsafe PowerShell executable path.");
    return execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", timeout: 5000, stdio: "pipe", env });
  };
  return {
    reason: "", warnOnSkip: false, unixPermissions: false,
    backupDirectory: "powershell-backups", backupName: "profile", eol: "\r\n",
    target() {
      const profile = String(run("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $PROFILE.CurrentUserAllHosts")).trim();
      const relative = path.relative(home, profile);
      if (!path.isAbsolute(profile) || /[\x00-\x1f\x7f-\x9f]/.test(profile) || path.basename(profile).toLowerCase() !== "profile.ps1" ||
        relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Windows PowerShell profile could not be located safely inside the user home.");
      return profile;
    },
    decode(bytes) {
      if (bytes?.[0] === 0xfe && bytes?.[1] === 0xff) throw new Error("UTF-16BE profiles are not supported; nothing was overwritten.");
      if (bytes?.[0] === 0xff && bytes?.[1] === 0xfe) {
        return { text: bytes.subarray(2).toString("utf16le"), encoding: "utf16le", offset: (index) => 2 + index * 2, prefixLength: 0 };
      }
      return { text: bytes?.toString("latin1") || "", encoding: "utf8", offset: (index) => index,
        prefixLength: bytes?.subarray(0, 3).equals(utf8Bom) ? 3 : 0 };
    },
    render: (node, launcher, eol) => [start, "function global:claude {",
      "  $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
      `  if ($nodeCommand) { $nodeCommand = $nodeCommand.Source } else { $nodeCommand = ${quote(node)} }`,
      "  $startInfo = New-Object System.Diagnostics.ProcessStartInfo",
      "  $startInfo.FileName = $nodeCommand", "  $startInfo.UseShellExecute = $false",
      "  $startInfo.WorkingDirectory = $PWD.ProviderPath",
      `  $launchArguments = @(${quote(launcher)}) + $args`,
      // Windows PowerShell 5.1 native splatting drops empty arguments and embedded quotes.
      String.raw`  $startInfo.Arguments = ($launchArguments | ForEach-Object { '"' + ([string]$_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }) -join ' '`,
      "  $child = [System.Diagnostics.Process]::Start($startInfo)", "  $child.WaitForExit()",
      "  $global:LASTEXITCODE = $child.ExitCode", "  $child.Dispose()", "}", end].join(eol),
    parse(content, eol) {
      const lines = content.split(eol);
      const nodePrefix = "  if ($nodeCommand) { $nodeCommand = $nodeCommand.Source } else { $nodeCommand = ";
      const launchPrefix = "  $launchArguments = @(";
      const launchSuffix = ") + $args";
      if (lines.length !== 16 || !lines[3].startsWith(nodePrefix) || !lines[3].endsWith(" }") ||
        !lines[8].startsWith(launchPrefix) || !lines[8].endsWith(launchSuffix)) {
        throw new Error("Launcher block was modified; nothing was overwritten.");
      }
      return { node: unquote(lines[3].slice(nodePrefix.length, -2)), launcher: unquote(lines[8].slice(launchPrefix.length, -launchSuffix.length)) };
    },
    continuation: /`\r?\n/g,
    definition: /\bfunction\s+(?:(?:global|script|local):)?['"]?claude['"]?(?=\s|\{)|\b(?:Set-Alias|New-Alias|sal|nal)\b[^\n;]*\bclaude\b|\b(?:Set-Item|New-Item)\b[^\n;]*\b(?:function|alias):[^\n;]*\bclaude\b/i,
    validateContent(original, rendered, view) {
      if (original.length && view.encoding !== "utf16le" && !view.prefixLength &&
        (original.some((byte) => byte > 127) || /[^\x00-\x7f]/.test(rendered))) {
        throw new Error("Non-ASCII PowerShell profiles require a UTF-8 or UTF-16LE BOM; nothing was overwritten.");
      }
    },
    newFilePrefix: utf8Bom,
    validateSyntax: (file) => run(`$tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${quote(file)}, [ref]$tokens, [ref]$errors); if ($errors.Count) { exit 1 }`)
  };
}

module.exports = { createPowerShellProfile };
