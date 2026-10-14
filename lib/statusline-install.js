"use strict";

const fsDefault = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const builtinModules = new Set(require("node:module").builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]));

function createStatuslineInstaller({ configRoot, bundleRoot = path.join(__dirname, ".."), platform = process.platform, fsImpl = fsDefault }) {
  const toolkitRoot = path.join(configRoot, "claude-proxy");
  const installRoot = path.join(toolkitRoot, "statusline");
  const sourceRoot = path.join(bundleRoot, "statusline");

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

  function validateBundle() {
    for (const directory of [sourceRoot, path.join(sourceRoot, "claude-hud"), path.join(sourceRoot, "claude-hud", "dist")]) {
      if (!assertDirectorySafe(directory)) throw new Error("Missing statusline bundle directory");
    }
    const entry = path.join(sourceRoot, "claude-hud", "dist", "index.js");
    for (const file of [entry, path.join(sourceRoot, "claude-hud", "LICENSE"), path.join(sourceRoot, "claude-hud", "package.json"), path.join(sourceRoot, "hud-config.json"), path.join(sourceRoot, "statusline-command.sh")]) {
      const stat = fsImpl.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Missing statusline bundle file: ${file}`);
    }
    const displayConfig = JSON.parse(fsImpl.readFileSync(path.join(sourceRoot, "hud-config.json"), "utf8"));
    const packageInfo = JSON.parse(fsImpl.readFileSync(path.join(sourceRoot, "claude-hud", "package.json"), "utf8"));
    if (!displayConfig || typeof displayConfig !== "object" || Array.isArray(displayConfig) || packageInfo.type !== "module" || packageInfo.license !== "MIT") {
      throw new Error("Invalid bundled HUD configuration or package metadata");
    }
    const seen = new Set();
    const visit = (file) => {
      const absolute = path.resolve(file);
      if (seen.has(absolute)) return;
      if (!absolute.startsWith(path.resolve(sourceRoot) + path.sep) || !fsImpl.realpathSync(absolute).startsWith(fsImpl.realpathSync(sourceRoot) + path.sep)) {
        throw new Error(`HUD import escapes bundle: ${file}`);
      }
      seen.add(absolute);
      const stat = fsImpl.lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Unsafe HUD runtime module");
      const source = fsImpl.readFileSync(absolute, "utf8");
      for (const match of source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)) {
        const specifier = match[1];
        if (builtinModules.has(specifier) || (specifier.startsWith("node:") && builtinModules.has(specifier.slice(5)))) continue;
        if (!specifier.startsWith(".")) throw new Error(`Non-builtin HUD dependency: ${specifier}`);
        let dependency = path.resolve(path.dirname(absolute), specifier);
        if (!path.extname(dependency)) dependency += ".js";
        visit(dependency);
      }
    };
    visit(entry);
    return true;
  }

  function walkHash(dir, hash) {
    for (const item of fsImpl.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, item.name);
      hash.update(item.name);
      if (item.isDirectory()) walkHash(full, hash);
      else if (item.isFile()) hash.update(fsImpl.readFileSync(full));
      else throw new Error(`Unsupported bundle entry: ${full}`);
    }
  }

  function copyTree(from, to) {
    fsImpl.mkdirSync(to, { recursive: true, mode: 0o700 });
    fsImpl.chmodSync(to, 0o700);
    for (const item of fsImpl.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, item.name);
      const dst = path.join(to, item.name);
      if (item.isDirectory()) copyTree(src, dst);
      else if (item.isFile()) {
        fsImpl.copyFileSync(src, dst);
        fsImpl.chmodSync(dst, 0o600);
      } else throw new Error(`Unsupported bundle entry: ${src}`);
    }
  }

  function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
  function gitBashPath(value) {
    if (platform !== "win32") return value;
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
    return match ? `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}` : value.replace(/\\/g, "/");
  }

  function launcherContent({ node, bash, jq }) {
    return ["#!/usr/bin/env bash", "set -e", "umask 077", `export TOOLKIT_NODE=${shellQuote(gitBashPath(node))}`,
      `export TOOLKIT_JQ=${shellQuote(gitBashPath(jq))}`, 'export TOOLKIT_STATUSLINE_DIR="$(cd "$(dirname "$0")" && pwd)"',
      `exec ${shellQuote(gitBashPath(bash))} "$TOOLKIT_STATUSLINE_DIR/statusline-command.sh"`].join("\n") + "\n";
  }

  function verifyGeneration(directory, hash, dependencies) {
    const marker = path.join(directory, ".toolkit-generation");
    if (!assertDirectorySafe(directory)) return false;
    try {
      if (!fsImpl.lstatSync(marker).isFile() || fsImpl.lstatSync(marker).isSymbolicLink() || fsImpl.readFileSync(marker, "utf8") !== `${hash}\n`) return false;
      validateDeployed(directory);
      const compareTree = (from, to) => {
        if (!assertDirectorySafe(to)) throw new Error("Missing runtime directory");
        for (const item of fsImpl.readdirSync(from, { withFileTypes: true })) {
          const src = path.join(from, item.name);
          const dst = path.join(to, item.name);
          if (item.isDirectory()) compareTree(src, dst);
          else {
            const stat = fsImpl.lstatSync(dst);
            if (!stat.isFile() || stat.isSymbolicLink() || !fsImpl.readFileSync(src).equals(fsImpl.readFileSync(dst))) throw new Error("Modified runtime file");
          }
        }
      };
      compareTree(path.join(sourceRoot, "claude-hud"), path.join(directory, "claude-hud"));
      if (!fsImpl.readFileSync(path.join(sourceRoot, "hud-config.json")).equals(fsImpl.readFileSync(path.join(directory, "claude-hud/plugins/claude-hud/config.json")))) return false;
      if (!fsImpl.readFileSync(path.join(sourceRoot, "statusline-command.sh")).equals(fsImpl.readFileSync(path.join(directory, "statusline-command.sh")))) return false;
      return fsImpl.readFileSync(path.join(directory, "statusline-launcher.sh"), "utf8") === launcherContent(dependencies);
    } catch { return false; }
  }

  function validateDeployed(directory) {
    for (const relative of ["", "claude-hud", "claude-hud/dist", "claude-hud/plugins", "claude-hud/plugins/claude-hud"]) {
      if (!assertDirectorySafe(path.join(directory, relative))) throw new Error("Missing deployment directory");
    }
    const required = ["statusline-launcher.sh", "statusline-command.sh", "claude-hud/dist/index.js", "claude-hud/LICENSE", "claude-hud/package.json", "claude-hud/plugins/claude-hud/config.json"];
    for (const relative of required) {
      const file = path.join(directory, relative);
      const stat = fsImpl.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Invalid deployment file: ${relative}`);
    }
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
    const node = dependencies.node || "node";
    const bash = dependencies.bash || "bash";
    const jq = dependencies.jq || "jq";
    const hash = crypto.createHash("sha256");
    hash.update(JSON.stringify({ platform, node, bash, jq }));
    hash.update(launcherContent({ node, bash, jq }));
    walkHash(path.join(sourceRoot, "claude-hud"), hash);
    hash.update(fsImpl.readFileSync(path.join(sourceRoot, "hud-config.json")));
    hash.update(fsImpl.readFileSync(path.join(sourceRoot, "statusline-command.sh")));
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
      if (!verifyGeneration(directory, generation, { node, bash, jq })) throw new Error("Existing statusline generation failed verification");
      const launcher = path.join(directory, "statusline-launcher.sh");
      return { command: `${shellQuote(gitBashPath(bash))} ${shellQuote(gitBashPath(launcher))}`, directory, created: false };
    }

    const stage = fsImpl.mkdtempSync(path.join(installRoot, ".stage-"));
    fsImpl.chmodSync(stage, 0o700);
    let published = false;
    try {
      copyTree(path.join(sourceRoot, "claude-hud"), path.join(stage, "claude-hud"));
      fsImpl.mkdirSync(path.join(stage, "claude-hud", "plugins", "claude-hud"), { recursive: true, mode: 0o700 });
      fsImpl.copyFileSync(path.join(sourceRoot, "hud-config.json"), path.join(stage, "claude-hud", "plugins", "claude-hud", "config.json"));
      fsImpl.chmodSync(path.join(stage, "claude-hud", "plugins", "claude-hud", "config.json"), 0o600);
      fsImpl.copyFileSync(path.join(sourceRoot, "statusline-command.sh"), path.join(stage, "statusline-command.sh"));
      fsImpl.chmodSync(path.join(stage, "statusline-command.sh"), 0o700);
      const launcher = launcherContent({ node, bash, jq });
      fsImpl.writeFileSync(path.join(stage, "statusline-launcher.sh"), launcher, { mode: 0o600 });
      fsImpl.chmodSync(path.join(stage, "statusline-launcher.sh"), 0o700);
      fsImpl.writeFileSync(path.join(stage, ".toolkit-generation"), `${generation}\n`, { mode: 0o600 });
      fsImpl.renameSync(stage, directory);
      published = true;
      validateDeployed(directory);
      return { command: `${shellQuote(gitBashPath(bash))} ${shellQuote(gitBashPath(path.join(directory, "statusline-launcher.sh")))}`, directory, created: true };
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
    const matches = statusLine.command.match(/statusline-launcher\.sh/);
    if (!matches) return false;
    const root = path.resolve(installRoot);
    const candidate = statusLine.command.match(/(?:^|\/)([a-f0-9]{64})\/statusline-launcher\.sh/);
    if (!candidate) return false;
    const dir = path.join(root, candidate[1]);
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
