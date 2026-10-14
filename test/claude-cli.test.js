const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const http = require("http");
const { createRequire } = require("module");
const { execFile } = require("child_process");
const { promisify } = require("util");
const responses = require("../lib/openai-responses");

// Opt in when Claude Code is installed. No real upstream requests or auth files.
test("installed Claude CLI sends selected GPT and gateway serves discovery URL", {
  skip: process.env.RUN_CLAUDE_CLI_TESTS !== "1", timeout: 45000
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-cli-test-"));
  const filename = path.resolve("mac/proxy.js");
  const nativeRequire = createRequire(filename);
  const observed = [];
  let server;
  const context = {
    require: (name) => name === "http" ? { createServer: (handler) => {
      server = http.createServer((request, response) => { observed.push(request.url); handler(request, response); });
      return server;
    } } : name === "../lib/openai-responses" ? { ...responses, requestResponses: async (body, options) => {
      observed.push(body.model);
      assert.equal(body.model, "gpt-5.4");
      await options.onChunk({ choices: [{ delta: { content: "gateway-smoke-ok" } }] });
      await options.onChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2, cached_tokens: 10 } });
      return { streamed: true };
    } } : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [{ id: "gpt-5.4", owned_by: "openai" }] }) } : nativeRequire(name),
    __dirname: path.dirname(filename), process, Buffer, URL,
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0], context, { filename });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: directory,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ANTHROPIC_API_KEY: "test-only", ANTHROPIC_AUTH_TOKEN: "test-only",
      ANTHROPIC_MODEL: "gpt-4.1",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1"
    };
    delete env.CLAUDECODE;
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDE_CODE_USE_")) delete env[key];
    }
    const { stdout } = await promisify(execFile)("claude", [
      "--bare", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--tools", "", "--system-prompt", "Reply only gateway-smoke-ok", "--no-session-persistence",
      "--model", "claude-gateway/gpt-5.4", "--output-format", "json", "-p", "Test"
    ], { cwd: directory, env, timeout: 35000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout);
    assert.equal(result.is_error, false);
    assert.equal(result.result, "gateway-smoke-ok");
    assert.ok(observed.includes("gpt-5.4"));
    // Print mode may defer interactive picker discovery. Exercise its exact URL.
    const models = await (await fetch(`${env.ANTHROPIC_BASE_URL}/v1/models?limit=1000`)).json();
    assert.ok(models.data.some((entry) => entry.id === "claude-gateway/gpt-5.4"));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
