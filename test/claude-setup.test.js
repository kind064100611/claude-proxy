const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClaudeSetup, getClaudeConfigRoot, setupFailure } = require("../lib/claude-setup");
const { createSetupProbe } = require("../lib/claude-probes");

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-setup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsFile = path.join(root, "settings.json");
  const state = { auth: { openai: { type: "api_key", key: "test-key" } }, probes: 0, catalogs: 0 };
  const store = { readAuth: () => state.auth };
  const base = { configRoot: root, env: {}, store,
    probe: async () => { state.probes++; return { cli: true, bash: "/bin/bash", jq: "/bin/jq", node: process.execPath }; },
    getAvailableModels: async () => { state.catalogs++; return { data: [{ id: "gpt-test" }] }; } };
  const setup = createClaudeSetup({ ...base, ...options });
  return { root, settingsFile, state, base, setup, read: () => JSON.parse(fs.readFileSync(settingsFile, "utf8")),
    write: (value) => fs.writeFileSync(settingsFile, typeof value === "string" ? value : JSON.stringify(value)) };
}
test("read-only status uses cached probes, never models or configuration writes, and credentials gate only CLI", async (t) => {
  const f = fixture(t);
  f.state.auth = {};
  const status = await f.setup.getStatus();
  assert.equal(status.claudeCli.ready, false);
  assert.match(status.claudeCli.reason, /credential/);
  await f.setup.getStatus();
  assert.equal(f.state.probes, 1);
  assert.equal(f.state.catalogs, 0);
  await assert.rejects(f.setup.configureCli(), /credential/);
  assert.equal(fs.existsSync(f.settingsFile), false);
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("merge preserves unrelated settings, backs up original BOM bytes privately and retries idempotently", async (t) => {
  const f = fixture(t);
  const unrelated = { env: { OTHER: "unchanged", ANTHROPIC_API_KEY: "old-secret", ANTHROPIC_AUTH_TOKEN: "old-token",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "sonnet", CLAUDE_CODE_SUBAGENT_MODEL: "opus" },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] }, permissions: { allow: ["Read"] },
    enabledPlugins: { "other@local": true }, model: "old-model", statusLine: { type: "command", command: "old-script" } };
  const original = Buffer.from("﻿" + JSON.stringify(unrelated, null, 4) + "\n");
  fs.writeFileSync(f.settingsFile, original);
  const result = await f.setup.configureCli();
  assert.equal(result.model, "claude-gateway/gpt-test");
  const saved = f.read();
  for (const key of ["hooks", "permissions", "enabledPlugins", "model", "statusLine"]) assert.deepEqual(saved[key], unrelated[key]);
  for (const key of ["OTHER", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) assert.equal(saved.env[key], unrelated.env[key]);
  assert.equal(saved.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(saved.env.ANTHROPIC_API_KEY, "sk-placeholder");
  const backupDir = path.join(f.root, "claude-proxy", "settings-backups");
  const backup = path.join(backupDir, fs.readdirSync(backupDir)[0]);
  assert.deepEqual(fs.readFileSync(backup), original);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.settingsFile).mode & 0o777, 0o600);
  }
  const bytes = fs.readFileSync(f.settingsFile);
  await f.setup.configureCli();
  assert.deepEqual(fs.readFileSync(f.settingsFile), bytes);
  assert.equal(fs.readdirSync(backupDir).length, 1);
  assert.equal((await f.setup.getStatus()).claudeCli.configured, true);
});

for (const value of ["invalid-private-content", "[]", "null", '{"env":[]}', '{"env":{"KEY":42}}', '{"hooks":[]}', '{"statusLine":null}', '{"model":42}']) {
  test(`rejects malformed settings structure ${value.slice(0, 20)} without overwriting`, async (t) => {
    const f = fixture(t); f.write(value);
    assert.equal((await f.setup.getStatus()).claudeCli.ready, false);
    await assert.rejects(f.setup.configureCli(), /Settings/);
    assert.equal(fs.readFileSync(f.settingsFile, "utf8"), value);
  });
}

test("rejects symlink, directory, readonly targets and linked private backup roots", async (t) => {
  const f = fixture(t);
  const original = path.join(f.root, "original"); fs.writeFileSync(original, "{}");
  fs.symlinkSync(original, f.settingsFile);
  await assert.rejects(f.setup.configureCli(), /Settings/);
  fs.unlinkSync(f.settingsFile); fs.mkdirSync(f.settingsFile);
  await assert.rejects(f.setup.configureCli(), /Settings/);
  fs.rmdirSync(f.settingsFile); f.write({});
  if (process.platform !== "win32") {
    fs.chmodSync(f.settingsFile, 0o400);
    await assert.rejects(f.setup.configureCli(), /Settings/);
    fs.chmodSync(f.settingsFile, 0o600);
  }
  fs.symlinkSync(f.root, path.join(f.root, "claude-proxy"), "dir");
  await assert.rejects(f.setup.configureCli(), /Settings/);
  assert.equal(fs.readFileSync(original, "utf8"), "{}");
});

