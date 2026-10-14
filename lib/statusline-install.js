"use strict";

const fsDefault = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function createStatuslineInstaller({ configRoot, bundleRoot = path.join(__dirname, ".."), platform = process.platform, fsImpl = fsDefault }) {
  const toolkitRoot = path.join(configRoot, "claude-proxy");
  const installRoot = path.join(toolkitRoot, "statusline");
  const sourceScript = path.join(bundleRoot, "statusline", "statusline-command.sh");

  function assertDirectorySafe(target, mode) {
    let stat;
    try { stat = fsImpl.lstatSync(target); } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe statusline directory: ${target}`);
    if (mode !== undefined && platform !== "win32") fsImpl.chmodSync(target, mode);
    return true;
  }

  function assertFileSafe(file) {
    const stat = fsImpl.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Invalid statusline file: ${file}`);
  }

  function validateBundle() {
    assertFileSafe(sourceScript);
    return true;
  }

  function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
  function gitBashPath(value) {
    if (platform !== "win32") return value;
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
    return match ? `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}` : value.replace(/\\/g, "/");
  }

  function launcherContent({ bash, jq }) {
    return ["#!/usr/bin/env bash", "set -e", "umask 077", `export TOOLKIT_JQ=${shellQuote(gitBashPath(jq))}`,
      'export TOOLKIT_STATUSLINE_DIR="$(cd "$(dirname "$0")" && pwd)"',
      `exec ${shellQuote(gitBashPath(bash))} "$TOOLKIT_STATUSLINE_DIR/statusline-command.sh"`].join("\n") + "\n";
  }

  function commandFor(bash, directory) {
    return `${shellQuote(gitBashPath(bash))} ${shellQuote(gitBashPath(path.join(directory, "statusline-launcher.sh")))}`;
  }

  // 部署内容必须与当前打包脚本逐字节一致；旧版 HUD 部署因此视为未配置。
  function validateDeployed(directory) {
    if (!assertDirectorySafe(directory)) throw new Error("Missing deployment directory");
    for (const relative of ["statusline-launcher.sh", "statusline-command.sh"]) assertFileSafe(path.join(directory, relative));
    if (!fsImpl.readFileSync(sourceScript).equals(fsImpl.readFileSync(path.join(directory, "statusline-command.sh")))) {
      throw new Error("Modified statusline script");
    }
  }

  function verifyGeneration(directory, hash, dependencies) {
    const marker = path.join(directory, ".toolkit-generation");
    try {
      assertFileSafe(marker);
      if (fsImpl.readFileSync(marker, "utf8") !== `${hash}\n`) return false;
      validateDeployed(directory);
      return fsImpl.readFileSync(path.join(directory, "statusline-launcher.sh"), "utf8") === launcherContent(dependencies);
    } catch { return false; }
  }

  function validateTarget() {
    for (const directory of [configRoot, toolkitRoot, installRoot]) {
      if (assertDirectorySafe(directory)) {
        fsImpl.accessSync(directory, fsImpl.constants.W_OK | fsImpl.constants.X_OK);
        if (platform !== "win32" && !(fsImpl.statSync(directory).mode & 0o222)) throw new Error("Statusline target is not writable");
      }
    }
  }

  function deploy(dependencies = {}) {
    validateTarget();
    validateBundle();
    const bash = dependencies.bash || "bash";
    const jq = dependencies.jq || "jq";
    const launcher = launcherContent({ bash, jq });
    const hash = crypto.createHash("sha256");
    hash.update(JSON.stringify({ platform, bash, jq }));
    hash.update(launcher);
    hash.update(fsImpl.readFileSync(sourceScript));
    const generation = hash.digest("hex");
    const directory = path.join(installRoot, generation);
    // 不更改已有 CLI 根目录权限；新目录安全创建并拒绝符号链接。
    const ensureDirectory = (directory) => {
      if (assertDirectorySafe(directory)) return;
      ensureDirectory(path.dirname(directory));
      fsImpl.mkdirSync(directory, { mode: 0o700 });
    };
    ensureDirectory(configRoot);
    if (!fsImpl.existsSync(toolkitRoot)) fsImpl.mkdirSync(toolkitRoot, { mode: 0o700 });
    assertDirectorySafe(toolkitRoot, 0o700);
    if (!fsImpl.existsSync(installRoot)) fsImpl.mkdirSync(installRoot, { mode: 0o700 });
    assertDirectorySafe(installRoot, 0o700);
    if (fsImpl.existsSync(directory)) {
      assertDirectorySafe(directory, 0o700);
      if (!verifyGeneration(directory, generation, { bash, jq })) throw new Error("Existing statusline generation failed verification");
      return { command: commandFor(bash, directory), directory, created: false };
    }

    const stage = fsImpl.mkdtempSync(path.join(installRoot, ".stage-"));
    fsImpl.chmodSync(stage, 0o700);
    let published = false;
    try {
      fsImpl.copyFileSync(sourceScript, path.join(stage, "statusline-command.sh"));
      fsImpl.chmodSync(path.join(stage, "statusline-command.sh"), 0o700);
      fsImpl.writeFileSync(path.join(stage, "statusline-launcher.sh"), launcher, { mode: 0o600 });
      fsImpl.chmodSync(path.join(stage, "statusline-launcher.sh"), 0o700);
      fsImpl.writeFileSync(path.join(stage, ".toolkit-generation"), `${generation}\n`, { mode: 0o600 });
      fsImpl.renameSync(stage, directory);
      published = true;
      validateDeployed(directory);
      return { command: commandFor(bash, directory), directory, created: true };
    } catch (error) {
      fsImpl.rmSync(stage, { recursive: true, force: true });
      if (published) fsImpl.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  function cleanup(deployment) {
    if (!deployment || deployment.created !== true || !deployment.directory) return false;
    const resolved = path.resolve(deployment.directory);
    if (path.dirname(resolved) !== path.resolve(installRoot)) return false;
    if (assertDirectorySafe(resolved)) fsImpl.rmSync(resolved, { recursive: true, force: true });
    return true;
  }

  function isConfigured(statusLine) {
    if (!statusLine || statusLine.type !== "command" || typeof statusLine.command !== "string") return false;
    const candidate = statusLine.command.match(/(?:^|\/)([a-f0-9]{64})\/statusline-launcher\.sh/);
    if (!candidate) return false;
    const dir = path.join(path.resolve(installRoot), candidate[1]);
    const suffix = ` ${shellQuote(gitBashPath(path.join(dir, "statusline-launcher.sh")))}`;
    if (!statusLine.command.endsWith(suffix)) return false;
    try {
      for (const directory of [configRoot, toolkitRoot, installRoot]) if (!assertDirectorySafe(directory)) return false;
      validateDeployed(dir);
      return true;
    } catch { return false; }
  }

  return { validateBundle, validateTarget, deploy, cleanup, isConfigured };
}

module.exports = { createStatuslineInstaller };
