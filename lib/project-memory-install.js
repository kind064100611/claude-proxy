"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getClaudeConfigRoot } = require("./claude-setup");
const { createSetupProbe } = require("./claude-probes");

const INSTALL_FILES = ["scripts/pcm.py", "references/record-format.md", "LICENSE", "SOURCE.md", "SKILL.md"];
const CORE_FILES = ["SKILL.md", "scripts/pcm.py", "references/record-format.md"];
const UPSTREAM_COMMIT = "7dc7b0dad137fa8e1e65af31143f4ead8109ca03";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const failure = (code) => Object.assign(new Error("Project Code Memory installation could not be completed."), { code });
const NOTICE = "Open a new Claude session after installation. Skill use is model-driven, not a hook. Query creates a project cache and updates .gitignore.";

function createProjectMemoryInstaller({ env = process.env, configRoot = getClaudeConfigRoot(env),
  bundleRoot = path.join(__dirname, "..", "project-code-memory"), platform = process.platform,
  fsImpl = fs, probe = createSetupProbe({ env, platform, includePython: true }), now = Date.now } = {}) {
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
  // 目标不存在返回 false；与本版本或上游原版一致返回 true；其他内容一律视为冲突，绝不覆盖。
  function inspect({ manifest }) {
    try { fsImpl.lstatSync(target); } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    const matches = (files, hashes) => files.every((relative) => {
      try { return hash(fsImpl.readFileSync(path.join(target, relative))) === hashes?.[relative]; } catch (_) { return false; }
    });
    if (matches(INSTALL_FILES, manifest.files) || matches(CORE_FILES, manifest.upstreamFiles)) return true;
    throw failure("PROJECT_MEMORY_CONFLICT");
  }
  function status(state, reason = "") {
    return { installed: state === "installed", ready: state === "installed" || state === "absent", state, reason, notice: NOTICE };
  }
  async function check() {
    try {
      if (inspect(loadBundle())) return status("installed");
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
    const bundle = loadBundle();
    if (inspect(bundle)) return { ok: true, changed: false, ...status("installed") };
    const dependencies = await probe();
    if (!dependencies.cli || !dependencies.python) throw failure("PROJECT_MEMORY_UNAVAILABLE");
    fsImpl.mkdirSync(skills, { recursive: true, mode: 0o700 });
    fsImpl.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    // 先在 claude-proxy 私有目录写全，再整体 rename 到 skills，Claude 不会发现半安装。
    const stage = fsImpl.mkdtempSync(path.join(privateRoot, ".project-code-memory-stage-"));
    try {
      for (const relative of INSTALL_FILES) {
        fsImpl.mkdirSync(path.join(stage, path.dirname(relative)), { recursive: true, mode: 0o700 });
        fsImpl.writeFileSync(path.join(stage, relative), bundle.bytes[relative], { mode: 0o600 });
      }
      fsImpl.renameSync(stage, target);
    } catch (error) {
      fsImpl.rmSync(stage, { recursive: true, force: true });
      // 目标在写入期间被外部创建：rename 失败，保留对方内容。
      throw ["EEXIST", "ENOTEMPTY"].includes(error.code) ? failure("PROJECT_MEMORY_CONFLICT") : error;
    }
    return { ok: true, changed: true, ...status("installed") };
  }
  function install() {
    const work = queue.then(performInstall).catch((error) => {
      throw failure(error.code === "PROJECT_MEMORY_CONFLICT" ? error.code : "PROJECT_MEMORY_UNAVAILABLE");
    });
    queue = work.catch(() => {});
    return work.finally(() => { cached = null; });
  }

  return { getStatus, install };
}

module.exports = { createProjectMemoryInstaller, INSTALL_FILES };