test("distinct setup instances serialize latest-settings merges", async (t) => {
  const f = fixture(t); f.write({ env: { KEEP: "yes" } });
  const second = createClaudeSetup(f.base);
  await Promise.all([f.setup.configureCli(), second.configureCli()]);
  assert.equal(f.read().env.ANTHROPIC_BASE_URL, "http://localhost:8082");
  assert.equal(f.read().env.KEEP, "yes");
});

test("external edits during model lookup are merged and latest auth conflicts abort", async (t) => {
  const f = fixture(t);
  const setup = createClaudeSetup({ ...f.base, getAvailableModels: async () => {
    f.write({ env: { EXTERNAL: "latest" }, permissions: { deny: ["Bash"] } });
    return { data: [{ id: "gpt-test" }] };
  } });
  await setup.configureCli();
  assert.equal(f.read().env.EXTERNAL, "latest");
  assert.deepEqual(f.read().permissions, { deny: ["Bash"] });
  const conflicted = createClaudeSetup({ ...f.base, getAvailableModels: async () => {
    f.write({ apiKeyHelper: "private-helper" }); return { data: [{ id: "gpt-test" }] };
  } });
  await assert.rejects(conflicted.configureCli(), /apiKeyHelper/);
  assert.deepEqual(f.read(), { apiKeyHelper: "private-helper" });
});

test("save failure leaves original bytes and cleans temporary files", async (t) => {
  const f = fixture(t); f.write({ statusLine: { command: "original" } });
  const bytes = fs.readFileSync(f.settingsFile);
  const setup = createClaudeSetup({ ...f.base, fsImpl: { ...fs, renameSync() { throw new Error("private-failure"); } } });
  await assert.rejects(setup.configureCli(), /Existing settings were kept/);
  assert.deepEqual(fs.readFileSync(f.settingsFile), bytes);
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith(".tmp")), false);
});

