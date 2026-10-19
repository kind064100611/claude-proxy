const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");
const { createRequire } = require("module");

const LAUNCHER_MODULE = "../lib/claude-launcher-install";

// 在隔离 VM 中完整运行代理脚本：假的 HTTP 服务、假的依赖和临时目录，不监听端口、不读写真实用户目录。
function startProxy(platform, root, { installer, installerFactory, listen = "success", auth = {},
  catalog = async () => ({ object: "list", data: [] }) } = {}) {
  const filename = path.resolve(platform, "proxy.js");
  const nativeRequire = createRequire(filename);
  const configRoot = path.join(root, "config");
  fs.mkdirSync(configRoot, { recursive: true });
  const observations = nativeRequire("../lib/online-summary");
  const featureFile = path.join(root, "features.json");
  const logs = [];
  const warns = [];
  const calls = { factory: 0, autoEnable: 0, listening: false, autoEnableBeforeListen: 0,
    setupFactory: 0, syncGpt: 0, syncBeforeListen: 0, models: [] };
  const store = { directory: path.join(root, "store"), migrate() {}, readAuth: () => auth };
  const getAvailableModels = Object.assign((options) => {
    calls.models.push(options);
    return catalog(options);
  }, { invalidate() {} });
  const server = Object.assign(new EventEmitter(), {
    listen(_port, _host, callback) {
      server.listenCallback = () => { calls.listening = true; callback(); };
      if (listen === "success") server.listenCallback();
      else if (listen === "error") setImmediate(() => server.emit("error", new Error("EADDRINUSE")));
    },
    close() {}, closeIdleConnections() {}
  });
  const fakeProcess = Object.create(process);
  fakeProcess.once = () => fakeProcess;
  fakeProcess.exit = () => {};
  fakeProcess.exitCode = undefined;
  const context = {
    require: (name) => {
      if (name === "http") return { createServer: () => server };
      if (name === LAUNCHER_MODULE) return { createClaudeLauncherInstaller: (...args) => {
        calls.factory++;
        calls.factoryArgs = args;
        if (calls.listening === false) calls.factoryBeforeListen = true;
        return installerFactory ? installerFactory() : { autoEnable: async () => {
          calls.autoEnable++;
          if (!calls.listening) calls.autoEnableBeforeListen++;
          return installer ? installer() : null;
        }, getStatus: async () => ({ state: "unavailable" }) };
      } };
      if (name === "../lib/macos-service") return { createMacosService: () => ({ getStatus: async () => ({ supported: false }) }) };
      if (name === "../lib/project-memory-install") return { createProjectMemoryInstaller: () => ({ getStatus: async () => ({ state: "unavailable" }), autoEnable: async () => null }) };
      if (name === "../lib/coding-discipline-install") return { createCodingDisciplineInstaller: () => ({ getStatus: async () => ({ state: "unavailable" }) }) };
      if (name === "../lib/project-memory-maintainer") return { createProjectMemoryMaintainer: () => ({ enqueue() {} }) };
      if (name === "../lib/credential-store") return { defaultStore: store };
      if (name === "../lib/model-discovery") return { createModelDiscovery: () => getAvailableModels };
      if (name === "../lib/auth-server") return { createAuthRouter: (options) => {
        calls.authSetup = options.setup;
        return Object.assign(async () => false, { close() {} });
      } };
      if (name === "../lib/claude-setup") return { ...nativeRequire(name), getClaudeConfigRoot: () => configRoot,
        createClaudeSetup: (options) => {
          calls.setupFactory++;
          const setup = nativeRequire(name).createClaudeSetup({ ...options, configRoot, env: {}, store, getAvailableModels });
          const synchronize = setup.syncGptSubagentModel;
          setup.syncGptSubagentModel = () => {
            calls.syncGpt++;
            if (!calls.listening) calls.syncBeforeListen++;
            calls.syncPending = synchronize();
            return calls.syncPending;
          };
          calls.setup = setup;
          return setup;
        } };
      if (name === "../lib/online-summary") return { ...observations,
        createOnlineSummary: (options) => observations.createOnlineSummary({ ...options, configFile: featureFile, archiveRoot: path.join(root, "observations") }),
        createSummarySettings: (options) => observations.createSummarySettings({ ...options, configFile: featureFile }) };
      return nativeRequire(name);
    },
    __filename: filename, __dirname: path.dirname(filename), process: fakeProcess, Buffer, URL,
    setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), clearInterval,
    console: { log: (...args) => logs.push(args.join(" ")), warn: (...args) => warns.push(args.join(" ")), error() {} }
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  return { server, calls, logs, warns, fakeProcess, featureFile, configRoot };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const platform of ["mac", "windows"]) {
  test(`${platform} startup constructs the launcher installer inertly and enables it only after listen succeeds`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const run = startProxy(platform, root, { listen: "manual", installer: () => ({ ok: true, changed: true, enabled: true, state: "installed" }) });
    await tick();
    assert.equal(run.calls.factory, 1);
    assert.deepEqual(run.calls.factoryArgs, []);
    assert.equal(run.calls.autoEnable, 0);
    run.server.listenCallback();
    assert.equal(run.calls.autoEnable, 1);
    await tick();
    assert.ok(run.logs.some((line) => line.includes("claude-launcher")), run.logs.join("\n"));
    assert.equal(run.warns.some((line) => line.includes("claude-launcher")), false);
    assert.equal(run.calls.autoEnableBeforeListen, 0);
    assert.equal(fs.existsSync(run.featureFile), false);
  });

  test(`${platform} startup does not start the launcher installer when listen fails`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const run = startProxy(platform, root, { listen: "error" });
    await tick(); await tick();
    assert.equal(run.calls.factory, 1);
    assert.equal(run.calls.autoEnable, 0);
    assert.equal(run.fakeProcess.exitCode, 1);
  });

  test(`${platform} startup only warns when the launcher installer rejects or returns null, and never blocks listening`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const rejected = startProxy(platform, root, { installer: () => { throw new Error("shell config exploded"); } });
    assert.equal(rejected.calls.autoEnable, 1);
    await tick();
    assert.ok(rejected.warns.some((line) => line.includes("claude-launcher") && line.includes("shell config exploded")), rejected.warns.join("\n"));
    assert.equal(rejected.fakeProcess.exitCode, undefined);
    assert.ok(rejected.logs.some((line) => line.includes("claude-proxy running")));
    const conflict = startProxy(platform, root, { installer: () => ({ ok: false, reason: "modified shell block" }) });
    await tick();
    assert.ok(conflict.warns.some((line) => line.includes("claude-launcher") && line.includes("modified shell block")));
    assert.equal(conflict.fakeProcess.exitCode, undefined);
    const skipped = startProxy(platform, root, { installer: () => null });
    await tick();
    assert.equal(skipped.warns.some((line) => line.includes("claude-launcher")), false);
    const pending = startProxy(platform, root, { installer: () => null, installerFactory: () => ({ autoEnable: () => new Promise(() => {}), getStatus: async () => ({}) }) });
    assert.ok(pending.logs.some((line) => line.includes("claude-proxy running")));
  });
}

