"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync: execute } = require("child_process");
const { getClaudeConfigRoot } = require("./claude-setup");
const { defaultStore } = require("./credential-store");
const { readCredentialAvailability } = require("./pi-auth");
const { getFeatureConfigPath, getStatus: getFeatures, setFeatures } = require("./online-summary");

const START = "# >>> claude-proxy capacity launcher >>>";
const END = "# <<< claude-proxy capacity launcher <<<";
const queues = new Map();
const fail = (message) => { throw new Error(message); };
const safePath = (value) => typeof value === "string" && path.isAbsolute(value) && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const sameEntry = (a, b) => a === b || Boolean(a && b && a.ino === b.ino && a.dev === b.dev);

function render(node, launcher, eol) {
  return [START, "claude() {", "  local node_command",
    `  node_command="$(whence -p node)" || node_command=${quote(node)}`,
    `  "$node_command" ${quote(launcher)} "$@"`, "}", END].join(eol);
}
function unquote(value) {
  if (!/^'(?:[^']|'\\'')*'$/.test(value)) fail("Launcher block was modified; nothing was overwritten.");
  const decoded = value.slice(1, -1).replace(/'\\''/g, "'");
  if (!safePath(decoded) || quote(decoded) !== value) fail("Launcher block contains an unsafe path.");
  return decoded;
}