test("target changes at final validation cause conflict rather than lost external edits", async (t) => {
  const f = fixture(t); f.write({ old: true });
  let altered = false;
  const setup = createClaudeSetup({ ...f.base, fsImpl: { ...fs, writeFileSync(file, ...args) {
    fs.writeFileSync(file, ...args);
    if (file.endsWith(".tmp") && !altered) { altered = true; f.write({ external: true }); }
  } } });
  await assert.rejects(setup.configureCli(), /changed during configuration/);
  assert.deepEqual(f.read(), { external: true });
});
for (const provider of ["openai-codex", "github-copilot", "environment"]) {
  test(`chooses only credential-matching catalog models for ${provider}`, async (t) => {
    const f = fixture(t); f.state.auth = {};
    if (provider !== "environment") f.state.auth[provider] = { type: "oauth", access: "test-access", refresh: "test-refresh", expires: 0 };
    const expected = provider === "github-copilot" ? "claude-opus-5-5" : "gpt-test";
    const setup = createClaudeSetup({ ...f.base, env: provider === "environment" ? { OPENAI_API_KEY: "env-only-secret" } : {},
      getAvailableModels: async () => ({ data: [{ id: "unsupported-model" }, { id: "gpt-test" }, { id: "claude-opus-5-5" }] }) });
    f.write({ env: { ANTHROPIC_MODEL: "claude-gateway/vendor/stale" } });
    const result = await setup.configureCli();
    assert.equal(result.model.replace(/\[1m\]$/, ""), `claude-gateway/${expected}`);
    assert.ok(!JSON.stringify(f.read()).includes("env-only-secret"));
    assert.equal(f.read().env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
    assert.equal(f.read().env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  });
}

test("preserves the latest available model choice including extended context gateway spelling", async (t) => {
  const f = fixture(t);
  f.write({ env: { ANTHROPIC_MODEL: "claude-gateway/gpt-second" } });
  const setup = createClaudeSetup({ ...f.base, getAvailableModels: async () => ({ data: [{ id: "gpt-first" }, { id: "gpt-second" }] }) });
  assert.equal((await setup.configureCli()).model, "claude-gateway/gpt-second");
});

test("empty or failed catalogs and vanished credentials never write settings", async (t) => {
  const f = fixture(t); f.write({ untouched: true });
  for (const getAvailableModels of [async () => ({ data: [] }), async () => { throw new Error("upstream-secret"); },
    async () => { f.state.auth = {}; return { data: [{ id: "gpt-test" }] }; }]) {
    const setup = createClaudeSetup({ ...f.base, getAvailableModels });
    await assert.rejects(setup.configureCli());
    assert.deepEqual(f.read(), { untouched: true });
  }
});

test("missing CLI and authentication modes have fixed gates without deleting helpers", async (t) => {
  const f = fixture(t);
  const missing = createClaudeSetup({ ...f.base, probe: async () => ({ cli: false }) });
  assert.equal((await missing.getStatus()).claudeCli.ready, false);
  await assert.rejects(missing.configureCli(), /Install Claude/);
  for (const value of [{ apiKeyHelper: "private-command" }, { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, { forceLoginMethod: "gateway" }]) {
    f.write(value);
    assert.equal((await f.setup.getStatus()).claudeCli.ready, false);
    await assert.rejects(f.setup.configureCli(), (error) => {
      const failure = setupFailure(error);
      assert.equal(failure.status, 409);
      assert.ok(!JSON.stringify(failure).includes("private-command"));
      assert.ok(failure.body.fields.length);
      return true;
    });
    assert.deepEqual(f.read(), value);
  }
});

test("custom actual config root writes only the selected CLI root", async (t) => {
  const f = fixture(t);
  const custom = path.join(f.root, "custom cli");
  assert.equal(getClaudeConfigRoot({ CLAUDE_CONFIG_DIR: custom }, "/unused"), custom);
  assert.equal(getClaudeConfigRoot({ CLAUDE_CONFIG_DIR: " ~/custom " }, f.root), path.join(f.root, "custom"));
  const setup = createClaudeSetup({ ...f.base, configRoot: custom, env: { CLAUDE_CONFIG_DIR: custom } });
  assert.match((await setup.getStatus()).claudeCli.notice, /CLAUDE_CONFIG_DIR/);
  await setup.configureCli();
  const saved = JSON.parse(fs.readFileSync(path.join(custom, "settings.json"), "utf8"));
  assert.equal(saved.env.ANTHROPIC_BASE_URL, "http://localhost:8082");
  assert.equal(fs.existsSync(f.settingsFile), false);
});

test("probe uses bounded shell-free fixed arguments, common install locations and sanitized outputs", async () => {
  const calls = [];
  const probe = createSetupProbe({ env: { PATH: "/limited", BASH_ENV: "private-hook", NODE_OPTIONS: "private-options" }, home: "/home/test", node: "/node",
    fsImpl: { statSync: () => ({ isFile: () => true }) }, execFileImpl(file, args, options, done) {
      calls.push({ file, args, options });
      done(null, file.endsWith("claude") ? "2.1.296 (Claude Code)" : file.endsWith("bash") ? "GNU bash, version 3.2.57" : file.endsWith("jq") ? "jq-1.6" : "v22.1.0");
    } });
  const result = await probe();
  assert.equal(result.cli, true);
  assert.equal(result.node, "/node");
  assert.ok(calls.some((call) => call.file === "/home/test/.local/bin/claude"));
  for (const call of calls) {
    assert.equal(call.options.shell, false);
    assert.equal(call.options.maxBuffer, 4096);
    assert.equal(call.options.timeout, 1800);
    assert.equal(call.options.env.BASH_ENV, undefined);
    assert.equal(call.options.env.NODE_OPTIONS, undefined);
    assert.equal(call.args.at(-1), "--version");
  }
});

test("Windows probe resolves npm cli.js without invoking cmd wrappers", async () => {
  const calls = [];
  const probe = createSetupProbe({ platform: "win32", env: { PATH: "C:\\short", ProgramFiles: "C:\\Program Files" }, home: "C:\\Users\\test", node: "C:\\node.exe",
    fsImpl: { statSync(file) { return { isFile: () => !file.endsWith("claude.exe") }; } },
    execFileImpl(file, args, options, done) {
      calls.push({ file, args, options });
      done(null, args[0].endsWith("cli.js") ? "2.1.296 (Claude Code)" : file.endsWith("bash.exe") ? "GNU bash, version 5.2.0" : file.endsWith("jq.exe") ? "jq-1.7" : "v22.1.0");
    } });
  const result = await probe();
  assert.equal(result.cli, true);
  assert.ok(calls.some((call) => call.args[0].endsWith("cli.js")));
  assert.ok(calls.every((call) => !call.file.endsWith(".cmd") && call.options.shell === false));
});
