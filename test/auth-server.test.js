const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAuthRouter, MAX_AUTH_BODY_BYTES } = require("../lib/auth-server");
const { createCredentialStore } = require("../lib/credential-store");
const { createModelDiscovery } = require("../lib/model-discovery");
const { createDeviceLogin } = require("../lib/device-login");
const { createClaudeSetup } = require("../lib/claude-setup");

function request(port, route, { method = "GET", headers = {}, body, hostname = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: route, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-http-"));
  const store = createCredentialStore({ directory });
  let router;
  const server = http.createServer(async (req, res) => {
    if (await router(req, res)) return;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end("model API");
  });
  await new Promise((resolve) => server.listen(0, "::", resolve));
  const port = server.address().port;
  const { setupFactory, ...routerOptions } = options;
  router = createAuthRouter({ port, store, env: { OPENAI_API_KEY: "private-env-secret" }, setup: setupFactory?.(store), ...routerOptions });
  t.after(async () => {
    router.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const page = await request(port, "/login");
  assert.equal(page.status, 200);
  const nonce = page.text.match(/nonce="([a-zA-Z0-9_-]+)"/)[1];
  const headers = { "X-Auth-Nonce": nonce, "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` };
  const api = (route, options = {}) => request(port, route, { ...options, headers: { ...headers, ...options.headers } });
  return { port, router, page, nonce, store, api };
}

test("local page and APIs have no wildcard CORS, no-cache and nonce CSP, including OPTIONS", async (t) => {
  const { port, page, nonce, api } = await fixture(t);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.ok(page.headers["content-security-policy"].includes(`script-src 'nonce-${nonce}'`));
  assert.ok(!page.text.includes("__AUTH_NONCE__"));
  assert.ok(page.text.includes('<html lang="en">'));
  for (const label of ["Local Account Settings", "Login ChatGPT", "Login Copilot", "Configure Claude CLI"]) {
    assert.ok(page.text.includes(label));
  }
  assert.doesNotMatch(page.text, /[㐀-鿿]/);
  assert.equal(page.headers["access-control-allow-origin"], undefined);
  for (const route of ["/login", "/api/auth/status", "/api/auth/copilot/start", "/api/auth/chatgpt/start", "/api/auth/unknown"]) {
    const response = await request(port, route, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    assert.equal(response.status, 405);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  }
  assert.equal((await api("/api/auth/status")).status, 200);
  assert.equal((await request(port, "/v1/models")).headers["access-control-allow-origin"], "*");
});

test("Host, loopback, nonce, Origin and JSON guards reject cross-site requests", async (t) => {
  const { port, api, router, nonce } = await fixture(t);
  for (const host of ["evil.example", `evil.example:${port}`, `localhost:${port + 1}`, "localhost", `127.0.0.2:${port}`, `localhost:${port}@evil.example`]) {
    const rejected = await request(port, "/login", { headers: { Host: host } });
    assert.equal(rejected.status, 403);
    assert.ok(!JSON.stringify(rejected).includes(nonce));
  }
  for (const origin of ["https://evil.example", "null", "", `http://localhost:${port}`, `https://127.0.0.1:${port}`]) {
    assert.equal((await api("/api/auth/chatgpt/start", { method: "POST", body: '{"keys":"no"}', headers: { Origin: origin } })).status, 403);
  }
  assert.equal((await request(port, "/api/auth/status")).status, 403);
  assert.equal((await api("/api/auth/status", { headers: { "X-Auth-Nonce": "wrong" } })).status, 403);
  assert.equal((await api("/api/auth/chatgpt/start", { method: "POST", body: "{}", headers: { "Content-Type": "text/plain" } })).status, 403);
  // Remote connection guard cannot be bypassed by a legitimate Host.
  let status;
  const responseHeaders = {};
  const res = { setHeader(name, value) { responseHeaders[name] = value; }, writeHead(code) { status = code; }, end() {} };
  await router({ url: "/login", method: "GET", headers: { host: `localhost:${port}` }, socket: { remoteAddress: "192.0.2.1" } }, res);
  assert.equal(status, 403);
  assert.ok(!JSON.stringify(responseHeaders).includes(nonce));
  assert.ok(responseHeaders["Content-Security-Policy"].includes("default-src 'none'"));
  assert.equal((await request(port, "/api/auth/chatgpt/start", { method: "POST", body: '{"keys":"not-saved"}',
    headers: { "X-Auth-Nonce": nonce, "Content-Type": "application/json" } })).status, 403);
});

test("localhost IPv4 and IPv6 page access works with explicit loopback Hosts", async (t) => {
  const { port } = await fixture(t);
  for (const hostname of ["localhost", "127.0.0.1", "::1"]) {
    assert.equal((await request(port, "/login", { hostname })).status, 200);
  }
});
test("device start and flow polling use snapshots without invalidating catalogs before success", async (t) => {
  const flows = new Map();
  const started = [];
  let invalidateCount = 0;
  const login = { start: async (provider) => {
    started.push(provider);
    const flow = { id: provider, provider, status: "pending", userCode: "USER-CODE", verificationUrl: "https://github.com/login/device" };
    flows.set(provider, flow);
    return flow;
  }, get: (id) => flows.get(id), close() {} };
  const { api } = await fixture(t, { login, onCredentialsChanged: () => invalidateCount++ });
  for (const provider of ["chatgpt", "copilot"]) {
    const startedFlow = await api(`/api/auth/${provider}/start`, { method: "POST", body: "{}" });
    assert.equal(startedFlow.status, 200);
    assert.equal(JSON.parse(startedFlow.text).provider, provider);
    assert.equal((await api(`/api/auth/flow/${provider}`)).text, startedFlow.text);
  }
  assert.deepEqual(started, ["chatgpt", "copilot"]);
  assert.equal((await api("/api/auth/flow/missing")).status, 404);
  assert.equal(invalidateCount, 0); // Starting is not a successful login.
});

test("real HTTP device completion persists login, hides secrets and invalidates a cached catalog", async (t) => {
  let service;
  let store;
  const discover = createModelDiscovery({
    loadClaudeAuth: async () => { throw new Error("no auth"); },
    loadAuth: async () => {
      if (!store.readAuth()["openai-codex"]) throw new Error("no auth");
      return { kind: "codex", token: "mock", accountId: "account" };
    },
    fetchImpl: async () => new Response(JSON.stringify({ models: [{ slug: "gpt-test", visibility: "list" }] }))
  });
  const result = await fixture(t, { login: {
    start: (provider) => service.start(provider), get: (id) => service.get(id), close: () => service?.close()
  }, onCredentialsChanged: discover.invalidate });
  store = result.store;
  const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`;
  service = createDeviceLogin({ store, onCredentialsChanged: discover.invalidate, fetchImpl: async (url) => {
    if (url.endsWith("/usercode")) return new Response(JSON.stringify({ device_auth_id: "private-device", user_code: "USER-CODE", interval: 1 }));
    if (url.endsWith("/deviceauth/token")) return new Response(JSON.stringify({ authorization_code: "private-code", code_verifier: "private-verifier" }));
    return new Response(JSON.stringify({ access_token: access, refresh_token: "private-refresh", expires_in: 3600 }));
  } });
  assert.deepEqual((await discover()).data, []);
  const start = await result.api("/api/auth/chatgpt/start", { method: "POST", body: "{}" });
  const id = JSON.parse(start.text).id;
  let flow;
  for (let attempt = 0; attempt < 20; attempt++) {
    flow = await result.api(`/api/auth/flow/${id}`);
    if (JSON.parse(flow.text).status === "complete") break;
  }
  assert.equal(JSON.parse(flow.text).status, "complete");
  assert.ok(store.readAuth()["openai-codex"].loginVersion);
  assert.equal((await discover()).data[0].id, "gpt-test");
  for (const secret of [access, "private-device", "private-code", "private-verifier", "private-refresh"]) {
    assert.ok(!start.text.includes(secret));
    assert.ok(!flow.text.includes(secret));
    assert.ok(!(await result.api("/api/auth/status")).text.includes(secret));
  }
});

test("setup endpoints share loopback/Host/nonce/Origin/JSON/OPTIONS and bounded empty-object guards", async (t) => {
  let writes = 0;
  const { api, port, router, nonce } = await fixture(t, { setup: {
    getStatus: async () => ({ claudeCli: { ready: true } }),
    configureCli: async () => { writes++; return { success: true }; }
  } });
  const routes = ["/api/auth/claude/configure"];
  for (const [index, route] of routes.entries()) {
    for (const headers of [{ "X-Auth-Nonce": "wrong" }, { Host: `evil.example:${port}` }, { Origin: "https://evil.example" }, { "Content-Type": "text/plain" }]) {
      assert.equal((await api(route, { method: "POST", body: "{}", headers })).status, 403);
    }
    assert.equal((await request(port, route, { method: "POST", body: "{}" })).status, 403);
    assert.equal((await api(route, { method: "OPTIONS" })).status, 405);
    for (const body of ["[]", "null", "invalid", '{"path":"private-path"}', '{"__proto__":{}}']) {
      const result = await api(route, { method: "POST", body });
      assert.equal(result.status, 400);
      assert.ok(!result.text.includes("private-path"));
    }
    assert.equal((await api(route, { method: "POST", body: "x".repeat(MAX_AUTH_BODY_BYTES + 1) })).status, 413);
    let remoteCode;
    await router({ url: route, method: "POST", headers: { host: `localhost:${port}`, "x-auth-nonce": nonce }, socket: { remoteAddress: "192.0.2.1" } }, {
      setHeader() {}, writeHead(code) { remoteCode = code; }, end() {}
    });
    assert.equal(remoteCode, 403);
    assert.equal(writes, index);
    const result = await api(route, { method: "POST", body: "{}" });
    assert.equal(result.status, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers["access-control-allow-origin"], undefined);
  }
  assert.equal(writes, 1);
});

test("HTTP setup rejects absent credentials, returns safe status and concurrently preserves both updates", async (t) => {
  let configRoot;
  let catalogs = 0;
  const { api, store } = await fixture(t, { env: {}, setupFactory: (store) => {
    configRoot = path.join(store.directory, "cli");
    return createClaudeSetup({ configRoot, store, env: {}, probe: async () => ({ cli: true }),
      getAvailableModels: async () => { catalogs++; return { data: [{ id: "gpt-test" }] }; } });
  } });
  const status = await api("/api/auth/status");
  assert.equal(JSON.parse(status.text).claudeCli.ready, false);
  assert.equal(catalogs, 0);
  assert.equal((await api("/api/auth/claude/configure", { method: "POST", body: "{}" })).status, 400);
  assert.equal(fs.existsSync(configRoot), false);
  store.saveLogin("openai", { type: "api_key", key: "private-upstream-key" });
  assert.equal(JSON.parse((await api("/api/auth/status")).text).claudeCli.ready, true);
  const results = await Promise.all(["claude", "claude"].map((name) => api(`/api/auth/${name}/configure`, { method: "POST", body: "{}" })));
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.text).success, true);
    assert.ok(!result.text.includes("private-upstream-key"));
    assert.ok(!result.text.includes("sk-placeholder"));
  }
  const saved = JSON.parse(fs.readFileSync(path.join(configRoot, "settings.json"), "utf8"));
  assert.equal(saved.env.ANTHROPIC_MODEL, "claude-gateway/gpt-test");
});

test("setup errors hide raw command output, settings values and invalid conflict fields", async (t) => {
  const { api } = await fixture(t, { setup: { configureCli() { throw Object.assign(new Error("private-command-output"), {
    setupCode: "conflict", fields: ["apiKeyHelper", "private-helper-value"]
  }); } } });
  const cli = await api("/api/auth/claude/configure", { method: "POST", body: "{}" });
  assert.equal(cli.status, 409);
  assert.deepEqual(JSON.parse(cli.text).fields, ["apiKeyHelper"]);
  assert.ok(!cli.text.includes("private-"));
});

test("bounded bodies, malformed JSON and corrupt stores produce fixed safe errors", async (t) => {
  const { api, store } = await fixture(t);
  for (const body of ["private-invalid-json", "null", "[]"]) {
    const result = await api("/api/auth/chatgpt/start", { method: "POST", body });
    assert.equal(result.status, 400);
    assert.ok(!result.text.includes(body));
  }
  assert.equal((await api("/api/auth/chatgpt/start", { method: "POST", body: "x".repeat(MAX_AUTH_BODY_BYTES + 1) })).status, 413);
  fs.writeFileSync(store.authFile, "private-store-contents");
  const result = await api("/api/auth/status");
  assert.equal(result.status, 503);
  assert.ok(!result.text.includes("private-store-contents"));
});
