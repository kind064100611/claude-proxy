const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const http = require("http");
const { createRequire } = require("module");
const { execFile } = require("child_process");
const { promisify } = require("util");
const observations = require("../lib/observation-pack");
const responses = require("../lib/openai-responses");

// Real Claude tools, local fake model; no upstream API or credentials are used.
test("installed Claude CLI transparently reads exact archived evidence with its native Read tool", {
  skip: process.env.RUN_CLAUDE_CLI_TESTS !== "1", timeout: 60000
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "observation-cli-"));
  const file = path.join(directory, "large.txt");
  fs.writeFileSync(file, Array.from({ length: 700 }, (_, index) =>
    `ROW_${String(index).padStart(4, "0")} exact-evidence-${index} abcdefghijklmnopqrstuvwxyz`).join("\n"));
  const filename = path.resolve("mac/proxy.js");
  const nativeRequire = createRequire(filename);
  const ingress = [];
  let server;
  let calls = 0;
  let archive;
  const context = {
    require: (name) => name === "http" ? { createServer: (handler) => {
      server = http.createServer(handler);
      return server;
    } } : name === "../lib/observation-pack" ? { createObservationPack: () => {
      const pack = observations.createObservationPack({ configFile: path.join(directory, "gateway-features.json"), archiveRoot: path.join(directory, "gateway-observations") });
      return { ...pack, prepare: (body, options) => {
        const result = pack.prepare(body, options);
        ingress.push({ original: body, result });
        return result;
      } };
    } } : name === "../lib/openai-responses" ? { ...responses, requestResponses: async (body, options) => {
      if (!JSON.stringify(body.messages).includes("Read requested evidence")) {
        await options.onChunk({ choices: [{ delta: { content: "fixture-helper-ok" } }] });
        await options.onChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
        return { streamed: true };
      }
      calls++;
      let args;
      if (calls === 1) {
        args = { file_path: file, offset: 1, limit: 700 };
      } else if (calls === 2) {
        const result = body.messages.filter((message) => message.role === "tool").at(-1).content;
        assert.ok(result.includes("[Gateway archived tool output:"));
        archive = JSON.parse(result.match(/file_path=("(?:[^"\\]|\\.)*")/)[1]);
        const original = ingress.at(-1).original.messages.at(-1).content.find((block) => block.type === "tool_result").content;
        const originalText = typeof original === "string" ? original : original[0].text;
        assert.equal(fs.readFileSync(archive, "utf8"), originalText);
        const line = originalText.split("\n").findIndex((text) => text.includes("ROW_0450 exact-evidence-450"));
        assert.ok(line >= 0);
        args = { file_path: archive, offset: line + 1, limit: 2 };
      } else {
        assert.equal(calls, 3);
        const result = body.messages.filter((message) => message.role === "tool").at(-1).content;
        assert.ok(result.includes("ROW_0450 exact-evidence-450"));
        assert.ok(!result.includes("[Gateway archived tool output:"));
        await options.onChunk({ choices: [{ delta: { content: "archive-recall-ok" } }] });
      }
      if (args) await options.onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_read_${calls}`,
        function: { name: "Read", arguments: JSON.stringify(args) } }] } }] });
      await options.onChunk({ choices: [{ delta: {}, finish_reason: args ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 2048, completion_tokens: 20, cached_tokens: 1024 } });
      return { streamed: true };
    } } : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [{ id: "gpt-5.4", owned_by: "openai" }] }) } : nativeRequire(name),
    __dirname: path.dirname(filename), process, Buffer, URL,
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0], context, { filename });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(directory, "config"),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ANTHROPIC_API_KEY: "test-only", ANTHROPIC_AUTH_TOKEN: "test-only",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_MODEL;
    for (const key of Object.keys(env)) if (key.startsWith("CLAUDE_CODE_USE_")) delete env[key];
    const { stdout } = await promisify(execFile)("claude", [
      "--bare", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--tools", "Read", "--allowedTools", "Read", "--permission-mode", "default", "--system-prompt", "Read requested evidence; reply archive-recall-ok.",
      "--no-session-persistence", "--model", "claude-gateway/gpt-5.4", "--output-format", "json", "-p", "Test"
    ], { cwd: directory, env, timeout: 45000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout);
    assert.equal(result.is_error, false);
    assert.equal(result.result, "archive-recall-ok");
    assert.equal(calls, 3);
    assert.ok(archive);
    assert.ok(ingress.some((request) => request.result.stats.packed_results === 1));
  } catch (error) {
    error.message += `\nMock calls: ${calls}; ingress: ${JSON.stringify(ingress.map(({ original, result }) => ({
      stats: result.stats, session: !!original.metadata?.user_id,
      read: !!original.tools?.find((tool) => tool.name === "Read"),
      last: original.messages.at(-1)?.content?.filter?.((block) => block.type === "tool_result").map((block) => ({
        error: block.is_error, size: JSON.stringify(block.content).length, types: Array.isArray(block.content) ? block.content.map((part) => part.type) : typeof block.content
      }))
    })))}`;
    throw error;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
