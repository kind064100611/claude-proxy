const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");
const { createRequire } = require("module");
const { createCredentialStore } = require("../lib/credential-store");

for (const platform of ["mac", "windows"]) {
  test(`${platform} isolated HTTP gateway covers both providers, protected setup and read-only startup`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-e2e-"));
    const store = createCredentialStore({ directory: path.join(root, "store") });
    const configRoot = path.join(root, "config");
    fs.mkdirSync(configRoot);
    const settingsFile = path.join(configRoot, "settings.json");
    const original = Buffer.from('﻿{"env":{"KEEP":"yes"},"statusLine":{"type":"command","command":"existing"}}\n');
    fs.writeFileSync(settingsFile, original);
    const filename = path.resolve(platform, "proxy.js");
    const nativeRequire = createRequire(filename);
    const reserve = http.createServer();
    await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    let server;
    let router;
    const serviceCalls = [];
    const memoryCalls = [];
    const upstream = [];
    const usage = { input_tokens: 100, output_tokens: 3, input_tokens_details: { cached_tokens: 64 } };
    const openaiFetch = async (url, options) => {
      const payload = JSON.parse(options.body);
      upstream.push({ url, payload });
      const native = { id: "resp_mock", status: "completed", output: [
        { type: "message", content: [{ type: "output_text", text: "mock reply" }] }
      ], usage };
      if (!payload.stream) return new Response(JSON.stringify(native));
      const events = [
        { type: "response.output_text.delta", delta: "mock reply" },
        { type: "response.completed", response: native }
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "Content-Type": "text/event-stream" } });
    };
    const copilotFetch = async (url, options) => {
      const payload = JSON.parse(options.body);
      upstream.push({ url, payload });
      const native = { id: "msg_mock", type: "message", model: payload.model, content: [{ type: "text", text: "native reply" }],
        usage: { input_tokens: 36, output_tokens: 3, cache_read_input_tokens: 64, cache_creation_input_tokens: 0 } };
      const body = payload.stream ? `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: native })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n` : JSON.stringify(native);
      return new Response(body, { headers: { "Content-Type": payload.stream ? "text/event-stream" : "application/json" } });
    };
    const responses = nativeRequire("../lib/openai-responses");
    const copilot = nativeRequire("../lib/github-copilot");
    const setup = nativeRequire("../lib/claude-setup");
    const auth = nativeRequire("../lib/auth-server");
    const observations = nativeRequire("../lib/online-summary");
    const context = {
      require: (name) => {
        if (name === "http") return { createServer: (handler) => { server = http.createServer(handler); return server; } };
        if (name === "../lib/macos-service") return { createMacosService: (options) => {
          serviceCalls.push(options);
          return { getStatus: async () => ({ supported: platform === "mac", ready: true, instance: { pid: 42, installationId: "invalid-private-id" } }),
            configure: async () => ({ status: 200, body: { state: "already_registered" } }) };
        } };
        if (name === "../lib/project-memory-install") return { createProjectMemoryInstaller: (options) => {
          assert.equal(options.configRoot, configRoot);
          memoryCalls.push("factory");
          return { getStatus: async () => ({ installed: false, ready: true, state: "absent" }),
            install: async () => { memoryCalls.push("install"); return { ok: true, changed: true, installed: true, ready: true, state: "installed" }; } };
        } };
        if (name === "../lib/credential-store") return { defaultStore: store };
        if (name === "../lib/model-discovery") return { createModelDiscovery: () => Object.assign(async () => ({ object: "list", data: [
          { id: "gpt-test" }, { id: "claude-sonnet-test" }
        ] }), { invalidate() {} }) };
        if (name === "../lib/auth-server") return { createAuthRouter: (options) => { router = auth.createAuthRouter(options); return router; } };
        if (name === "../lib/claude-setup") return { ...setup, getClaudeConfigRoot: () => configRoot,
          createClaudeSetup: (options) => setup.createClaudeSetup({ ...options, env: {}, configRoot, probe: async () => ({ cli: true, bash: "/bin/bash", jq: "test-jq", node: process.execPath }) }) };
        if (name === "../lib/online-summary") return { ...observations,
          createOnlineSummary: (options) => observations.createOnlineSummary({
            ...options, configFile: path.join(root, "features.json"), archiveRoot: path.join(root, "observations") }),
          createSummarySettings: (options) => observations.createSummarySettings({ ...options, configFile: path.join(root, "features.json") }) };
        if (name === "../lib/openai-responses") return { ...responses, requestResponses: (body, options) => responses.requestResponses(body, {
          ...options, fetchImpl: openaiFetch, loadAuth: async () => ({ kind: "api", token: "mock-only" }) }) };
        if (name === "../lib/github-copilot") return { ...copilot, forwardClaudeRequest: (body, req, res, options) => copilot.forwardClaudeRequest(body, req, res, {
          ...options, fetchImpl: copilotFetch, loadAuth: async () => ({ token: "mock-only", baseUrl: "https://mock.example" }) }) };
        return nativeRequire(name);
      },
      __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
      console: { log() {}, warn() {}, error() {} }
    };
    const source = fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0].replace("const PORT = 8082;", `const PORT = ${port};`);
    vm.runInNewContext(source + "\nsyncClaudeSettings();", context, { filename });
    assert.deepEqual(memoryCalls, ["factory"]);
    assert.equal(serviceCalls.length, 1);
    assert.equal(serviceCalls[0].proxyPath, filename);
    assert.equal(serviceCalls[0].port, port);
    assert.equal(typeof serviceCalls[0].onHandoff, "function");
    assert.deepEqual(fs.readFileSync(settingsFile), original);
    assert.equal(fs.existsSync(path.join(configRoot, "claude-proxy")), false);
    assert.equal(fs.existsSync(store.directory), false);
    assert.equal(fs.existsSync(path.join(root, "features.json")), false);
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    t.after(async () => { router.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await (await fetch(base + "/health")).json()).status, "ok");
    assert.equal((await fetch(base + "/features")).status, 200);
    const page = await fetch(base + "/login");
    const nonce = (await page.text()).match(/nonce="([a-zA-Z0-9_-]+)"/)[1];
    const headers = { "X-Auth-Nonce": nonce, Origin: base, "Content-Type": "application/json" };
    assert.equal((await fetch(base + "/api/auth/status", { headers })).status, 200);
    assert.deepEqual(fs.readFileSync(settingsFile), original);
    assert.deepEqual(memoryCalls, ["factory"]);
    assert.equal(fs.existsSync(path.join(configRoot, "skills")), false);
    const memory = await fetch(base + "/api/auth/project-memory/install", { method: "POST", headers, body: "{}" });
    assert.equal(memory.status, 200);
    assert.equal((await memory.json()).installed, true);
    assert.equal(memory.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(memoryCalls, ["factory", "install"]);
    const models = await (await fetch(base + "/v1/models?limit=1000")).json();
    assert.deepEqual(models.data.map((model) => model.id), ["claude-gateway/gpt-test", "claude-gateway/claude-sonnet-test[1m]"]);
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
    for (const model of ["claude-gateway/gpt-test", "claude-gateway/claude-sonnet-test[1m]"]) {
      for (const stream of [false, true]) {
        const result = await fetch(base + "/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, stream, max_tokens: 50, system: "instructions", messages: [{ role: "user", content: [{ type: "text", text: "look" }, image] }],
            tools: [{ name: "read", input_schema: { type: "object" } }] }) });
        assert.equal(result.status, 200);
        const text = await result.text();
        assert.match(text, /cache_read_input_tokens["\s:]+64/);
        if (stream) assert.match(text, /message_stop/);
        else assert.equal(JSON.parse(text).type, "message");
      }
    }
    assert.equal(upstream.length, 4);
    assert.equal(upstream[0].payload.input[1].content[1].type, "input_image");
    assert.equal(upstream[0].payload.tools[0].type, "function");
    assert.equal(upstream[2].payload.messages[0].content[1].type, "image");
    const count = upstream.length;
    for (const model of ["unknown-model", "claude-gateway/unsupported", "gpt-oss-20b"]) {
      const result = await fetch(base + "/v1/messages", { method: "POST", body: JSON.stringify({ model, messages: [] }) });
      assert.equal(result.status, 400);
    }
    assert.equal(upstream.length, count);
    store.saveLogin("openai", { type: "api_key", key: "mock-only" });
    const configured = await fetch(base + "/api/auth/claude/configure", { method: "POST", headers, body: "{}" });
    assert.equal(configured.status, 200);
    const saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(saved.env.KEEP, "yes");
    assert.equal(saved.env.ANTHROPIC_MODEL, "claude-gateway/gpt-test");
    assert.equal(saved.statusLine.command, "existing");
    const backups = path.join(configRoot, "claude-proxy", "settings-backups");
    assert.deepEqual(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0])), original);
    const state = await (await fetch(base + "/api/auth/status", { headers })).json();
    assert.equal(state.statusline.ready, true);
    assert.equal(state.macosService.instance, undefined);
    const serviceResult = await fetch(base + "/api/auth/macos/service/configure", { method: "POST", headers, body: "{}" });
    assert.equal(serviceResult.status, 200);
    assert.equal((await serviceResult.json()).state, "already_registered");
    assert.equal(serviceResult.headers.get("access-control-allow-origin"), null);
    const statusline = await fetch(base + "/api/auth/statusline/configure", { method: "POST", headers, body: "{}" });
    assert.equal(statusline.status, 200);
    assert.equal((await statusline.json()).success, true);
    const latest = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.deepEqual(latest.env, saved.env);
    assert.notEqual(latest.statusLine.command, "existing");
  });
}
