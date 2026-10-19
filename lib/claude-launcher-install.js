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
const { createZshProfile } = require("./claude-launcher-zsh");
const { createPowerShellProfile } = require("./claude-launcher-powershell");

const START = "# >>> claude-proxy capacity launcher >>>";
const END = "# <<< claude-proxy capacity launcher <<<";
const queues = new Map();
const fail = (message) => { throw new Error(message); };
const safePath = (value) => typeof value === "string" && path.isAbsolute(value) && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const sameEntry = (a, b) => a === b || Boolean(a && b && a.ino === b.ino && a.dev === b.dev);

function createClaudeLauncherInstaller({ home = os.homedir(), env = process.env, platform = process.platform,
  configRoot = getClaudeConfigRoot(env, home), featureFile = getFeatureConfigPath(home),
  repoRoot = path.resolve(__dirname, ".."), nodePath = process.execPath, fsImpl = fs, store = defaultStore,
  execFileSync = execute, onWarning = (message) => console.warn(`[claude-launcher] ${message}`) } = {}) {
  const createProfile = platform === "win32" ? createPowerShellProfile : createZshProfile;
  const profile = createProfile({ home, env, platform, execFileSync, start: START, end: END });
  let target;
  const launcher = path.join(repoRoot, "lib", "claude-launch.js");
  const backups = path.join(configRoot, "claude-proxy", profile.backupDirectory);
  const owned = (stat) => !process.getuid || stat.uid === process.getuid();
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
    if (!stat?.isDirectory() || !owned(stat) || !(stat.mode & 0o222) || (profile.unixPermissions && (stat.mode & 0o022))) {
      fail("Launcher directory is unsafe or not writable.");
    }
    fsImpl.accessSync(directory, fsImpl.constants.W_OK | fsImpl.constants.X_OK);
    if (privateMode && profile.unixPermissions) fsImpl.chmodSync(directory, 0o700);
    return stat;
  }
  function readTarget() {
    const directory = path.dirname(target);
    checkParents(directory);
    if (statAt(directory)) checkDirectory(directory);
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
    const view = profile.decode(snapshot.bytes);
    const { text, encoding, offset, prefixLength } = view;
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
      if ((start && start !== prefixLength && text[start - 1] !== "\n") ||
        (end < text.length && text[end] !== "\n" && text.slice(end, end + 2) !== "\r\n")) {
        fail("Launcher marker conflict; nothing was overwritten.");
      }
      const bytes = snapshot.bytes.subarray(offset(start), offset(end));
      const content = bytes.toString(encoding);
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const old = profile.parse(content, eol);
      if (![old.node, old.launcher].every(safePath) || !/[\\/]lib[\\/]claude-launch\.js$/.test(old.launcher) ||
        !bytes.equals(Buffer.from(profile.render(old.node, old.launcher, eol), encoding))) {
        fail("Launcher block was modified; nothing was overwritten.");
      }
      const trailingNewline = text[end] === "\n" || text.slice(end, end + 2) === "\r\n";
      if (text.slice(end, end + 2) === "\r\n") end += 2;
      else if (text[end] === "\n") end++;
      range = { start: offset(start), end: offset(end), eol, trailingNewline, textStart: start, textEnd: end };
      current = old.node === nodePath && old.launcher === launcher;
    }
    const outside = (range ? text.slice(0, range.textStart) + text.slice(range.textEnd) : text).replace(profile.continuation, "");
    if (profile.definition.test(outside)) fail("Existing claude alias/function definition conflict; nothing was overwritten.");
    return { range, view, state: range ? current ? "installed" : "stale" : "absent" };
  }
  function backup(snapshot) {
    if (snapshot.bytes === null) return;
    checkDirectory(configRoot, true);
    checkDirectory(path.dirname(backups), true, true);
    checkDirectory(backups, true, true);
    const digest = crypto.createHash("sha256").update(snapshot.bytes).digest("hex");
    const file = path.join(backups, `${profile.backupName}-${digest}`);
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
        if (profile.unixPermissions) fsImpl.fchmodSync(fd, 0o600);
      } finally { fsImpl.closeSync(fd); }
    }
  }
  function commit(snapshot, bytes, automatic) {
    const parent = path.dirname(target);
    const directory = checkDirectory(parent, true);
    let temporary;
    try {
      backup(snapshot);
      temporary = path.join(parent, `.claude-proxy-${crypto.randomUUID()}.tmp`);
      fsImpl.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
      profile.validateSyntax(temporary);
      if (automatic && getFeatures(featureFile, fsImpl).claudeLauncher === false) fail("Claude launcher was disabled during installation; nothing was overwritten.");
      const latest = readTarget();
      if (!sameEntry(directory, checkDirectory(parent)) || !sameEntry(snapshot.info, latest.info) ||
        (snapshot.bytes === null ? latest.bytes !== null : !snapshot.bytes.equals(latest.bytes)) ||
        snapshot.info && (snapshot.info.mode !== latest.info.mode || snapshot.info.mtimeMs !== latest.info.mtimeMs)) {
        fail("Launcher target changed during installation; nothing was overwritten.");
      }
      if (snapshot.info) {
        if (profile.unixPermissions) fsImpl.chmodSync(temporary, snapshot.info.mode & 0o7777);
        fsImpl.renameSync(temporary, target);
      } else fsImpl.linkSync(temporary, target); // Never overwrite a concurrently created file.
    } finally {
      if (temporary && statAt(temporary)) fsImpl.unlinkSync(temporary);
    }
  }
  function validatePaths(resolveTarget = true) {
    if (![home, configRoot, featureFile, nodePath, launcher].every(safePath)) fail("Unsafe launcher path; control characters and relative paths are not allowed.");
    if (resolveTarget) {
      if (!target) target = profile.target();
      if (!safePath(target)) fail("Unsafe launcher target; nothing was overwritten.");
    }
  }
  function install(enabled, automatic) {
    validatePaths();
    const snapshot = readTarget();
    const { range, state, view } = inspect(snapshot);
    if (enabled && state === "installed" || !enabled && state === "absent") {
      return { ok: true, changed: false, enabled, state };
    }
    if (enabled) {
      const version = execFileSync(nodePath, ["--version"], { encoding: "utf8", timeout: 5000, stdio: "pipe", env });
      if (!/^v\d+\.\d+\.\d+/.test(String(version))) fail("Node fallback could not be verified; nothing was overwritten.");
    }
    const original = snapshot.bytes || Buffer.alloc(0);
    const rendered = profile.render(nodePath, launcher, range?.eol || profile.eol);
    if (enabled) profile.validateContent?.(original, rendered, view);
    let next;
    if (range) {
      const replacement = enabled ? Buffer.from(rendered + (range.trailingNewline ? range.eol : ""), view.encoding) : Buffer.alloc(0);
      next = Buffer.concat([original.subarray(0, range.start), replacement, original.subarray(range.end)]);
    } else {
      const separator = original.length && !original.toString(view.encoding).endsWith("\n") ? profile.eol : "";
      const prefix = !original.length && profile.newFilePrefix || Buffer.alloc(0);
      next = Buffer.concat([original, prefix, Buffer.from(separator + rendered + profile.eol, view.encoding)]);
    }
    commit(snapshot, next, automatic);
    return { ok: true, changed: true, enabled, state: enabled ? "installed" : "absent" };
  }
  function getStatus() {
    if (profile.reason) return { enabled: false, state: "skipped", reason: profile.reason };
    try {
      validatePaths();
      const enabled = getFeatures(featureFile, fsImpl).claudeLauncher;
      return { enabled, state: inspect(readTarget()).state, reason: "" };
    } catch (error) { return { enabled: false, state: "conflict", reason: error.message }; }
  }
  function serialize(operation) {
    const key = `${platform}:${home}`;
    const pending = (queues.get(key) || Promise.resolve()).catch(() => {}).then(operation);
    queues.set(key, pending);
    return pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); });
  }
  function performConfigure(enabled, automatic = false) {
    validatePaths(false);
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
    if (profile.reason) {
      if (profile.warnOnSkip) onWarning(profile.reason);
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