function createClaudeLauncherInstaller({ home = os.homedir(), env = process.env, platform = process.platform,
  configRoot = getClaudeConfigRoot(env, home), featureFile = getFeatureConfigPath(home),
  repoRoot = path.resolve(__dirname, ".."), nodePath = process.execPath, fsImpl = fs, store = defaultStore,
  execFileSync = execute, onWarning = (message) => console.warn(`[claude-launcher] ${message}`) } = {}) {
  const target = path.join(home, ".zshrc");
  const launcher = path.join(repoRoot, "lib", "claude-launch.js");
  const backups = path.join(configRoot, "claude-proxy", "zsh-backups");
  const owned = (stat) => !process.getuid || stat.uid === process.getuid();
  function skipped() {
    if (platform !== "darwin") return "Only macOS + zsh is supported.";
    if (env.SHELL && path.basename(env.SHELL) !== "zsh") return "SHELL is not zsh; launcher installation skipped.";
    const zdotdir = env.ZDOTDIR === "~" ? home : env.ZDOTDIR?.replace(/^~\//, home + "/");
    if (zdotdir && path.resolve(zdotdir) !== path.resolve(home)) return "Custom ZDOTDIR is not supported; launcher installation skipped.";
    return "";
  }
  function statAt(file) {
    try { return fsImpl.lstatSync(file); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  function checkParents(directory) {
    const parent = path.dirname(directory);
    if (parent !== directory) checkParents(parent);
    const stat = statAt(directory);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail("Unsafe launcher directory; nothing was overwritten.");
  }
  function checkDirectory(directory, create = false, privateMode = false) {
    checkParents(directory);
    let stat = statAt(directory);
    if (!stat && create) {
      checkDirectory(path.dirname(directory), true);
      fsImpl.mkdirSync(directory, { mode: 0o700 });
      stat = statAt(directory);
    }
    if (!stat?.isDirectory() || !owned(stat) || !(stat.mode & 0o222) || (stat.mode & 0o022)) {
      fail("Launcher directory is unsafe or not writable.");
    }
    fsImpl.accessSync(directory, fsImpl.constants.W_OK | fsImpl.constants.X_OK);
    if (privateMode) fsImpl.chmodSync(directory, 0o700);
    return stat;
  }
  function readTarget() {
    checkDirectory(home);
    const stat = statAt(target);
    if (!stat) return { bytes: null, info: null };
    if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat) || !(stat.mode & 0o222) || stat.size > 4 * 1024 * 1024) {
      fail("Launcher target is unsafe or not writable; nothing was overwritten.");
    }
    fsImpl.accessSync(target, fsImpl.constants.W_OK);
    const fd = fsImpl.openSync(target, fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0));
    try {
      const info = fsImpl.fstatSync(fd);
      if (!sameEntry(stat, info) || !info.isFile() || !owned(info) || info.size > 4 * 1024 * 1024) fail("Launcher target changed; retry installation.");
      return { bytes: fsImpl.readFileSync(fd), info };
    } finally { fsImpl.closeSync(fd); }
  }

  function inspect(snapshot) {
    // latin1 keeps string offsets equal to byte offsets, including non-UTF-8 user configuration.
    const text = snapshot.bytes?.toString("latin1") || "";
    const starts = [...text.matchAll(/# >>> claude-proxy capacity launcher >>>/g)];
    const ends = [...text.matchAll(/# <<< claude-proxy capacity launcher <<</g)];
    let range = null;
    let current = false;
    if (starts.length || ends.length) {
      if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) {
        fail("Launcher marker conflict; nothing was overwritten.");
      }
      const start = starts[0].index;
      let end = ends[0].index + END.length;
      if ((start && text[start - 1] !== "\n") || (end < text.length && text[end] !== "\n" && text.slice(end, end + 2) !== "\r\n")) {
        fail("Launcher marker conflict; nothing was overwritten.");
      }
      const bytes = snapshot.bytes.subarray(start, end);
      const content = bytes.toString("utf8");
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(eol);
      if (lines.length !== 7 || !lines[3].startsWith('  node_command="$(whence -p node)" || node_command=') ||
        !lines[4].startsWith('  "$node_command" ') || !lines[4].endsWith(' "$@"')) {
        fail("Launcher block was modified; nothing was overwritten.");
      }
      const oldNode = unquote(lines[3].slice('  node_command="$(whence -p node)" || node_command='.length));
      const oldLauncher = unquote(lines[4].slice('  "$node_command" '.length, -' "$@"'.length));
      if (!oldLauncher.endsWith("/lib/claude-launch.js") || !bytes.equals(Buffer.from(render(oldNode, oldLauncher, eol)))) {
        fail("Launcher block was modified; nothing was overwritten.");
      }
      if (text.slice(end, end + 2) === "\r\n") end += 2;
      else if (text[end] === "\n") end++;
      range = { start, end, eol };
      current = oldNode === nodePath && oldLauncher === launcher;
    }
    const outside = (range ? text.slice(0, range.start) + text.slice(range.end) : text).replace(/\\\r?\n/g, "");
    const definition = /(?:^|[;\n]|\b(?:then|do|else)\s)\s*(?:function\s+['"]?claude['"]?(?=\s|\()|['"]?claude['"]?\s*\(\s*\)|alias\s+[^\n;]*\bclaude['"]?\s*=)/m;
    if (definition.test(outside)) fail("Existing claude alias/function definition conflict; nothing was overwritten.");
    return { range, state: range ? current ? "installed" : "stale" : "absent" };
  }
  function backup(snapshot) {
    if (snapshot.bytes === null) return;
    checkDirectory(configRoot, true);
    checkDirectory(path.dirname(backups), true, true);
    checkDirectory(backups, true, true);
    const digest = crypto.createHash("sha256").update(snapshot.bytes).digest("hex");
    const file = path.join(backups, `zshrc-${digest}`);
    const info = statAt(file);
    if (!info) fsImpl.writeFileSync(file, snapshot.bytes, { flag: "wx", mode: 0o600 });
    else {
      if (!info.isFile() || info.isSymbolicLink() || !owned(info) || info.size !== snapshot.bytes.length) {
        fail("Unsafe launcher backup; nothing was overwritten.");
      }
      const fd = fsImpl.openSync(file, fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0));
      try {
        if (!sameEntry(info, fsImpl.fstatSync(fd)) || !fsImpl.readFileSync(fd).equals(snapshot.bytes)) {
          fail("Launcher backup digest mismatch; nothing was overwritten.");
        }
        fsImpl.fchmodSync(fd, 0o600);
      } finally { fsImpl.closeSync(fd); }
    }
  }
  function commit(snapshot, bytes, automatic) {
    const directory = checkDirectory(home);
    let temporary;
    try {
      backup(snapshot);
      temporary = path.join(home, `.zshrc-claude-proxy-${crypto.randomUUID()}.tmp`);
      fsImpl.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
      execFileSync("/bin/zsh", ["-f", "-n", temporary], { timeout: 5000, stdio: "pipe", env });
      if (automatic && getFeatures(featureFile, fsImpl).claudeLauncher === false) fail("Claude launcher was disabled during installation; nothing was overwritten.");
      const latest = readTarget();
      if (!sameEntry(directory, checkDirectory(home)) || !sameEntry(snapshot.info, latest.info) ||
        (snapshot.bytes === null ? latest.bytes !== null : !snapshot.bytes.equals(latest.bytes)) ||
        snapshot.info && (snapshot.info.mode !== latest.info.mode || snapshot.info.mtimeMs !== latest.info.mtimeMs)) {
        fail("Launcher target changed during installation; nothing was overwritten.");
      }
      if (snapshot.info) {
        fsImpl.chmodSync(temporary, snapshot.info.mode & 0o7777);
        fsImpl.renameSync(temporary, target);
      } else fsImpl.linkSync(temporary, target); // Never overwrite a concurrently created file.
    } finally {
      if (temporary && statAt(temporary)) fsImpl.unlinkSync(temporary);
    }
  }
  function validatePaths() {
    if (![home, configRoot, featureFile, nodePath, launcher].every(safePath)) fail("Unsafe launcher path; control characters and relative paths are not allowed.");
  }
  function install(enabled, automatic) {
    validatePaths();
    const snapshot = readTarget();
    const { range, state } = inspect(snapshot);
    if (enabled && state === "installed" || !enabled && state === "absent") {
      return { ok: true, changed: false, enabled, state };
    }
    if (enabled) {
      const version = execFileSync(nodePath, ["--version"], { encoding: "utf8", timeout: 5000, stdio: "pipe", env });
      if (!/^v\d+\.\d+\.\d+/.test(String(version))) fail("Node fallback could not be verified; nothing was overwritten.");
    }
    const original = snapshot.bytes || Buffer.alloc(0);
    let next;
    if (range) {
      const replacement = enabled ? Buffer.from(render(nodePath, launcher, range.eol) +
        (original[range.end - 1] === 10 ? range.eol : "")) : Buffer.alloc(0);
      next = Buffer.concat([original.subarray(0, range.start), replacement, original.subarray(range.end)]);
    } else {
      // zsh does not parse CRLF function delimiters. Keep existing bytes, but use LF for new shell code.
      const eol = "\n";
      const separator = original.length && original[original.length - 1] !== 10 ? eol : "";
      next = Buffer.concat([original, Buffer.from(separator + render(nodePath, launcher, eol) + eol)]);
    }
    commit(snapshot, next, automatic);
    return { ok: true, changed: true, enabled, state: enabled ? "installed" : "absent" };
  }
  function getStatus() {
    const reason = skipped();
    if (reason) return { enabled: false, state: "skipped", reason };
    try {
      validatePaths();
      const enabled = getFeatures(featureFile, fsImpl).claudeLauncher;
      return { enabled, state: inspect(readTarget()).state, reason: "" };
    } catch (error) { return { enabled: false, state: "conflict", reason: error.message }; }
  }
  function serialize(operation) {
    const pending = (queues.get(target) || Promise.resolve()).catch(() => {}).then(operation);
    queues.set(target, pending);
    return pending.finally(() => { if (queues.get(target) === pending) queues.delete(target); });
  }
  function performConfigure(enabled, automatic = false) {
    validatePaths();
    // Persist opt-out before attempting removal, even if a user-modified block cannot be removed.
    if (!enabled) setFeatures({ claudeLauncher: false }, featureFile, fsImpl);
    const result = install(enabled, automatic);
    if (enabled) {
      const chosen = getFeatures(featureFile, fsImpl).claudeLauncher;
      if (automatic && chosen === false) fail("Claude launcher was disabled during installation; opt-out was kept.");
      if (chosen !== true) setFeatures({ claudeLauncher: true }, featureFile, fsImpl);
    }
    return result;
  }
  function run(operation) {
    const reason = skipped();
    if (reason) {
      if (platform === "darwin") onWarning(reason);
      return Promise.resolve(null);
    }
    return serialize(() => {
      try { return operation(); }
      catch (error) { return { ok: false, changed: false, reason: `Claude launcher installation failed: ${error.message}` }; }
    });
  }
  const autoEnable = () => run(() => {
    try { if (!readCredentialAvailability({ env, store }).openai) return null; }
    catch (_) { return null; }
    return getFeatures(featureFile, fsImpl).claudeLauncher === false ? null : performConfigure(true, true);
  });
  const configure = (enabled) => run(() => performConfigure(enabled === true));
  return { autoEnable, getStatus, configure };
}

module.exports = { createClaudeLauncherInstaller };

if (require.main === module) {
  const option = process.argv[2];
  if (process.argv.length !== 3 || !["--enable", "--disable"].includes(option)) {
    console.error("Usage: node lib/claude-launcher-install.js --enable|--disable");
    process.exitCode = 1;
  } else {
    createClaudeLauncherInstaller().configure(option === "--enable").then((result) => {
      if (result?.ok === false) {
        console.warn(result.reason);
        process.exitCode = 1;
      } else console.log(result ? `Claude launcher ${result.enabled ? "enabled" : "disabled"}. Open a new terminal.` : "Claude launcher installation skipped.");
    }).catch((error) => { console.warn(error.message); process.exitCode = 1; });
  }
}
