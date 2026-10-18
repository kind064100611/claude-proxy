const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { buildLaunch, main } = require("../lib/claude-launch");
const { createSetupProbe } = require("../lib/claude-probes");

const catalog = { data: [
  { id: "anthropic/gpt-6.1-sol", context_window: 872000 },
  { id: "anthropic/gpt-small", context_window: 400000 },
  { id: "claude-opus-4.8", context_window: 1000000 },
  { id: "claude-haiku-4.5", context_window: 200000 }
] };

test("a stale gateway GPT ID launches under its raw ID without injecting settings", () => {
  const launch = buildLaunch(catalog, ["-p", "hi"], { ANTHROPIC_MODEL: "claude-gateway/gpt-6.1-sol[1m]" });
  assert.deepEqual(launch.args, ["-p", "hi", "--model", "gpt-6.1-sol"]);
  assert.equal(launch.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "872000");
  assert.match(launch.warnings[0], /\/model does not update/);
});

test("--model wins over the environment, and a Claude start keeps a window for later raw GPT switches", () => {
  for (const args of [["--model", "claude-opus-4.8"], ["--model=claude-opus-4.8[1m]"]]) {
    const launch = buildLaunch(catalog, args, { ANTHROPIC_MODEL: "gpt-small" });
    assert.deepEqual(launch.args, ["--model", "claude-opus-4.8[1m]"]);
    assert.equal(launch.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "400000");
  }
  assert.equal(buildLaunch(catalog, [], { ANTHROPIC_MODEL: "gpt-small" }).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "400000");
});

test("unknown models, caller limits and the prompt after -- remain untouched", () => {
  const args = ["--model", "opus", "--", "--settings", "prompt", "--model=gpt-small"];
  const launch = buildLaunch({ data: [{ id: "anthropic/gpt-new" }] }, args, { KEEP: "1" });
  assert.deepEqual(launch.args, args);
  assert.deepEqual(launch.env, { KEEP: "1" });
  const selected = buildLaunch(catalog, ["--", "prompt"], { ANTHROPIC_MODEL: "gpt-small", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "300000" });
  assert.deepEqual(selected.args, ["--model", "gpt-small", "--", "prompt"]);
  assert.equal(selected.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "300000");
});

test("all non-model flags pass through without parsing, reading or injecting settings", async () => {
  const args = ["--settings", "file that does not exist.json", "--setting-sources=project", "--bare", "-p", "hello"];
  const env = { ANTHROPIC_BASE_URL: "http://environment", KEEP: "yes" };
  const unknownCatalog = { data: [{ id: "gpt-unknown" }] };
  assert.deepEqual(buildLaunch(unknownCatalog, args, env).args, args);
  assert.equal(await main({ args, env,
    fetchImpl: async (url) => {
      assert.equal(url, "http://environment/v1/models");
      return { ok: true, json: async () => unknownCatalog };
    },
    probe: async () => ({ claudeCommand: { file: "cli", args: [] } }),
    spawnImpl: (file, actual, options) => {
      assert.equal(file, "cli");
      assert.deepEqual(actual, args);
      assert.deepEqual(options.env, env);
      assert.equal(options.shell, false);
      const child = new EventEmitter();
      process.nextTick(() => child.emit("exit", 3));
      return child;
    } }), 3);
});

test("catalog failures preserve original arguments and spawn errors are reported", async () => {
  const args = ["--model", "gpt-small", "-p", "hello"];
  assert.equal(await main({ args, env: {}, fetchImpl: async () => { throw new Error("offline"); },
    probe: async () => ({ claudeCommand: { file: "node.exe", args: ["C:/npm with spaces/cli.js"] } }),
    spawnImpl: (file, actual) => {
      assert.equal(file, "node.exe");
      assert.deepEqual(actual, ["C:/npm with spaces/cli.js", ...args]);
      const child = new EventEmitter();
      process.nextTick(() => child.emit("error", new Error("ENOENT")));
      return child;
    } }), 1);
});

test("native and npm probes return shell-free launch commands", async () => {
  for (const native of [true, false]) {
    const cli = path.win32.join("C:/npm", "node_modules/@anthropic-ai/claude-code/cli.js");
    const executable = path.win32.join("C:/npm", "claude.exe");
    const probe = createSetupProbe({ platform: "win32", home: "C:/home", node: "C:/node/node.exe",
      env: native ? { Path: "C:/npm" } : { PATH: "C:/npm" }, includeClaudeCommand: true,
      fsImpl: { statSync: (file) => ({ isFile: () => native ? file === executable : file === cli }) },
      execFileImpl: (file, args, options, callback) => {
        assert.equal(options.shell, false);
        assert.equal(file.endsWith(".cmd"), false);
        callback(null, file.endsWith("node.exe") && args[0] === "--version" ? "v26.7.0" : "2.1.302 (Claude Code)");
      } });
    assert.deepEqual((await probe()).claudeCommand, native ? { file: executable, args: [] } : { file: "C:/node/node.exe", args: [cli] });
  }
});

test("unknown or invalid selected GPT capacity never borrows another model's limit", () => {
  for (const capacity of [undefined, null, 0, -1, 1.5, "400000", Number.MAX_SAFE_INTEGER + 1]) {
    const models = { data: [{ id: "gpt-small", context_window: capacity }, { id: "gpt-large", context_window: 1000000 }] };
    for (const [args, env] of [[["--model", "gpt-small"], {}], [[], { ANTHROPIC_MODEL: "gpt-small" }]]) {
      const launch = buildLaunch(models, args, env);
      assert.equal(launch.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
    }
    assert.equal(buildLaunch(models, ["--model", "gpt-not-listed"], {}).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
    assert.equal(buildLaunch(models, ["--model", "gpt-small"], { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "300000" })
      .env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "300000");
  }
});

test("model-looking values of other options are never rewritten as model flags", () => {
  for (const option of ["--system-prompt", "--append-system-prompt", "--settings", "--agent", "--debug-file", "--tools", "--mcp-config", "-n"]) {
    for (const value of ["--model=gpt-small", "--model"]) {
      const args = [option, value, "-p", "hello"];
      const launch = buildLaunch(catalog, args, {});
      assert.deepEqual(launch.args, args);
      const explicit = [...args, "--model", "anthropic/gpt-6.1-sol[1m]"];
      const selected = buildLaunch(catalog, explicit, {});
      assert.deepEqual(selected.args, [...args, "--model", "gpt-6.1-sol"]);
      assert.equal(selected.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "872000");
    }
  }
  const optional = buildLaunch(catalog, ["--debug", "--model=gpt-small"], {});
  assert.deepEqual(optional.args, ["--debug", "--model", "gpt-small"]);
  const repeated = buildLaunch(catalog, ["--model=gpt-small", "--system-prompt", "--model=gpt-small", "--model=gpt-6.1-sol"], {});
  assert.deepEqual(repeated.args, ["--model=gpt-small", "--system-prompt", "--model=gpt-small", "--model", "gpt-6.1-sol"]);
});
