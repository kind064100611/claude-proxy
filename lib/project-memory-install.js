"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getClaudeConfigRoot } = require("./claude-setup");
const { createSetupProbe } = require("./claude-probes");
const { getFeatureConfigPath, getStatus: getFeatures, setFeatures } = require("./online-summary");

// 只安装查询用的技能；记录由代理在后台维护，record-format.md 留在包里作为维护提示词的参考。
const INSTALL_FILES = ["scripts/pcm.py", "LICENSE", "SOURCE.md", "SKILL.md"];
// 文件本身及所在的各级目录（以 / 结尾），不允许额外内容或符号链接。
const entriesOf = (files) => JSON.stringify([...new Set(files.flatMap((file) =>
  [file, ...file.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/") + "/")]))].sort());
const UPSTREAM_COMMIT = "7dc7b0dad137fa8e1e65af31143f4ead8109ca03";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const failure = (code) => Object.assign(new Error("Project Code Memory installation could not be completed."), { code });
const CONFLICT = "An older or different project-code-memory skill is installed. Turning this on backs up the existing skill to claude-proxy/skill-backups/ in your Claude CLI directory, then installs the query-only skill.";
const NOTICE = "Open a new Claude session after turning this on or off. Skill use is model-driven, not a hook. Query creates a project cache and updates .gitignore; the gateway only maintains existing caches.";

function createProjectMemoryInstaller({ env = process.env, configRoot = getClaudeConfigRoot(env),
  bundleRoot = path.join(__dirname, "..", "project-code-memory"), platform = process.platform,
  fsImpl = fs, probe = createSetupProbe({ env, platform, includePython: true }), now = Date.now, featureFile = getFeatureConfigPath() } = {}) {
  const skills = path.join(path.resolve(configRoot), "skills");
  const target = path.join(skills, "project-code-memory");
  const privateRoot = path.join(path.resolve(configRoot), "claude-proxy");
  const backups = path.join(privateRoot, "skill-backups");
  let cached = null;
  let pending = null;
  let queue = Promise.resolve();

  function loadBundle() {
    try {
      const manifest = JSON.parse(fsImpl.readFileSync(path.join(bundleRoot, "manifest.json"), "utf8"));
      if (manifest.version !== 1 || manifest.upstream?.commit !== UPSTREAM_COMMIT ||
        manifest.upstream?.url !== "https://github.com/shanshazhe/projectcodememory.git" ||
        JSON.stringify(manifest.installFiles) !== JSON.stringify(INSTALL_FILES)) throw new Error("Invalid manifest");
      const bytes = {};
      for (const relative of INSTALL_FILES) {
        bytes[relative] = fsImpl.readFileSync(path.join(bundleRoot, relative));
        if (hash(bytes[relative]) !== manifest.files?.[relative]) throw new Error("Invalid bundle");
      }
      if (manifest.files["scripts/pcm.py"] !== manifest.upstreamFiles?.["scripts/pcm.py"]) throw new Error("Modified Python source");
      return { manifest, bytes };
    } catch (_) { throw failure("PROJECT_MEMORY_UNAVAILABLE"); }
  }
  // 目标不存在返回 false；恰好是本版本部署的文件（无多余文件或目录、无符号链接）返回 true；
  // 其他内容一律视为冲突；显式开启可先备份再替换，自动开启只升级完整匹配 previousDeployments 的旧版。
  function inspect({ manifest }, directory = target) {
    try { fsImpl.lstatSync(directory); } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    const found = [];
    const visit = (relative) => {
      const stat = fsImpl.lstatSync(path.join(directory, relative));
      if (stat.isDirectory()) {
        if (relative) found.push(relative + "/");
        for (const name of fsImpl.readdirSync(path.join(directory, relative))) visit(path.posix.join(relative, name));
      } else if (stat.isFile()) found.push(relative);
      else throw failure("PROJECT_MEMORY_CONFLICT");
    };
    visit("");
    const entries = JSON.stringify(found.sort());
    const matches = (files) => entries === entriesOf(Object.keys(files)) &&
      Object.entries(files).every(([relative, digest]) => hash(fsImpl.readFileSync(path.join(directory, relative))) === digest);
    if (matches(Object.fromEntries(INSTALL_FILES.map((relative) => [relative, manifest.files[relative]])))) return true;
    const previous = (manifest.previousDeployments || []).some((deployment) => matches(deployment.files));
    throw Object.assign(failure("PROJECT_MEMORY_CONFLICT"), { previous });
  }
  function status(state, reason = "") {
    return { enabled: getFeatures(featureFile).projectMemory === true, installed: state === "installed",
      ready: ["installed", "absent", "conflict"].includes(state), state, reason, notice: NOTICE };
  }
  async function check() {
    const unavailable = () => status("unavailable", "Project Code Memory is unavailable. Check the bundled files and dependencies.");
    let conflict = false;
    try {
      if (inspect(loadBundle())) return status("installed");
    } catch (error) {
      if (error.code !== "PROJECT_MEMORY_CONFLICT") return unavailable();
      conflict = true;
    }
    try {
      const dependencies = await probe();
      if (!dependencies.cli || !dependencies.python) return status("unavailable", "Install Claude CLI and Python 3.9+ manually first.");
    } catch (_) { return unavailable(); }
    return conflict ? status("conflict", CONFLICT) : status("absent");
  }
  // 开关每次重新读取，只有文件检查与依赖探测结果短暂缓存。
  function getStatus() {
    const fresh = (value) => ({ ...value, enabled: getFeatures(featureFile).projectMemory === true });
    if (pending) return pending.then(fresh);
    if (cached && now() - cached.time < 2000) return Promise.resolve(fresh(cached.value));
    pending = check().then((value) => { cached = { time: now(), value }; return value; }).finally(() => { pending = null; });
    return pending.then(fresh);
  }

  function statAt(directory) {
    try { return fsImpl.lstatSync(directory); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  const sameEntry = (a, b) => a === b || Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
  function ensureDirectory(directory, recursive = false) {
    if (!statAt(directory)) fsImpl.mkdirSync(directory, { recursive, mode: 0o700 });
    const stat = statAt(directory);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw failure("PROJECT_MEMORY_CONFLICT");
  }
  // rename 在 POSIX 上能覆盖空目录；恢复时也必须先检查，原位置已被占用就保留备份。
  function restore(from) {
    try { if (!statAt(target)) fsImpl.renameSync(from, target); } catch (_) { /* 保留备份或卸载临时目录。 */ }
  }
  async function performInstall(replace = false, requireDependencies = false) {
    const bundle = loadBundle();
    const original = statAt(target);
    const inspectForInstall = (directory = target) => {
      try { return inspect(bundle, directory); } catch (error) {
        // 显式开启可替换任何冲突；自动开启只替换完整、未修改的已知旧版。
        if (error.code !== "PROJECT_MEMORY_CONFLICT" || !(replace === true || (replace === "previous" && error.previous))) throw error;
        return false;
      }
    };
    const unchanged = () => ({ ok: true, changed: false, replaced: false, ...status("installed") });
    const installed = inspectForInstall();
    if (installed && !requireDependencies) return unchanged();
    const dependencies = await probe();
    if (!dependencies.cli || !dependencies.python) throw failure("PROJECT_MEMORY_UNAVAILABLE");
    // 探测和写 stage 后重查身份及完整内容；后来出现的目标不能被当作原冲突移走。
    const recheck = () => {
      if (!sameEntry(original, statAt(target))) {
        if (inspect(bundle)) return true;
        throw failure("PROJECT_MEMORY_CONFLICT");
      }
      return inspectForInstall();
    };
    if (recheck()) return unchanged();
    ensureDirectory(path.resolve(configRoot), true);
    ensureDirectory(skills);
    ensureDirectory(privateRoot);
    // 先在 claude-proxy 私有目录写全，旧 skill 等到新文件就绪才整体备份（符号链接只移动链接本身）。
    const stage = fsImpl.mkdtempSync(path.join(privateRoot, ".project-code-memory-stage-"));
    let backup = null;
    try {
      for (const relative of INSTALL_FILES) {
        fsImpl.mkdirSync(path.join(stage, path.dirname(relative)), { recursive: true, mode: 0o700 });
        fsImpl.writeFileSync(path.join(stage, relative), bundle.bytes[relative], { mode: 0o600 });
      }
      if (recheck()) return unchanged();
      if (original) {
        ensureDirectory(privateRoot);
        ensureDirectory(backups);
        const stamp = new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
        const destination = path.join(backups, `project-code-memory-${stamp}-${crypto.randomBytes(8).toString("hex")}`);
        if (statAt(destination)) throw failure("PROJECT_MEMORY_CONFLICT");
        if (recheck()) return unchanged();
        fsImpl.renameSync(target, destination);
        backup = destination;
        if (!sameEntry(original, statAt(backup))) throw failure("PROJECT_MEMORY_CONFLICT");
        if (replace === "previous" && inspectForInstall(backup)) throw failure("PROJECT_MEMORY_CONFLICT");
      }
      if (statAt(target)) throw failure("PROJECT_MEMORY_CONFLICT");
      fsImpl.renameSync(stage, target);
    } catch (error) {
      if (backup) restore(backup);
      throw ["EEXIST", "ENOTEMPTY"].includes(error.code) ? failure("PROJECT_MEMORY_CONFLICT") : error;
    } finally {
      fsImpl.rmSync(stage, { recursive: true, force: true });
    }
    return { ok: true, changed: true, replaced: Boolean(backup), ...status("installed") };
  }
  // 只删除与本版本逐字节一致、没有多余文件的目录：先改名到私有临时目录再复查，复查不一致就放回原处。
  function performUninstall() {
    const bundle = loadBundle();
    if (!inspect(bundle)) return { ok: true, changed: false, ...status("absent") };
    const stage = path.join(skills, `.project-code-memory-remove-${crypto.randomBytes(8).toString("hex")}`);
    fsImpl.renameSync(target, stage);
    let verified = false;
    try { verified = inspect(bundle, stage); } catch (_) { /* 改名后被修改：放回原处。 */ }
    if (!verified) {
      restore(stage);
      throw failure("PROJECT_MEMORY_CONFLICT");
    }
    fsImpl.rmSync(stage, { recursive: true, force: true });
    return { ok: true, changed: true, ...status("absent") };
  }
  // 开启：确认 CLI 与 Python（后台维护需要）→ 安装 → 打开开关；关闭：先关开关立即停止注入，再卸载。
  async function performConfigure(enabled, replace = false) {
    if (!enabled) {
      setFeatures({ projectMemory: false }, featureFile);
      return performUninstall();
    }
    const result = await performInstall(replace, true);
    setFeatures({ projectMemory: true }, featureFile);
    return { ...result, enabled: true };
  }
  function serialize(operation) {
    const work = queue.then(operation).catch((error) => {
      throw failure(error.code === "PROJECT_MEMORY_CONFLICT" ? error.code : "PROJECT_MEMORY_UNAVAILABLE");
    });
    queue = work.catch(() => {});
    return work.finally(() => { cached = null; });
  }

  // 用户从未选择过时，能安装就打开，精确匹配的已知旧版先备份再升级；未知冲突保持不动。
  // 缺依赖时不写文件，显式关闭后永不自动打开。
  const autoEnable = () => serialize(() => getFeatures(featureFile).projectMemory === null ? performConfigure(true, "previous") : null);

  return { getStatus, install: () => serialize(() => performInstall()), uninstall: () => serialize(performUninstall),
    configure: (enabled) => serialize(() => performConfigure(enabled === true, true)), autoEnable };
}

module.exports = { createProjectMemoryInstaller, INSTALL_FILES };
