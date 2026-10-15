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
  function checkDirectories() {
    for (const directory of [path.resolve(configRoot), skills]) {
      let stat;
      try { stat = fsImpl.lstatSync(directory); } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022)))) throw failure("CODING_DISCIPLINE_CONFLICT");
    }
  }
  // 目标不存在返回 false；SKILL.md 与本版本一致即视为已安装（含只放了 SKILL.md 的手动安装）；其他内容一律视为冲突，绝不覆盖。
  function inspect({ manifest }) {
    checkDirectories();
    let targetStat;
    try { targetStat = fsImpl.lstatSync(target); } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink() ||
      (process.getuid && targetStat.uid !== process.getuid())) throw failure("CODING_DISCIPLINE_CONFLICT");
    let current = null;
    try {
      const file = path.join(target, "SKILL.md");
      const stat = fsImpl.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && (!process.getuid || stat.uid === process.getuid())) current = hash(fsImpl.readFileSync(file));
    } catch (_) {}
    if (current === manifest.files["SKILL.md"]) return true;
    throw failure("CODING_DISCIPLINE_CONFLICT");
  }
  function status(state, reason = "") {
    return { installed: state === "installed", ready: state === "installed" || state === "absent", state, reason, notice: NOTICE };
  }
  async function check() {
    try {
      if (inspect(loadBundle())) return status("installed");
      const dependencies = await probe();
      if (!dependencies.cli) return status("unavailable", "Install Claude CLI manually first.");
      return status("absent");
    } catch (error) {
      return error.code === "CODING_DISCIPLINE_CONFLICT"
        ? status("conflict", "Existing skill or directories are unsafe or different. Handle them manually; nothing will be overwritten.")
        : status("unavailable", "Coding Discipline is unavailable. Check the bundled files and Claude CLI.");
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
    if (!dependencies.cli) throw failure("CODING_DISCIPLINE_UNAVAILABLE");
    if (inspect(bundle)) return { ok: true, changed: false, ...status("installed") };
    fsImpl.mkdirSync(skills, { recursive: true, mode: 0o700 });
    checkDirectories();
    // 先在同目录私有临时目录写全，再整体 rename，Claude 不会发现半安装。
    const stage = fsImpl.mkdtempSync(path.join(skills, ".coding-discipline-stage-"));
    try {
      for (const relative of INSTALL_FILES) fsImpl.writeFileSync(path.join(stage, relative), bundle.bytes[relative], { mode: 0o600 });
      if (inspect(bundle)) throw failure("CODING_DISCIPLINE_CONFLICT");
      fsImpl.renameSync(stage, target);
    } catch (error) {
      fsImpl.rmSync(stage, { recursive: true, force: true });
      // 目标在写入期间被外部创建：rename 失败，保留对方内容。
      throw ["EEXIST", "ENOTEMPTY"].includes(error.code) ? failure("CODING_DISCIPLINE_CONFLICT") : error;
    }
    return { ok: true, changed: true, ...status("installed") };
  }
  function install() {
    const work = queue.then(performInstall).catch((error) => {
      throw failure(error.code === "CODING_DISCIPLINE_CONFLICT" ? error.code : "CODING_DISCIPLINE_UNAVAILABLE");
    });
    queue = work.catch(() => {});
    return work.finally(() => { cached = null; });
  }

  return { getStatus, install };
}

module.exports = { createCodingDisciplineInstaller, INSTALL_FILES };
