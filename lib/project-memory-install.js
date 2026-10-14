"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getClaudeConfigRoot } = require("./claude-setup");
const { createSetupProbe } = require("./claude-probes");

const INSTALL_FILES = ["scripts/pcm.py", "references/record-format.md", "LICENSE", "SOURCE.md", "SKILL.md"];
const CORE_FILES = ["SKILL.md", "scripts/pcm.py", "references/record-format.md"];
const UPSTREAM_COMMIT = "7dc7b0dad137fa8e1e65af31143f4ead8109ca03";
const queues = new Map();
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const failure = (code) => Object.assign(new Error("Project Code Memory installation could not be completed."), { code });
const NOTICE = "Open a new Claude session after installation. Skill use is model-driven, not a hook. Query creates a project cache and updates .gitignore.";

function createProjectMemoryInstaller({ env = process.env, configRoot = getClaudeConfigRoot(env),
  bundleRoot = path.join(__dirname, "..", "project-code-memory"), platform = process.platform,
  fsImpl = fs, probe = createSetupProbe({ env, platform, includePython: true }), now = Date.now } = {}) {
  const root = path.resolve(configRoot);
  const skills = path.join(root, "skills");
  const target = path.join(skills, "project-code-memory");
  const privateRoot = path.join(root, "claude-proxy");
  const lockPath = path.join(privateRoot, ".project-code-memory-install.lock");
  const stagePrefix = path.join(privateRoot, ".project-code-memory-stage-");
  const conflict = () => failure("PROJECT_MEMORY_CONFLICT");
  let cached = null;
  let pending = null;

  // 所有路径固定；GET 只读，安装也不跟随符号链接或 chmod 用户已有目录。
  function stat(file) {
    try { return fsImpl.lstatSync(file); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  function same(a, b) { return Boolean(a && b && a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory()); }
  function directories(file) {
    const result = [];
    for (let current = path.resolve(file);; current = path.dirname(current)) {
      result.unshift(current);
      if (path.dirname(current) === current) break;
    }
    return result;
  }
  function safeDirectories(file) {
    for (const directory of directories(file)) {
      const info = stat(directory);
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw conflict();
    }
  }
  function checkPrivateRoot() {
    safeDirectories(privateRoot);
    const info = stat(privateRoot);
    if (info && platform !== "win32" && (info.mode & 0o077)) throw conflict();
  }
  function readRegular(file) {
    safeDirectories(path.dirname(file));
    const info = stat(file);
    if (!info || !info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw conflict();
    const fd = fsImpl.openSync(file, fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0));
    try {
      if (!same(info, fsImpl.fstatSync(fd))) throw conflict();
      const bytes = fsImpl.readFileSync(fd);
      if (!same(info, stat(file))) throw conflict();
      return bytes;
    } finally { fsImpl.closeSync(fd); }
  }
  function loadBundle() {
    try {
      const manifest = JSON.parse(readRegular(path.join(bundleRoot, "manifest.json")));
      if (manifest.version !== 1 || manifest.upstream?.commit !== UPSTREAM_COMMIT ||
        manifest.upstream?.url !== "https://github.com/shanshazhe/projectcodememory.git" ||
        JSON.stringify(manifest.installFiles) !== JSON.stringify(INSTALL_FILES)) throw new Error("Invalid manifest");
      const bytes = {};
      for (const relative of INSTALL_FILES) {
        bytes[relative] = readRegular(path.join(bundleRoot, relative));
        if (!/^[a-f0-9]{64}$/.test(manifest.files?.[relative]) || hash(bytes[relative]) !== manifest.files[relative]) throw new Error("Invalid bundle");
      }
      for (const relative of CORE_FILES) {
        if (!/^[a-f0-9]{64}$/.test(manifest.upstreamFiles?.[relative])) throw new Error("Invalid upstream hash");
      }
      if (manifest.files["scripts/pcm.py"] !== manifest.upstreamFiles["scripts/pcm.py"]) throw new Error("Modified Python source");
      return { manifest, bytes };
    } catch (_) { throw failure("PROJECT_MEMORY_UNAVAILABLE"); }
  }
  function inspect(bundle) {
    safeDirectories(target);
    if (!stat(target)) {
      const parent = directories(skills).reverse().find((directory) => stat(directory));
      fsImpl.accessSync(parent, fsImpl.constants.W_OK | fsImpl.constants.X_OK);
      if (platform !== "win32" && !(stat(parent).mode & 0o222)) throw failure("PROJECT_MEMORY_UNAVAILABLE");
      return false;
    }
    const matches = (files, hashes) => {
      try { return files.every((relative) => hash(readRegular(path.join(target, relative))) === hashes[relative]); }
      catch (_) { return false; }
    };
    if (matches(INSTALL_FILES, bundle.manifest.files) || matches(CORE_FILES, bundle.manifest.upstreamFiles)) return true;
    throw conflict();
  }
  function status(state, reason = "") {
    return { installed: state === "installed", ready: state === "installed" || state === "absent", state, reason, notice: NOTICE };
  }
  async function check() {
    try {
      const bundle = loadBundle();
      safeDirectories(skills);
      checkPrivateRoot();
      const lock = stat(lockPath);
      if (lock) {
        if (!lock.isFile() || lock.isSymbolicLink()) throw conflict();
        return status("busy", "An installation lock exists. Wait for the active operation; handle abandoned locks manually.");
      }
      if (inspect(bundle)) return status("installed");
      const dependencies = await probe();
      if (!dependencies.cli || !dependencies.python) return status("unavailable", "Install Claude CLI and Python 3.9+ manually first.");
      return status("absent");
    } catch (error) {
      return error.code === "PROJECT_MEMORY_CONFLICT"
        ? status("conflict", "Existing skill or directories are unsafe or different. Handle them manually; nothing will be overwritten.")
        : status("unavailable", "Project Code Memory is unavailable. Check the bundled files and dependencies.");
    }
  }
  function getStatus() {
    if (pending) return pending;
    if (cached && now() - cached.time < 2000) return Promise.resolve(cached.value);
    pending = check().then((value) => { cached = { time: now(), value }; return value; }).finally(() => { pending = null; });
    return pending;
  }

  async function performInstall() {
    let bundle = loadBundle();
    if (inspect(bundle)) return { ok: true, changed: false, ...status("installed") };
    let dependencies;
    try { dependencies = await probe(); } catch (_) { throw failure("PROJECT_MEMORY_UNAVAILABLE"); }
    if (!dependencies.cli || !dependencies.python) throw failure("PROJECT_MEMORY_UNAVAILABLE");
    // 探测期间目标可能改变；锁前和发布前都重新核对。
    bundle = loadBundle();
    if (inspect(bundle)) return { ok: true, changed: false, ...status("installed") };
    const owned = [];
    const guards = new Map();
    let completed = false;
    let cleanupChanged = false;
    function rememberDirectories(directory) {
      safeDirectories(directory);
      for (const entry of directories(directory)) {
        const info = stat(entry);
        if (info) {
          if (guards.has(entry) && !same(guards.get(entry), info)) throw conflict();
          guards.set(entry, info);
        }
      }
    }
    function guard() {
      for (const [entry, info] of guards) {
        const current = stat(entry);
        if (!same(info, current) || current.isSymbolicLink()) throw conflict();
      }
    }
    function newDirectory(directory, kind) {
      guard();
      fsImpl.mkdirSync(directory, { mode: 0o700 }); // 非 recursive 排他归属，绝不 rename 覆盖目录。
      const info = stat(directory);
      if (!info?.isDirectory() || info.isSymbolicLink()) throw conflict();
      owned.push({ file: directory, info, kind, directory: true });
      guards.set(directory, info);
      guard();
    }
    function ensureDirectory(directory) {
      rememberDirectories(directory);
      if (stat(directory)) return;
      ensureDirectory(path.dirname(directory));
      try { newDirectory(directory, "parent"); } catch (error) {
        if (error.code !== "EEXIST") throw error;
        rememberDirectories(directory);
      }
    }
    function newFile(file, bytes, kind) {
      guard();
      const fd = fsImpl.openSync(file, "wx", 0o600);
      let item;
      try {
        item = { file, info: fsImpl.fstatSync(fd), digest: hash(Buffer.alloc(0)), kind };
        owned.push(item);
        let offset = 0;
        while (offset < bytes.length) {
          const written = fsImpl.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) throw failure("PROJECT_MEMORY_UNAVAILABLE");
          offset += written;
          // 已成功短写的字节也是本次归属；未知/外部改动的字节仍保留。
          item.digest = hash(bytes.subarray(0, offset));
        }
        fsImpl.fsyncSync(fd);
      } finally { fsImpl.closeSync(fd); }
      guard();
      if (!same(item.info, stat(file)) || hash(readRegular(file)) !== item.digest) throw conflict();
    }
    function publishSkill(source, file, bytes) {
      guard();
      const info = stat(source);
      if (!info?.isFile() || info.isSymbolicLink()) throw conflict();
      // 同卷 hard-link 排他、原子发布完整 SKILL；崩溃也不会留下可发现的半文件。
      fsImpl.linkSync(source, file);
      const item = { file, info, digest: hash(bytes), kind: "target" };
      owned.push(item);
      guard();
      if (!same(info, stat(file)) || hash(readRegular(file)) !== item.digest) throw conflict();
    }
    function cleanupItem(item) {
      try {
        // 父目录被替换时绝不访问/删除替换目录里的同名文件。
        for (const directory of directories(path.dirname(item.file))) {
          if (guards.has(directory) && !same(guards.get(directory), stat(directory))) return false;
        }
        safeDirectories(path.dirname(item.file));
        const current = stat(item.file);
        if (!current) return true;
        if (!same(item.info, current) || current.isSymbolicLink()) return false;
        if (item.directory) {
          if (fsImpl.readdirSync(item.file).length) return false;
          fsImpl.rmdirSync(item.file);
          guards.delete(item.file);
        } else {
          if (hash(readRegular(item.file)) !== item.digest) return false;
          fsImpl.unlinkSync(item.file);
        }
        return true;
      } catch (_) { return false; }
    }
    let result;
    let problem;
    try {
      rememberDirectories(privateRoot);
      ensureDirectory(privateRoot);
      checkPrivateRoot();
      rememberDirectories(skills);
      ensureDirectory(skills);
      try { newFile(lockPath, Buffer.from(JSON.stringify({ pid: process.pid, id: crypto.randomUUID() }) + "\n"), "lock"); }
      catch (error) {
        if (error.code === "EEXIST") throw failure("PROJECT_MEMORY_BUSY");
        throw error;
      }
      bundle = loadBundle();
      if (inspect(bundle)) {
        completed = true;
        result = { ok: true, changed: false, ...status("installed") };
      } else {
        guard();
        const stage = fsImpl.mkdtempSync(stagePrefix);
        const info = stat(stage);
        owned.push({ file: stage, info, kind: "stage", directory: true });
        guards.set(stage, info);
        if (platform !== "win32") fsImpl.chmodSync(stage, 0o700);
        for (const relative of ["scripts", "references"]) newDirectory(path.join(stage, relative), "stage");
        for (const relative of INSTALL_FILES) newFile(path.join(stage, relative), bundle.bytes[relative], "stage");
        guard();
        try { newDirectory(target, "target"); } catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (!inspect(bundle)) throw conflict();
          completed = true;
          result = { ok: true, changed: false, ...status("installed") };
        }
        if (!completed) {
          for (const relative of ["scripts", "references"]) newDirectory(path.join(target, relative), "target");
          // SKILL.md 最后发布，Claude 不会发现缺少数据/引用/许可证的半安装。
          for (const relative of INSTALL_FILES) {
            const bytes = readRegular(path.join(stage, relative));
            if (hash(bytes) !== bundle.manifest.files[relative]) throw conflict();
            if (relative === "SKILL.md") {
              for (const required of INSTALL_FILES.slice(0, -1)) {
                if (hash(readRegular(path.join(target, required))) !== bundle.manifest.files[required]) throw conflict();
              }
            }
            if (relative === "SKILL.md") publishSkill(path.join(stage, relative), path.join(target, relative), bytes);
            else newFile(path.join(target, relative), bytes, "target");
          }
          guard();
          if (!inspect(bundle)) throw conflict();
          completed = true;
          result = { ok: true, changed: true, ...status("installed") };
        }
      }
    } catch (error) { problem = error; }
    finally {
      for (const item of owned.reverse()) {
        if (completed && (item.kind === "target" || item.kind === "parent")) continue;
        if (!cleanupItem(item)) cleanupChanged = true;
      }
    }
    if (cleanupChanged) throw conflict();
    if (problem) throw problem.code?.startsWith("PROJECT_MEMORY_") ? problem
      : failure(["EEXIST", "ENOTDIR", "ELOOP"].includes(problem.code) ? "PROJECT_MEMORY_CONFLICT" : "PROJECT_MEMORY_UNAVAILABLE");
    return result;
  }
  function install() {
    const previous = queues.get(root) || Promise.resolve();
    const work = previous.catch(() => {}).then(performInstall).catch((error) => {
      throw failure(["PROJECT_MEMORY_CONFLICT", "PROJECT_MEMORY_BUSY", "PROJECT_MEMORY_UNAVAILABLE"].includes(error.code)
        ? error.code : "PROJECT_MEMORY_UNAVAILABLE");
    });
    queues.set(root, work);
    return work.finally(() => {
      cached = null;
      if (queues.get(root) === work) queues.delete(root);
    });
  }

  return { getStatus, install };
}

module.exports = { createProjectMemoryInstaller, INSTALL_FILES };
