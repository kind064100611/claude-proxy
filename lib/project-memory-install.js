"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getClaudeConfigRoot } = require("./claude-setup");
const { createSetupProbe } = require("./claude-probes");
const { getFeatureConfigPath, getStatus: getFeatures, setFeatures } = require("./online-summary");

// 只安装查询用的技能；记录由代理在后台维护，record-format.md 留在包里作为维护提示词的参考。
const INSTALL_FILES = ["scripts/pcm.py", "LICENSE", "SOURCE.md", "SKILL.md"];
const DEPLOYED_ENTRIES = JSON.stringify([...INSTALL_FILES, "scripts/"].sort());
const UPSTREAM_COMMIT = "7dc7b0dad137fa8e1e65af31143f4ead8109ca03";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const failure = (code) => Object.assign(new Error("Project Code Memory installation could not be completed."), { code });
const NOTICE = "Open a new Claude session after turning this on or off. Skill use is model-driven, not a hook. Query creates a project cache and updates .gitignore; the gateway only maintains existing caches.";

function createProjectMemoryInstaller({ env = process.env, configRoot = getClaudeConfigRoot(env),
  bundleRoot = path.join(__dirname, "..", "project-code-memory"), platform = process.platform,
  fsImpl = fs, probe = createSetupProbe({ env, platform, includePython: true }), now = Date.now, featureFile = getFeatureConfigPath() } = {}) {
  const skills = path.join(path.resolve(configRoot), "skills");
  const target = path.join(skills, "project-code-memory");
  const privateRoot = path.join(path.resolve(configRoot), "claude-proxy");
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
  // 其他内容（包括上游完整技能）一律视为冲突，绝不覆盖或删除：完整技能会让主模型自己维护记录。
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
    if (JSON.stringify(found.sort()) === DEPLOYED_ENTRIES &&
      INSTALL_FILES.every((relative) => hash(fsImpl.readFileSync(path.join(directory, relative))) === manifest.files[relative])) return true;
    throw failure("PROJECT_MEMORY_CONFLICT");
  }
  function status(state, reason = "") {
    return { enabled: getFeatures(featureFile).projectMemory === true, installed: state === "installed",
      ready: state === "installed" || state === "absent", state, reason, notice: NOTICE };
  }
  async function check() {
    try {
      if (inspect(loadBundle())) return status("installed");
      const dependencies = await probe();
      if (!dependencies.cli || !dependencies.python) return status("unavailable", "Install Claude CLI and Python 3.9+ manually first.");
      return status("absent");
    } catch (error) {
      return error.code === "PROJECT_MEMORY_CONFLICT"
        ? status("conflict", "An existing project-code-memory skill differs from the bundled query-only skill. Handle it manually; nothing will be overwritten or removed.")
        : status("unavailable", "Project Code Memory is unavailable. Check the bundled files and dependencies.");
    }
  }
  // 开关每次重新读取，只有文件检查与依赖探测结果短暂缓存。
  function getStatus() {
    const fresh = (value) => ({ ...value, enabled: getFeatures(featureFile).projectMemory === true });
    if (pending) return pending.then(fresh);
    if (cached && now() - cached.time < 2000) return Promise.resolve(fresh(cached.value));
    pending = check().then((value) => { cached = { time: now(), value }; return value; }).finally(() => { pending = null; });
    return pending.then(fresh);
  }

  async function performInstall(dependencies) {
    const bundle = loadBundle();
    if (inspect(bundle)) return { ok: true, changed: false, ...status("installed") };
    dependencies ||= await probe();
    if (!dependencies.cli || !dependencies.python) throw failure("PROJECT_MEMORY_UNAVAILABLE");
    // 异步探测后重新检查：POSIX rename 会覆盖后来出现的空目录，不能只依赖 rename 失败。
    if (inspect(bundle)) return { ok: true, changed: false, ...status("installed") };
    fsImpl.mkdirSync(skills, { recursive: true, mode: 0o700 });
    fsImpl.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    // 先在 claude-proxy 私有目录写全，再整体 rename 到 skills，Claude 不会发现半安装。
    const stage = fsImpl.mkdtempSync(path.join(privateRoot, ".project-code-memory-stage-"));
    try {
      for (const relative of INSTALL_FILES) {
        fsImpl.mkdirSync(path.join(stage, path.dirname(relative)), { recursive: true, mode: 0o700 });
        fsImpl.writeFileSync(path.join(stage, relative), bundle.bytes[relative], { mode: 0o600 });
      }
      if (inspect(bundle)) return { ok: true, changed: false, ...status("installed") };
      fsImpl.renameSync(stage, target);
    } catch (error) {
      // 目标在写入期间被外部创建：保留对方内容。
      throw ["EEXIST", "ENOTEMPTY"].includes(error.code) ? failure("PROJECT_MEMORY_CONFLICT") : error;
    } finally {
      fsImpl.rmSync(stage, { recursive: true, force: true });
    }
    return { ok: true, changed: true, ...status("installed") };
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
      try { fsImpl.renameSync(stage, target); } catch (_) { /* 原位置已被占用时保留在临时目录。 */ }
      throw failure("PROJECT_MEMORY_CONFLICT");
    }
    fsImpl.rmSync(stage, { recursive: true, force: true });
    return { ok: true, changed: true, ...status("absent") };
  }
  // 开启：确认 CLI 与 Python（后台维护需要）→ 安装 → 打开开关；关闭：先关开关立即停止注入，再卸载。
  async function performConfigure(enabled) {
    if (!enabled) {
      setFeatures({ projectMemory: false }, featureFile);
      return performUninstall();
    }
    const dependencies = await probe();
    if (!dependencies.cli || !dependencies.python) throw failure("PROJECT_MEMORY_UNAVAILABLE");
    const result = await performInstall(dependencies);
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

  // 用户从未选择过时，能安装就按勾选处理（安装并打开）；缺依赖或已有冲突目录时不写任何文件，保持关闭。显式关闭后永不自动打开。
  const autoEnable = () => serialize(() => getFeatures(featureFile).projectMemory === null ? performConfigure(true) : null);

  return { getStatus, install: () => serialize(() => performInstall()), uninstall: () => serialize(performUninstall),
    configure: (enabled) => serialize(() => performConfigure(enabled === true)), autoEnable };
}

module.exports = { createProjectMemoryInstaller, INSTALL_FILES };