for (const platform of ["mac", "windows"]) {
  const auth = () => ({ openai: { type: "api_key", key: "test-startup-key" } });
  const catalog = async () => ({ data: [{ id: "gpt-startup-test" }] });

  test(`${platform} startup uses one shared setup and syncs GPT only after successful listen`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const run = startProxy(platform, root, { listen: "manual", auth: auth(), catalog });
    assert.equal(run.calls.setupFactory, 1);
    assert.equal(run.calls.authSetup, run.calls.setup);
    assert.equal(run.calls.syncGpt, 0);
    run.server.listenCallback();
    assert.equal(run.calls.syncGpt, 1);
    assert.equal(run.calls.syncBeforeListen, 0);
    assert.equal((await run.calls.syncPending).model, "anthropic/gpt-startup-test");
    assert.equal(run.calls.models.filter((options) => options?.waitForRefresh === true).length, 1);
    const failedRoot = path.join(root, "failed");
    const failed = startProxy(platform, failedRoot, { listen: "error", auth: auth(), catalog });
    await tick();
    assert.equal(failed.calls.syncGpt, 0);
    assert.equal(fs.existsSync(path.join(failed.configRoot, "settings.json")), false);
  });

  test(`${platform} startup without GPT credentials preserves old settings and does not create new ones`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const existing of [false, true]) {
      const directory = path.join(root, String(existing));
      const configRoot = path.join(directory, "config");
      fs.mkdirSync(configRoot, { recursive: true });
      const settings = path.join(configRoot, "settings.json");
      const original = '{"env":{"CLAUDE_CODE_SUBAGENT_MODEL":"anthropic/gpt-old","CLAUDE_CODE_SUBAGENT_MODEL_FORCE":"1"},"keep":true}\n';
      if (existing) fs.writeFileSync(settings, original);
      const run = startProxy(platform, directory, { catalog });
      assert.equal((await run.calls.syncPending).skipped, true);
      if (existing) assert.equal(fs.readFileSync(settings, "utf8"), original);
      else assert.equal(fs.existsSync(settings), false);
      assert.equal(run.calls.models.some((options) => options?.waitForRefresh), false);
      assert.equal(fs.existsSync(path.join(configRoot, "claude-proxy", "settings-backups")), false);
    }
  });

  test(`${platform} repeated startup selects dynamic GPT once and leaves identical settings and backups untouched`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const configRoot = path.join(root, "config");
    fs.mkdirSync(configRoot);
    const settings = path.join(configRoot, "settings.json");
    const original = '{"env":{"KEEP":"yes","ANTHROPIC_MODEL":"claude-sonnet-test"},"model":"personal-model","permissions":{"allow":[]}}\n';
    fs.writeFileSync(settings, original);
    const first = startProxy(platform, root, { auth: auth(), catalog });
    await first.calls.syncPending;
    const bytes = fs.readFileSync(settings);
    const current = JSON.parse(bytes);
    assert.deepEqual(current.env, { KEEP: "yes", ANTHROPIC_MODEL: "claude-sonnet-test",
      CLAUDE_CODE_SUBAGENT_MODEL: "anthropic/gpt-startup-test", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" });
    assert.equal(current.model, "personal-model");
    assert.deepEqual(current.permissions, { allow: [] });
    const backups = path.join(configRoot, "claude-proxy", "settings-backups");
    const names = fs.readdirSync(backups);
    assert.equal(names.length, 1);
    assert.equal(fs.readFileSync(path.join(backups, names[0]), "utf8"), original);
    const modified = fs.statSync(settings).mtimeMs;
    const second = startProxy(platform, root, { auth: auth(), catalog });
    await second.calls.syncPending;
    assert.equal(first.calls.syncGpt, 1);
    assert.equal(second.calls.syncGpt, 1);
    assert.deepEqual(fs.readFileSync(settings), bytes);
    assert.equal(fs.statSync(settings).mtimeMs, modified);
    assert.deepEqual(fs.readdirSync(backups), names);
  });

  test(`${platform} startup without an available GPT keeps existing defaults and warns safely`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const configRoot = path.join(root, "config");
    fs.mkdirSync(configRoot);
    const settings = path.join(configRoot, "settings.json");
    const original = '{"env":{"CLAUDE_CODE_SUBAGENT_MODEL":"anthropic/gpt-old","CLAUDE_CODE_SUBAGENT_MODEL_FORCE":"1"}}\n';
    fs.writeFileSync(settings, original);
    const run = startProxy(platform, root, { auth: auth(), catalog: async () => ({ data: [{ id: "claude-sonnet-test" }] }) });
    await assert.rejects(run.calls.syncPending);
    await tick();
    assert.equal(fs.readFileSync(settings, "utf8"), original);
    assert.equal(fs.existsSync(path.join(configRoot, "claude-proxy", "settings-backups")), false);
    assert.equal(run.warns.filter((line) => line.includes("GPT subagent")).length, 1);
  });

  test(`${platform} credentials disappearing during startup refresh skip without overwriting settings`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const configRoot = path.join(root, "config");
    fs.mkdirSync(configRoot);
    const settings = path.join(configRoot, "settings.json");
    const original = '{"env":{"CLAUDE_CODE_SUBAGENT_MODEL":"anthropic/gpt-old"}}\n';
    fs.writeFileSync(settings, original);
    const credentials = auth();
    let complete;
    const pending = new Promise((resolve) => { complete = resolve; });
    const run = startProxy(platform, root, { auth: credentials,
      catalog: (options) => options?.waitForRefresh ? pending : catalog() });
    await tick();
    assert.ok(run.calls.models.some((options) => options?.waitForRefresh));
    delete credentials.openai;
    complete(await catalog());
    assert.equal((await run.calls.syncPending).skipped, true);
    assert.equal(fs.readFileSync(settings, "utf8"), original);
    assert.equal(fs.existsSync(path.join(configRoot, "claude-proxy", "settings-backups")), false);
  });

  test(`${platform} pending or failing GPT sync never blocks listening and logs only a safe warning`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pending = startProxy(platform, path.join(root, "pending"), { auth: auth(),
      catalog: (options) => options?.waitForRefresh ? new Promise(() => {}) : catalog() });
    assert.ok(pending.logs.some((line) => line.includes("claude-proxy running")));
    assert.equal(pending.fakeProcess.exitCode, undefined);
    const failure = startProxy(platform, path.join(root, "failure"), { auth: auth(), catalog: async (options) => {
      if (options?.waitForRefresh) throw new Error("secret-access-token secret-refresh-token /private/credential/path");
      return catalog();
    } });
    await tick();
    assert.equal(failure.calls.syncGpt, 1);
    assert.ok(failure.logs.some((line) => line.includes("claude-proxy running")));
    assert.equal(failure.fakeProcess.exitCode, undefined);
    const warnings = failure.warns.filter((line) => line.includes("GPT subagent"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[claude-setup\] WARN GPT subagent model sync failed; existing settings were kept\. Retry on next proxy startup\.$/);
    assert.doesNotMatch([...failure.logs, ...failure.warns].join("\n"), /secret-access|secret-refresh|\/private\/credential/);
  });
}

