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
const webSearch = require("../lib/web-search");

const skip = process.env.RUN_CLAUDE_CLI_TESTS !== "1";
const usage = { prompt_tokens: 20, completion_tokens: 2, cached_tokens: 10 };

// Runs the real proxy on a random loopback port and the installed CLI against it, with fake
// upstreams for the conversation and for built-in web search. No real upstream requests or auth files.
async function runCli({ requestResponses, searchResponses = async () => { throw new Error("unexpected web search"); } }, args) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-cli-test-"));
  const filename = path.resolve("mac/proxy.js");
  const nativeRequire = createRequire(filename);
  const urls = [];
  let server;
  const context = {
    require: (name) => name === "http" ? { createServer: (handler) => {
      server = http.createServer((request, response) => { urls.push(request.url); handler(request, response); });
      return server;
    } } : name === "../lib/openai-responses" ? { ...responses, requestResponses }
      : name === "../lib/web-search" ? { ...webSearch, runWebSearch: (body, search, options) => webSearch.runWebSearch(body, search, { ...options, requestResponsesImpl: searchResponses }) }
        : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [{ id: "gpt-5.4", owned_by: "openai" }] }) } : name === "../lib/macos-service" ? { createMacosService: () => ({ getStatus: async () => ({ supported: false }) }) } : name === "../lib/project-memory-install" ? { createProjectMemoryInstaller: () => ({ getStatus: async () => ({ state: "unavailable" }) }) } : nativeRequire(name),
    __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL,
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0], context, { filename });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: directory,
      ANTHROPIC_BASE_URL: baseUrl,
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
      "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence",
      "--model", "claude-gateway/gpt-5.4", "--output-format", "json", ...args
    ], { cwd: directory, env, timeout: 50000, maxBuffer: 1024 * 1024 });
    // Print mode may defer interactive picker discovery. Exercise its exact URL.
    const models = await (await fetch(`${baseUrl}/v1/models?limit=1000`)).json();
    return { result: JSON.parse(stdout), models };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Opt in when Claude Code is installed.
test("installed Claude CLI sends selected GPT and gateway serves discovery URL", { skip, timeout: 60000 }, async () => {
  const observed = [];
  const { result, models } = await runCli({ requestResponses: async (body, options) => {
    observed.push(body.model);
    assert.equal(body.model, "gpt-5.4");
    await options.onChunk({ choices: [{ delta: { content: "gateway-smoke-ok" } }] });
    await options.onChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage });
    return { streamed: true };
  } }, ["--bare", "--tools", "", "--system-prompt", "Reply only gateway-smoke-ok", "-p", "Test"]);
  assert.equal(result.is_error, false);
  assert.equal(result.result, "gateway-smoke-ok");
  assert.ok(observed.includes("gpt-5.4"));
  assert.ok(models.data.some((entry) => entry.id === "claude-gateway/gpt-5.4"));
});

// The built-in tool sends its own web_search_20250305 request (tool_choice auto on the wire); its links must reach
// the conversation. Not --bare: bare mode offers only Bash, Edit and Read.
test("installed Claude CLI gets real links from built-in WebSearch through the gateway", { skip, timeout: 60000 }, async () => {
  const conversation = [];
  const searches = [];
  const { result } = await runCli({
    requestResponses: async (body, options) => {
      conversation.push(body);
      if (conversation.length === 1) {
        assert.ok(body.tools.some((tool) => tool.function.name === "WebSearch"));
        await options.onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_search",
          function: { name: "WebSearch", arguments: JSON.stringify({ query: "gateway fixture query" }) } }] } }] });
        await options.onChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage });
      } else {
        await options.onChunk({ choices: [{ delta: { content: "search-done" } }] });
        await options.onChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage });
      }
      return { streamed: true };
    },
    searchResponses: async (body, options) => {
      const payload = { model: body.model, include: [] };
      options.adjustPayload(payload, { kind: "codex" });
      searches.push({ body, payload });
      const call = { type: "web_search_call", id: "ws_fixture", status: "completed",
        action: { type: "search", queries: ["gateway fixture query"], sources: [{ type: "url", url: "https://fixture.example/result" }] } };
      options.onEvent({ type: "response.output_item.added", output_index: 0, item: { type: "web_search_call", id: "ws_fixture", status: "in_progress" } });
      options.onEvent({ type: "response.output_item.done", output_index: 0, item: call });
      options.onEvent({ type: "response.output_item.done", output_index: 1, item: { type: "message", content: [{ type: "output_text", text: "Fixture summary.",
        annotations: [{ type: "url_citation", url: "https://fixture.example/result?utm_source=openai", title: "Fixture Result Title" }] }] } });
      options.onEvent({ type: "response.completed", response: { status: "completed", output: [] } });
      return { usage };
    }
  }, ["--tools", "WebSearch", "--allowedTools", "WebSearch", "-p", "Search the web for gateway fixture query"]);
  assert.equal(result.is_error, false);
  assert.equal(result.result, "search-done");
  assert.equal(searches.length, 1);
  assert.equal(searches[0].body.model, "gpt-5.4");
  assert.equal(searches[0].payload.tools[0].type, "web_search");
  assert.equal(searches[0].payload.tool_choice, "required");
  const output = conversation[1].messages.find((message) => message.role === "tool" && message.tool_call_id === "call_search").content;
  assert.match(output, /Fixture Result Title/);
  assert.match(output, /https:\/\/fixture\.example\/result/);
});
