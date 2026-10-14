const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { defaultStore } = require("./credential-store");
const { selectOpenAIProvider } = require("./pi-auth");
const { selectModel, toGatewayModels } = require("./model-routing");
const { isResponsesModel } = require("./openai-responses");
const { isClaudeModel } = require("./github-copilot");
const { createSetupProbe } = require("./claude-probes");

const queues = new Map();
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const setupError = (code, message, fields) => Object.assign(new Error(message), { setupCode: code, fields });
const SETTINGS_ERROR = "Settings are damaged, unsafe, or not writable. Fix the user settings file first.";
const OVERRIDE_NOTICE = "Shell, project, local, and managed settings may override user settings. This operation does not bypass policies.";

function getClaudeConfigRoot(env = process.env, home = os.homedir()) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  const expanded = configured === "~" ? home : /^~[\\/]/.test(configured) ? path.join(home, configured.slice(2)) : configured;
  return path.resolve(expanded || path.join(home, ".claude"));
}

// 加载模块只描述路径，所有部署和 settings 写入都由按钮显式触发。
function createClaudeSetup({ env = process.env, configRoot = getClaudeConfigRoot(env), store = defaultStore,
  getAvailableModels = async () => ({ data: [] }), probe = createSetupProbe({ env }),
  platform = process.platform, now = Date.now, fsImpl = fs } = {}) {
  const root = path.resolve(configRoot);
  const settingsFile = path.join(root, "settings.json");
  const privateRoot = path.join(root, "claude-proxy");
  const backups = path.join(privateRoot, "settings-backups");
  const endpoint = "http://localhost:8082";
  const routing = { ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_API_KEY: "sk-placeholder",
    CLAUDE_CODE_USE_GATEWAY: "1", CLAUDE_GATEWAY_ALLOW_LOOPBACK: "1", CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" };
  let probeCache;
  let probeExpires = 0;
  let probePending;
  const notice = (env.CLAUDE_CONFIG_DIR ? "Using the actual CLI root selected by CLAUDE_CONFIG_DIR. " : "") + OVERRIDE_NOTICE;

  function statOptional(file) {
    try { return fsImpl.lstatSync(file); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  function checkDirectory(directory, create = false, privateMode = false) {
    const info = statOptional(directory);
    if (!info) {
      if (create) fsImpl.mkdirSync(directory, { mode: 0o700 });
      else { checkDirectory(path.dirname(directory)); return; }
    } else if (!info.isDirectory() || info.isSymbolicLink()) throw setupError("settings", SETTINGS_ERROR);
    if (create && privateMode && platform !== "win32") fsImpl.chmodSync(directory, 0o700);
  }
  function readSettings() {
    let fd;
    try {
      checkDirectory(root);
      const info = statOptional(settingsFile);
      if (!info) return { value: {}, bytes: null, info: null };
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error();
      fd = fsImpl.openSync(settingsFile, fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0));
      const opened = fsImpl.fstatSync(fd);
      if (!opened.isFile() || opened.size > 2 * 1024 * 1024 || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error();
      const bytes = fsImpl.readFileSync(fd);
      const value = JSON.parse(bytes.toString("utf8").replace(/^﻿/, ""));
      if (!isObject(value) || ["env", "hooks", "permissions", "enabledPlugins", "statusLine"].some((key) => Object.hasOwn(value, key) && !isObject(value[key])) ||
        value.env && Object.values(value.env).some((item) => typeof item !== "string") || Object.hasOwn(value, "model") && typeof value.model !== "string") throw new Error();
      return { value, bytes, info: opened };
    } catch (_) { throw setupError("settings", SETTINGS_ERROR); }
    finally { if (fd !== undefined) fsImpl.closeSync(fd); }
  }
  function checkWritable(snapshot) {
    try {
      let directory = root;
      while (!statOptional(directory)) directory = path.dirname(directory);
      checkDirectory(directory);
      fsImpl.accessSync(directory, fsImpl.constants.W_OK | fsImpl.constants.X_OK);
      if (platform !== "win32" && !(fsImpl.statSync(directory).mode & 0o222)) throw new Error();
      if (snapshot.info) {
        fsImpl.accessSync(settingsFile, fsImpl.constants.W_OK);
        if (platform !== "win32" && !(snapshot.info.mode & 0o222)) throw new Error();
      }
      for (const directory of [privateRoot, backups]) {
        const info = statOptional(directory);
        if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error();
        if (info) fsImpl.accessSync(directory, fsImpl.constants.W_OK | fsImpl.constants.X_OK);
      }
    } catch (_) { throw setupError("settings", SETTINGS_ERROR); }
  }
  function credentials() {
    try {
      const auth = store.readAuth();
      const selected = auth[selectOpenAIProvider(auth)];
      const oauth = (value) => value?.type === "oauth" && typeof value.access === "string" && Boolean(value.access.trim()) &&
        typeof value.refresh === "string" && Boolean(value.refresh.trim()) && Number.isFinite(value.expires);
      const apiKey = (value) => value?.type === "api_key" && typeof value.key === "string" && Boolean(value.key.trim());
      return { openai: typeof env.OPENAI_API_KEY === "string" && Boolean(env.OPENAI_API_KEY.trim()) || apiKey(selected) || oauth(selected),
        copilot: oauth(auth["github-copilot"]) };
    } catch (_) { throw setupError("credentials", "Credential storage is unavailable. Fix the local credential files first."); }
  }
  function conflicts(settings) {
    const names = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE"];
    const enabled = (value) => value && !["0", "false"].includes(String(value).toLowerCase());
    const fields = names.filter((name) => enabled(settings.env?.[name]) || enabled(env[name]));
    for (const name of ["apiKeyHelper", "proxyAuthHelper", "forceLoginGatewayUrl"]) if (settings[name]) fields.push(name);
    if (settings.forceLoginMethod) fields.push("forceLoginMethod");
    for (const name of ["CLAUDE_CODE_API_KEY_HELPER", "CLAUDE_CODE_GATEWAY_AUTH_HELPER", "CLAUDE_CODE_GATEWAY_URL", "ANTHROPIC_GATEWAY_AUTH_TOKEN"]) {
      if (settings.env?.[name] || env[name]) fields.push(name);
    }
    if (fields.length) throw setupError("conflict", "Conflicting authentication settings must be handled manually first: " + fields.join(", ") + ".", fields);
  }
  async function dependencies(fresh = false) {
    if (!fresh && probeCache && now() < probeExpires) return probeCache;
    if (!probePending) {
      probePending = Promise.resolve().then(probe).then((result) => {
        probeCache = result;
        probeExpires = now() + 15000;
        return result;
      }).finally(() => { probePending = null; });
    }
    return probePending;
  }

  function sameSnapshot(before, after) {
    if (!before.bytes || !after.bytes) return before.bytes === after.bytes;
    return before.info.ino === after.info.ino && before.info.dev === after.info.dev &&
      before.info.mtimeMs === after.info.mtimeMs && before.bytes.equals(after.bytes);
  }
  function ensureRoot() {
    const create = (directory) => {
      if (!statOptional(directory)) create(path.dirname(directory));
      checkDirectory(directory, true);
    };
    create(root);
    checkDirectory(privateRoot, true, true);
    checkDirectory(backups, true, true);
  }
  function backup(snapshot) {
    if (!snapshot.bytes) return;
    const digest = crypto.createHash("sha256").update(snapshot.bytes).digest("hex");
    const file = path.join(backups, `settings-${digest}.json`);
    const info = statOptional(file);
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || !fsImpl.readFileSync(file).equals(snapshot.bytes)) throw new Error();
      if (platform !== "win32") fsImpl.chmodSync(file, 0o600);
    } else fsImpl.writeFileSync(file, snapshot.bytes, { flag: "wx", mode: 0o600 });
  }
  function commit(merge) {
    // 异步发现/探测已结束；提交阶段同步重读、合并、校验，不跨 await 留旧快照。
    const snapshot = readSettings();
    checkWritable(snapshot);
    const result = merge(snapshot.value);
    if (JSON.stringify(snapshot.value) === JSON.stringify(result)) return;
    let temporary;
    try {
      ensureRoot();
      backup(snapshot);
      temporary = path.join(root, `.settings-${crypto.randomUUID()}.tmp`);
      fsImpl.writeFileSync(temporary, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      if (!sameSnapshot(snapshot, readSettings())) throw setupError("changed", "Settings changed during configuration. Nothing was overwritten; please retry.");
      if (snapshot.bytes) fsImpl.renameSync(temporary, settingsFile);
      else fsImpl.linkSync(temporary, settingsFile); // 新建时不可覆盖外部同时创建的文件。
    } catch (error) {
      if (error.setupCode) throw error;
      throw setupError("save", "Unable to save configuration safely. Existing settings were kept; check permissions and retry.");
    } finally {
      if (temporary && statOptional(temporary)) fsImpl.unlinkSync(temporary);
    }
  }
  function serialize(operation) {
    const pending = (queues.get(root) || Promise.resolve()).catch(() => {}).then(operation);
    queues.set(root, pending);
    return pending.finally(() => { if (queues.get(root) === pending) queues.delete(root); });
  }
  function requireCli(deps) {
    if (!deps.cli) throw setupError("cli", "Claude CLI was not found. Install Claude Code manually, then retry.");
  }
  function requireCredentials() {
    const available = credentials();
    if (!Object.values(available).some(Boolean)) throw setupError("no-credentials", "Configure a ChatGPT or Copilot credential first (or set OPENAI_API_KEY).");
    return available;
  }
  function eligibleModels(catalog) {
    const available = requireCredentials();
    return toGatewayModels({ data: (catalog?.data || []).filter((model) => typeof model.id === "string" &&
      (isClaudeModel(model.id) ? available.copilot : isResponsesModel(model.id) ? available.openai : false)) }).data;
  }
  function chooseModel(settings, catalog) {
    const models = eligibleModels(catalog);
    if (!models.length) throw setupError("models", "No supported models are available for the configured credentials. Please retry later.");
    const normalize = (id) => typeof id === "string" ? selectModel(id, "").replace(/\[1m\]$/i, "") : "";
    for (const current of [settings.env?.ANTHROPIC_MODEL, settings.model]) {
      const match = models.find((model) => normalize(model.id) === normalize(current));
      if (match) return match.id;
    }
    return models[0].id;
  }
  async function getStatus() {
    let deps;
    try { deps = await dependencies(); } catch (_) { deps = {}; }
    let snapshot;
    let commonError;
    try { snapshot = readSettings(); checkWritable(snapshot); requireCli(deps); }
    catch (error) { commonError = error.setupCode ? error.message : SETTINGS_ERROR; }
    const settings = snapshot?.value || {};
    let cliReason = commonError;
    if (!cliReason) {
      try { requireCredentials(); conflicts(settings); } catch (error) { cliReason = error.message; }
    }
    const cliConfigured = Object.entries(routing).every(([key, value]) => settings.env?.[key] === value) &&
      settings.env?.ANTHROPIC_MODEL?.startsWith("claude-gateway/") && !settings.env?.ANTHROPIC_AUTH_TOKEN;
    return { claudeCli: { installed: Boolean(deps.cli), ready: !cliReason, configured: Boolean(cliConfigured), reason: cliReason || "", notice } };
  }
  async function configureCli() {
    requireCredentials();
    const before = readSettings();
    checkWritable(before);
    conflicts(before.value);
    const deps = await dependencies(true);
    requireCli(deps);
    let catalog;
    try { catalog = await getAvailableModels(); }
    catch (_) { throw setupError("models", "No supported models are available for the configured credentials. Please retry later."); }
    return serialize(() => {
      let model;
      commit((latest) => {
        conflicts(latest);
        model = chooseModel(latest, catalog);
        const nextEnv = { ...latest.env, ...routing, ANTHROPIC_MODEL: model };
        delete nextEnv.ANTHROPIC_AUTH_TOKEN;
        return { ...latest, env: nextEnv };
      });
      return { success: true, model, message: "Open a new terminal and run claude. Use /model to switch models.", notice };
    });
  }
  return { getStatus, configureCli };
}

function setupFailure(error) {
  const messages = {
    settings: SETTINGS_ERROR,
    credentials: "Credential storage is unavailable. Fix the local credential files first.",
    cli: "Claude CLI was not found. Install Claude Code manually, then retry.",
    "no-credentials": "Configure a ChatGPT or Copilot credential first (or set OPENAI_API_KEY).",
    models: "No supported models are available for the configured credentials. Please retry later.",
    changed: "Settings changed during configuration. Nothing was overwritten; please retry.",
    save: "Unable to save configuration safely. Existing settings were kept; check permissions and retry.",
    conflict: "Conflicting authentication settings must be handled manually first."
  };
  const code = error.setupCode;
  const fields = (Array.isArray(error.fields) ? error.fields : []).filter((field) => ["apiKeyHelper", "proxyAuthHelper", "forceLoginMethod", "forceLoginGatewayUrl",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_API_KEY_HELPER", "CLAUDE_CODE_GATEWAY_AUTH_HELPER", "CLAUDE_CODE_GATEWAY_URL", "ANTHROPIC_GATEWAY_AUTH_TOKEN"].includes(field));
  return { status: ["conflict", "changed", "settings"].includes(code) ? 409 : ["cli", "dependencies", "no-credentials"].includes(code) ? 400 : 503,
    body: { error: Object.hasOwn(messages, code) ? messages[code] : "Local configuration could not be completed. Please retry.", ...(code === "conflict" ? { fields } : {}) } };
}

module.exports = { createClaudeSetup, getClaudeConfigRoot, setupFailure };