test("real launcher installer in a temp home enables once, then leaves everything unchanged, and never overrides an explicit false", async (t) => {
  const installerModule = require(LAUNCHER_MODULE);
  if (!fs.existsSync("/bin/zsh")) return t.skip("zsh unavailable");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const featureFile = path.join(root, "features.json");
  const zshrc = path.join(home, ".zshrc");
  fs.writeFileSync(zshrc, "export KEEP=1\n");
  fs.writeFileSync(featureFile, '{"version":1,"onlineSummary":false}\n');
  const installerFactory = () => installerModule.createClaudeLauncherInstaller({ home, configRoot: path.join(root, "config"), featureFile, env: {}, platform: "darwin" });
  const first = startProxy("mac", root, { installerFactory });
  for (let index = 0; index < 50 && !first.logs.some((line) => line.includes("claude-launcher")); index++) await new Promise((r) => setTimeout(r, 20));
  const enabled = JSON.parse(fs.readFileSync(featureFile, "utf8"));
  assert.equal(enabled.claudeLauncher, true);
  assert.equal(enabled.onlineSummary, false);
  const installed = fs.readFileSync(zshrc);
  assert.match(installed.toString(), /claude-proxy capacity launcher/);
  const featureBytes = fs.readFileSync(featureFile);
  const second = startProxy("mac", root, { installerFactory });
  for (let index = 0; index < 50 && !second.logs.some((line) => line.includes("claude-launcher")); index++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fs.readFileSync(zshrc), installed);
  assert.deepEqual(fs.readFileSync(featureFile), featureBytes);
  fs.writeFileSync(zshrc, "export KEEP=1\n");
  fs.writeFileSync(featureFile, '{"version":1,"claudeLauncher":false}\n');
  const third = startProxy("mac", root, { installerFactory });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fs.readFileSync(zshrc, "utf8"), "export KEEP=1\n");
  assert.equal(fs.readFileSync(featureFile, "utf8"), '{"version":1,"claudeLauncher":false}\n');
  assert.equal(third.warns.some((line) => line.includes("claude-launcher")), false);
});
