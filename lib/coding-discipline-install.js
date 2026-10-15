"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getClaudeConfigRoot } = require("./claude-setup");
const { createSetupProbe } = require("./claude-probes");

const INSTALL_FILES = ["LICENSE", "SOURCE.md", "SKILL.md"];
const UPSTREAM_COMMIT = "2c606141936f1eeef17fa3043a72095b4765b9c2";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const failure = (code) => Object.assign(new Error("Coding Discipline installation could not be completed."), { code });
const NOTICE = "Open a new Claude session after installation. Skill use is model-driven, not a hook.";

function createCodingDisciplineInstaller({ env = process.env, configRoot = getClaudeConfigRoot(env),
  bundleRoot = path.join(__dirname, "..", "coding-discipline"), platform = process.platform,
  fsImpl = fs, probe = createSetupProbe({ env, platform }), now = Date.now } = {}) {
  const skills = path.join(path.resolve(configRoot), "skills");
  const target = path.join(skills, "coding-discipline");
  let cached = null;
  let pending = null;
  let queue = Promise.resolve();

  function loadBundle() {
    try {
      const manifest = JSON.parse(fsImpl.readFileSync(path.join(bundleRoot, "manifest.json"), "utf8"));
      if (manifest.version !== 1 || manifest.upstream?.commit !== UPSTREAM_COMMIT ||
        manifest.upstream?.url !== "https://github.com/multica-ai/andrej-karpathy-skills" ||
        JSON.stringify(manifest.installFiles) !== JSON.stringify(INSTALL_FILES)) throw new Error("Invalid manifest");
      const bytes = {};
      for (const relative of INSTALL_FILES) {
        bytes[relative] = fsImpl.readFileSync(path.join(bundleRoot, relative));
        if (hash(bytes[relative]) !== manifest.files?.[relative]) throw new Error("Invalid bundle");
      }
      return { manifest, bytes };
    } catch (_) { throw failure("CODING_DISCIPLINE_UNAVAILABLE"); }
  }
  // SKILL.md 与本版本一致即视为已安装（含只放了 SKILL.md 的手动安装）。
  function isInstalled({ manifest }) {
    try { return hash(fsImpl.readFileSync(path.join(target, "SKILL.md"))) === manifest.files["SKILL.md"]; }
    catch (_) { return false; }
  }
  function status(state, reason = "") {
    return { installed: state === "installed", ready: state === "installed" || state === "absent", state, reason, notice: NOTICE };
  }
  async function check() {
    try {
      if (isInstalled(loadBundle())) return status("installed");
      const dependencies = await probe();
      if (!dependencies.cli) return status("unavailable", "Install Claude CLI manually first.");
      return status("absent");
    } catch (_) {
      return status("unavailable", "Coding Discipline is unavailable. Check the bundled files and Claude CLI.");
    }
  }
  function getStatus() {
    if (pending) return pending;
    if (cached && now() - cached.time < 2000) return Promise.resolve(cached.value);
    pending = check().then((value) => { cached = { time: now(), value }; return value; }).finally(() => { pending = null; });
    return pending;
  }

  // 每次点击都用本版本整体替换目标目录（不论原内容），不做冲突检查。
  async function performInstall() {
    const bundle = loadBundle();
    const dependencies = await probe();
    if (!dependencies.cli) throw failure("CODING_DISCIPLINE_UNAVAILABLE");
    fsImpl.mkdirSync(skills, { recursive: true, mode: 0o700 });
    // 先在同目录私有临时目录写全，再整体 rename，Claude 不会发现半安装。
    const stage = fsImpl.mkdtempSync(path.join(skills, ".coding-discipline-stage-"));
    let previous = null;
    try {
      for (const relative of INSTALL_FILES) fsImpl.writeFileSync(path.join(stage, relative), bundle.bytes[relative], { mode: 0o600 });
      if (exists(target)) {
        previous = path.join(skills, `.coding-discipline-old-${crypto.randomUUID()}`);
        fsImpl.renameSync(target, previous);
      }
      fsImpl.renameSync(stage, target);
    } catch (error) {
      // 发布失败时恢复旧内容。
      if (previous && !exists(target)) { fsImpl.renameSync(previous, target); previous = null; }
      fsImpl.rmSync(stage, { recursive: true, force: true });
      throw error;
    }
    // 旧目标若是符号链接，只删除链接本身，不跟随。
    if (previous) fsImpl.rmSync(previous, { recursive: true, force: true });
    return { ok: true, changed: true, ...status("installed") };
  }
  function exists(file) {
    try { fsImpl.lstatSync(file); return true; } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  function install() {
    const work = queue.then(performInstall).catch(() => { throw failure("CODING_DISCIPLINE_UNAVAILABLE"); });
    queue = work.catch(() => {});
    return work.finally(() => { cached = null; });
  }

  return { getStatus, install };
}

module.exports = { createCodingDisciplineInstaller, INSTALL_FILES };
